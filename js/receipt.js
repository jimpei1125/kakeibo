/**
 * レシート読み取りモジュール
 *
 * スマホで撮ったレシートの写真を gcal-sync Worker 経由で Claude API に送り、
 * 店名・日付・合計金額・支払方法・品目を読み取って、表示中の月の家計簿に追加する。
 * - APIキーはWorkerのシークレットにだけあり、アプリ（ブラウザ）には持たせない
 * - Workerの認可はカレンダー連携と同じアプリキー（端末のlocalStorage）を使う
 * - 写真はブラウザ内で縮小してから送る（通信量と画像トークンを抑える）
 * - 読み取り結果は必ず確認画面で見直してから保存する（自動では追加しない）
 */

import { Utils } from './utils.js';
import { Dialog } from './dialog.js';
import { GCAL_WORKER_URL, APP_KEY_STORAGE_KEY } from './endpoints.js';

/** Claude（高解像度対応モデル）が縮小せずに読める上限: 長辺2576px・画像トークン4784 */
const MAX_LONG_EDGE = 2576;
const MAX_VISUAL_TOKENS = 4784;
/** 画像トークンは28×28pxのマス1つにつき1トークン */
const PATCH_SIZE = 28;
const JPEG_QUALITY = 0.85;

/** 端末ごとに前回の「支払った人」を覚えておくキー（妻のスマホなら次から妻が選ばれた状態になる） */
const LAST_PAYER_KEY = 'receipt_last_payer';
/** カテゴリー選択肢の「新しいカテゴリー」 */
const NEW_CATEGORY = '__new__';

const STEPS = ['Capture', 'Reading', 'Result', 'Error'];

export const PAYMENT_LABELS = {
    cash: '現金',
    credit_card: 'クレジットカード',
    debit_card: 'デビットカード',
    e_money: '電子マネー',
    qr: 'コード決済',
    other: 'その他',
    unknown: '不明',
};

/**
 * 画像トークン数（Claudeの計算方法: ⌈幅/28⌉ × ⌈高さ/28⌉）
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
export function visualTokens(width, height) {
    return Math.ceil(width / PATCH_SIZE) * Math.ceil(height / PATCH_SIZE);
}

/**
 * 写真を、Claudeが縮小せずに読める最大の大きさに収める寸法を返す（拡大はしない）。
 * これ以上大きく送っても読み取り精度は上がらず、通信量だけが増える。
 * @param {number} width - 元の幅(px)
 * @param {number} height - 元の高さ(px)
 * @returns {{width: number, height: number}}
 */
export function fitReceiptImageSize(width, height) {
    if (!(width > 0 && height > 0)) return { width: 0, height: 0 };
    const sized = (scale) => ({
        width: Math.max(1, Math.floor(width * scale)),
        height: Math.max(1, Math.floor(height * scale)),
    });
    let scale = Math.min(
        1,
        MAX_LONG_EDGE / Math.max(width, height),
        Math.sqrt((MAX_VISUAL_TOKENS * PATCH_SIZE * PATCH_SIZE) / (width * height)),
    );
    let size = sized(scale);
    // マス目の切り上げで上限をわずかに超えることがあるので、収まるまで少しずつ縮める
    while (visualTokens(size.width, size.height) > MAX_VISUAL_TOKENS) {
        scale *= 0.99;
        size = sized(scale);
    }
    return size;
}

/**
 * Claudeが選んだカテゴリー名を、表示中の月のカテゴリーに対応づける（表記ゆれは吸収）
 * @param {string|null} suggested
 * @param {string[]} names
 * @returns {string|null}
 */
export function matchCategory(suggested, names) {
    if (!suggested) return null;
    const norm = (s) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    const target = norm(suggested);
    return names.find(n => n === suggested) || names.find(n => norm(n) === target) || null;
}

/**
 * 明細のメモ欄に入れる日付（明細読み込みと同じ YYYY/MM/DD 形式）
 * @param {string|null} date - YYYY-MM-DD
 * @returns {string}
 */
export function dateToNote(date) {
    return /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date.replace(/-/g, '/') : '';
}

/**
 * 確認画面の入力から、家計簿に追加する明細（小カテゴリー）を作る
 * @param {{store: string, amount: string|number, payer: 'husband'|'wife', memo: string}} input
 * @returns {{detail?: Object, error?: string}}
 */
export function buildReceiptDetail({ store, amount, payer, memo }) {
    const value = Number(amount);
    if (amount === '' || !Number.isFinite(value) || value <= 0) {
        return { error: '金額を入力してください' };
    }
    return {
        detail: {
            name: String(store || '').trim() || 'レシート',
            amount: Math.round(value),
            note: String(memo || '').trim(),
            ...(payer === 'wife' ? { payer: 'wife' } : {}),
        },
    };
}

/**
 * 写真を縮小してJPEGのbase64にする（向きはブラウザがEXIFに従って補正する）
 * @param {File} file
 * @returns {Promise<{base64: string, mediaType: string}>}
 */
async function prepareReceiptImage(file) {
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('写真を開けませんでした。別の写真でお試しください'));
            el.src = url;
        });
        const { width, height } = fitReceiptImageSize(img.naturalWidth, img.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/jpeg' };
    } finally {
        URL.revokeObjectURL(url);
    }
}

/**
 * レシート読み取りの画面と処理
 */
export class ReceiptReader {
    /**
     * @param {import('./budget.js').BudgetManager} budget
     */
    constructor(budget) {
        this.budget = budget;
        /** @type {Object|null} 直近の読み取り結果 */
        this.receipt = null;
        /** @type {'husband'|'wife'} */
        this.payer = 'husband';
        this._previewUrl = null;
        /** 読み取り中に閉じた・撮り直した場合に、遅れて届いた結果を捨てるための番号 */
        this._requestId = 0;
    }

    /** シートを開く（撮影の画面から） */
    open() {
        this._reset();
        Utils.showModal('receiptSheet');
    }

    /** シートを閉じる */
    close() {
        this._requestId++;
        Utils.closeModal('receiptSheet');
        this._revokePreview();
    }

    /** 撮影の画面に戻る */
    retake() {
        this._requestId++;
        this._reset();
    }

    /**
     * 撮影・写真選択の結果を受け取り、読み取りを始める
     * @param {Event} event
     */
    async handleFile(event) {
        const input = event.target;
        const file = input.files?.[0];
        input.value = ''; // 同じ写真を選び直しても change が発火するように
        if (!file) return;
        if (file.type && !file.type.startsWith('image/')) {
            Utils.showToast('画像ファイルを選んでください', 'error');
            return;
        }

        const appKey = await this._ensureAppKey();
        if (!appKey) return;

        const requestId = ++this._requestId;
        this._setPreview(file);
        this._showStep('Reading');
        try {
            const { base64, mediaType } = await prepareReceiptImage(file);
            const receipt = await this._read(base64, mediaType, appKey);
            if (requestId !== this._requestId) return;
            if (!receipt.isReceipt) {
                throw new Error('レシートが見つかりませんでした。レシート全体が写るように撮り直してください');
            }
            this._showResult(receipt);
        } catch (err) {
            if (requestId !== this._requestId) return;
            this._showError(err.message || '読み取りに失敗しました');
        }
    }

    /** カテゴリー選択の変更（「新しいカテゴリー」なら名前の入力欄を出す） */
    onCategoryChange() {
        const isNew = document.getElementById('receiptCategory')?.value === NEW_CATEGORY;
        Utils.setVisible('receiptNewCategory', isNew);
        if (isNew) document.getElementById('receiptNewCategory')?.focus();
    }

    /** 日付を直したら、メモの日付も合わせる（自分で書いたメモは上書きしない） */
    onDateChange() {
        const memo = document.getElementById('receiptMemo');
        const date = document.getElementById('receiptDate')?.value || '';
        if (memo && (memo.value === '' || /^\d{4}\/\d{2}\/\d{2}$/.test(memo.value))) {
            memo.value = dateToNote(date);
        }
    }

    /**
     * 支払った人を切り替える
     * @param {'husband'|'wife'} payer
     */
    setPayer(payer) {
        this.payer = payer === 'wife' ? 'wife' : 'husband';
        this._renderPayer();
    }

    /** 確認画面の内容で家計簿に追加する */
    save() {
        const value = (id) => document.getElementById(id)?.value ?? '';
        let categoryName = value('receiptCategory');
        if (categoryName === NEW_CATEGORY) categoryName = value('receiptNewCategory').trim();
        if (!categoryName) {
            Utils.showToast('カテゴリーを選んでください', 'error');
            return;
        }

        const { detail, error } = buildReceiptDetail({
            store: value('receiptStore'),
            amount: value('receiptAmount'),
            payer: this.payer,
            memo: value('receiptMemo'),
        });
        if (error) {
            Utils.showToast(error, 'error');
            return;
        }

        this.budget.addDetail(categoryName, detail);
        try { localStorage.setItem(LAST_PAYER_KEY, this.payer); } catch { /* 保存できなくても動作に影響なし */ }
        Utils.showToast(`${detail.name} ${Utils.formatCurrency(detail.amount)}円を「${categoryName}」に追加しました`);
        this.close();
    }

    // ----------------------------------------
    // 内部処理
    // ----------------------------------------

    /** 撮影の画面に戻し、前回の結果を消す */
    _reset() {
        this.receipt = null;
        this._revokePreview();
        const monthEl = document.getElementById('receiptTargetMonth');
        if (monthEl) monthEl.textContent = this._monthLabel();
        this._showStep('Capture');
    }

    /** @param {'Capture'|'Reading'|'Result'|'Error'} step */
    _showStep(step) {
        STEPS.forEach(s => Utils.setVisible(`receiptStep${s}`, s === step));
    }

    /**
     * Workerの認可に使うアプリキーを返す（未設定なら入力してもらう）
     * @returns {Promise<string>}
     */
    async _ensureAppKey() {
        let key = '';
        try { key = localStorage.getItem(APP_KEY_STORAGE_KEY) || ''; } catch { /* 読めなければ入力してもらう */ }
        if (key) return key;

        const input = await Dialog.prompt('レシート読み取りにはアプリキーが必要です。カレンダー連携と同じ合言葉を入力してください');
        key = (input || '').trim();
        if (!key) return '';
        try { localStorage.setItem(APP_KEY_STORAGE_KEY, key); } catch { /* 保存できなくても今回は使える */ }
        return key;
    }

    /**
     * Worker経由でClaudeに読み取ってもらう
     * @returns {Promise<Object>} 正規化済みの読み取り結果
     */
    async _read(base64, mediaType, appKey) {
        let res;
        try {
            res = await fetch(`${GCAL_WORKER_URL}/receipt`, {
                method: 'POST',
                headers: {
                    // 画像はbase64の文字列をそのまま本文に入れる（Worker側でJSONの解析を省くため）
                    'Content-Type': 'text/plain',
                    'X-App-Key': appKey,
                    'X-Image-Type': mediaType,
                    'X-Categories': encodeURIComponent(JSON.stringify(this._categoryNames())),
                },
                body: base64,
            });
        } catch {
            throw new Error('通信できませんでした。電波の良い場所でもう一度お試しください');
        }

        if (res.status === 401) {
            try { localStorage.removeItem(APP_KEY_STORAGE_KEY); } catch { /* 無視 */ }
            throw new Error('アプリキーが正しくありません。もう一度撮ると入力し直せます');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.receipt) {
            throw new Error(data.error || `読み取りに失敗しました（${res.status}）`);
        }
        return data.receipt;
    }

    /** @returns {string[]} 表示中の月のカテゴリー名 */
    _categoryNames() {
        return this.budget.getCurrentMonthData().categories.map(c => c.name);
    }

    /** @returns {string} 例: 2026年10月 */
    _monthLabel() {
        return `${this.budget.currentYear}年${this.budget.currentMonth}月`;
    }

    /** 読み取り結果を確認画面に出す */
    _showResult(receipt) {
        this.receipt = receipt;
        const setValue = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
        const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

        setValue('receiptStore', receipt.store);
        setValue('receiptDate', receipt.date);
        setValue('receiptAmount', receipt.total);
        setValue('receiptMemo', dateToNote(receipt.date));
        setText('receiptPayment', PAYMENT_LABELS[receipt.paymentMethod] || PAYMENT_LABELS.unknown);
        setText('receiptSubmit', `${this._monthLabel()}に追加`);

        // カード払いは明細の取込でも入るので、二重に入れないよう注意を出す
        Utils.setVisible('receiptCardWarning', receipt.paymentMethod === 'credit_card');

        const noteEl = document.getElementById('receiptAiNote');
        if (noteEl) {
            noteEl.textContent = receipt.note ? `読み取りメモ: ${receipt.note}` : '';
            noteEl.style.display = receipt.note ? 'block' : 'none';
        }

        // レシートの日付が表示中の月と違うときは、追加先を明示する
        const hint = document.getElementById('receiptMonthHint');
        if (hint) {
            const [y, m] = (receipt.date || '').split('-').map(Number);
            const differs = y && m && (y !== this.budget.currentYear || m !== this.budget.currentMonth);
            hint.textContent = differs
                ? `レシートの日付は${y}年${m}月です。追加先は表示中の${this._monthLabel()}です。`
                : '';
            hint.style.display = differs ? 'block' : 'none';
        }

        this._renderCategoryOptions(receipt.category);
        this._renderItems(receipt.items || []);

        let lastPayer = 'husband';
        try { lastPayer = localStorage.getItem(LAST_PAYER_KEY) || 'husband'; } catch { /* 既定は夫 */ }
        this.setPayer(lastPayer);

        this._showStep('Result');
    }

    /** カテゴリーの選択肢を作る（Claudeの提案に合うものを選んだ状態にする） */
    _renderCategoryOptions(suggested) {
        const select = document.getElementById('receiptCategory');
        const newInput = document.getElementById('receiptNewCategory');
        if (!select) return;

        const names = this._categoryNames();
        const matched = matchCategory(suggested, names);
        const options = [
            `<option value="">選んでください</option>`,
            ...names.map(n => `<option value="${Utils.escapeHtml(n)}">${Utils.escapeHtml(n)}</option>`),
            `<option value="${NEW_CATEGORY}">＋ 新しいカテゴリー</option>`,
        ];
        select.innerHTML = options.join('');

        if (matched) {
            select.value = matched;
        } else if (names.length === 0) {
            // カテゴリーがまだない月は、新しいカテゴリーの入力から始める
            select.value = NEW_CATEGORY;
        } else {
            select.value = '';
        }
        if (newInput) newInput.value = names.length === 0 && suggested ? suggested : '';
        Utils.setVisible('receiptNewCategory', select.value === NEW_CATEGORY);
    }

    /** 品目の一覧（参考表示） */
    _renderItems(items) {
        const wrap = document.getElementById('receiptItemsWrap');
        const list = document.getElementById('receiptItems');
        const summary = document.getElementById('receiptItemsSummary');
        if (!wrap || !list) return;

        if (!items.length) {
            wrap.style.display = 'none';
            return;
        }
        wrap.style.display = 'block';
        wrap.open = false;
        if (summary) summary.textContent = `品目（${items.length}件）`;
        list.innerHTML = items.map(item => `
            <li class="flex items-baseline justify-between gap-3 py-1">
                <span class="min-w-0 truncate">${Utils.escapeHtml(item.name)}</span>
                <span class="shrink-0 tabular-nums ${item.amount < 0 ? 'text-rose-300' : 'text-zinc-300'}">${item.amount == null ? '-' : `${Utils.formatCurrency(item.amount)}円`}</span>
            </li>
        `).join('');
    }

    /** 支払った人のボタンの見た目を更新 */
    _renderPayer() {
        const styles = {
            husband: 'bg-white/20 text-white ring-white/30',
            wife: 'bg-pink-500/20 text-pink-200 ring-pink-500/40',
            off: 'bg-white/5 text-zinc-400 ring-white/10',
        };
        ['husband', 'wife'].forEach(p => {
            const btn = document.getElementById(`receiptPayer-${p}`);
            if (!btn) return;
            const selected = this.payer === p;
            btn.className = `rounded-lg px-3 py-2.5 text-sm font-semibold ring-1 ring-inset transition ${selected ? styles[p] : styles.off}`;
            btn.setAttribute('aria-pressed', String(selected));
        });
    }

    /** エラーを出す */
    _showError(message) {
        const el = document.getElementById('receiptErrorText');
        if (el) el.textContent = message;
        this._showStep('Error');
    }

    /** プレビュー画像を表示 */
    _setPreview(file) {
        this._revokePreview();
        this._previewUrl = URL.createObjectURL(file);
        ['receiptPreviewReading', 'receiptPreviewResult'].forEach(id => {
            const img = document.getElementById(id);
            if (img) img.src = this._previewUrl;
        });
    }

    /** プレビュー画像のURLを解放 */
    _revokePreview() {
        if (this._previewUrl) URL.revokeObjectURL(this._previewUrl);
        this._previewUrl = null;
        ['receiptPreviewReading', 'receiptPreviewResult'].forEach(id => {
            const img = document.getElementById(id);
            if (img) img.removeAttribute('src');
        });
    }
}
