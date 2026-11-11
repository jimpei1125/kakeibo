/**
 * 家族カードの買い物モジュール
 *
 * 家族カードで払った「共有の買い物」を、その場で記録しておく。
 * カード明細を取り込むときに、この記録と家族カードの行を照らし合わせ、
 * 記録のない行を個人の利用として分けるための材料になる（照らし合わせは明細の取込側で行う）。
 *
 * - 記録は家計簿の合計にはまだ入れない。カード払いは明細の取込で入るため、
 *   ここで入れると二重になる
 * - 保存先は budgetData/familyCardPurchases の items（記録ID → 記録）。
 *   1件ずつ merge で書くので、夫婦が別々の端末から同時に記録しても互いの分を消さない
 */

import { db, doc, setDoc, onSnapshot, deleteField } from './firebase-config.js';
import { Utils } from './utils.js';
import { Icons } from './icons.js';
import { Dialog } from './dialog.js';

/** カテゴリー選択肢の「新しいカテゴリー」 */
const NEW_CATEGORY = '__new__';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 実在する日付（YYYY-MM-DD）か
 * @param {string} date
 * @returns {boolean}
 */
export function isValidDate(date) {
    const m = DATE_PATTERN.exec(date || '');
    if (!m) return false;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * 入力から記録を作る。
 * 項目は空でも必ず持たせる（mergeで上書きするとき、消した項目に前の値が残らないようにするため）。
 * @param {{date: string, store?: string, amount: string|number, category?: string, memo?: string, source?: 'receipt'|'manual'}} input
 * @returns {{purchase?: {date: string, store: string, amount: number, category: string, memo: string, source: string}, error?: string}}
 */
export function buildPurchase({ date, store, amount, category, memo, source }) {
    if (!isValidDate(date)) return { error: '日付を入力してください' };
    const value = Number(amount);
    if (amount === '' || amount == null || !Number.isFinite(value) || value <= 0) {
        return { error: '金額を入力してください' };
    }
    return {
        purchase: {
            date,
            store: String(store || '').trim(),
            amount: Math.round(value),
            category: String(category || '').trim(),
            memo: String(memo || '').trim(),
            source: source === 'receipt' ? 'receipt' : 'manual',
        },
    };
}

/**
 * 記録を新しい順（利用日 → 記録した時刻）に並べる
 * @param {Object<string, Object>} items - 記録ID → 記録
 * @returns {Array<Object>}
 */
export function sortPurchases(items) {
    return Object.values(items || {})
        .filter(p => p && typeof p === 'object' && p.id)
        .sort((a, b) => (b.date || '').localeCompare(a.date || '')
            || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

/**
 * 合計金額
 * @param {Array<{amount?: number}>} list
 * @returns {number}
 */
export function purchasesTotal(list) {
    return list.reduce((sum, p) => sum + (p.amount || 0), 0);
}

/**
 * 一覧に出す短い日付（例: 11/8）
 * @param {string} date - YYYY-MM-DD
 * @returns {string}
 */
export function formatShortDate(date) {
    const m = DATE_PATTERN.exec(date || '');
    return m ? `${Number(m[2])}/${Number(m[3])}` : '-';
}

/** 端末をまたいでも重ならない記録ID */
function newId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 家族カードの買い物の記録と画面
 */
export class FamilyCardManager {
    /**
     * @param {import('./budget.js').BudgetManager} budget
     */
    constructor(budget) {
        this.budget = budget;
        /** @type {Object<string, Object>} 記録ID → 記録 */
        this.items = {};
        /** @type {string|null} フォームで直している記録のID */
        this.editingId = null;
        /** @type {import('./receipt.js').ReceiptReader|null} レシート読み取り（app.jsから注入） */
        this.receipt = null;
    }

    /** 記録をFirestoreから購読開始 */
    init() {
        onSnapshot(
            this._ref(),
            (snap) => this._handleSnapshot(snap),
            (error) => console.error('家族カードの記録の読み込みエラー:', error)
        );
    }

    /**
     * 記録の受信（自分の端末の書き込みも、家族の端末の書き込みもここに届く）
     * @private
     * @param {Object} snap - DocumentSnapshot
     */
    _handleSnapshot(snap) {
        this.items = (snap.exists() ? snap.data().items : null) || {};
        this._render();
    }

    /** シートを開く */
    open() {
        this._resetForm();
        this._render();
        Utils.showModal('familyCardSheet');
    }

    /** シートを閉じる */
    close() {
        Utils.closeModal('familyCardSheet');
    }

    /** レシートを撮って記録する（レシート読み取りを、記録先を家族カードにして開く） */
    openReceipt() {
        this.close();
        this.receipt?.open({ target: 'family' });
    }

    /** @returns {Array<Object>} 新しい順の記録 */
    list() {
        return sortPurchases(this.items);
    }

    /**
     * 記録を追加する（レシート読み取りからも呼ばれる）
     * @param {Object} input - buildPurchase の入力
     * @returns {{purchase?: Object, error?: string, saved?: Promise<void>}}
     */
    add(input) {
        const { purchase, error } = buildPurchase(input);
        if (error) return { error };
        const record = { ...purchase, id: newId(), createdAt: new Date().toISOString() };
        return { purchase: record, saved: this._write(record) };
    }

    /**
     * 記録を直す
     * @param {string} id
     * @param {Object} input - buildPurchase の入力
     * @returns {{purchase?: Object, error?: string, saved?: Promise<void>}}
     */
    update(id, input) {
        const current = this.items[id];
        if (!current) return { error: 'この記録はすでに削除されています' };
        const { purchase, error } = buildPurchase({ ...input, source: current.source });
        if (error) return { error };
        const record = { ...purchase, id, createdAt: current.createdAt || new Date().toISOString() };
        return { purchase: record, saved: this._write(record) };
    }

    /** フォームの内容で記録する（直している途中なら更新する） */
    submitForm() {
        const value = (id) => document.getElementById(id)?.value ?? '';
        let category = value('familyCardCategory');
        if (category === NEW_CATEGORY) category = value('familyCardNewCategory');

        const input = {
            date: value('familyCardDate'),
            store: value('familyCardStore'),
            amount: value('familyCardAmount'),
            category,
            memo: value('familyCardMemo'),
        };
        const editing = this.editingId;
        const { purchase, error } = editing ? this.update(editing, input) : this.add(input);
        if (error) {
            Utils.showToast(error, 'error');
            return;
        }
        Utils.showToast(editing
            ? '記録を直しました'
            : `${purchase.store || '家族カードの買い物'} ${Utils.formatCurrency(purchase.amount)}円を記録しました`);
        this._resetForm();
    }

    /**
     * 記録をフォームに読み込んで直せるようにする
     * @param {string} id
     */
    edit(id) {
        const p = this.items[id];
        if (!p) return;
        this.editingId = id;
        const setValue = (elId, v) => { const el = document.getElementById(elId); if (el) el.value = v ?? ''; };
        setValue('familyCardDate', p.date);
        setValue('familyCardStore', p.store);
        setValue('familyCardAmount', p.amount);
        setValue('familyCardMemo', p.memo);
        this._renderCategoryOptions(p.category);
        this._renderFormMode();
        this._renderList();
        document.getElementById('familyCardSheet')?.scrollTo?.({ top: 0, behavior: 'smooth' });
    }

    /** 直すのをやめて、新しい記録の入力に戻す */
    cancelEdit() {
        this._resetForm();
        this._renderList();
    }

    /**
     * 記録を削除する
     * @param {string} id
     */
    async remove(id) {
        const p = this.items[id];
        if (!p) return;
        const label = `${formatShortDate(p.date)} ${p.store || '店名なし'} ${Utils.formatCurrency(p.amount)}円`;
        const ok = await Dialog.confirm(`「${label}」の記録を削除しますか？`, { okLabel: '削除', danger: true });
        if (!ok) return;

        if (this.editingId === id) this._resetForm();
        delete this.items[id];
        this._render();
        this._save({ items: { [id]: deleteField() } });
    }

    /** カテゴリー選択の変更（「新しいカテゴリー」なら名前の入力欄を出す） */
    onCategoryChange() {
        const isNew = document.getElementById('familyCardCategory')?.value === NEW_CATEGORY;
        Utils.setVisible('familyCardNewCategory', isNew);
        if (isNew) document.getElementById('familyCardNewCategory')?.focus();
    }

    // ----------------------------------------
    // 内部処理
    // ----------------------------------------

    _ref() {
        return doc(db, 'budgetData', 'familyCardPurchases');
    }

    /**
     * 記録1件を書き込む。画面には先に反映し、保存の失敗だけ知らせる
     * （圏外でも端末内に保持され、接続時に送られる）
     * @param {Object} record
     * @returns {Promise<void>}
     */
    _write(record) {
        this.items[record.id] = record;
        this._render();
        return this._save({ items: { [record.id]: record } });
    }

    /** @param {Object} data - merge で書き込む内容 */
    _save(data) {
        return setDoc(this._ref(), data, { merge: true }).catch((error) => {
            console.error('家族カードの記録の保存エラー:', error);
            Utils.showToast(`記録を保存できませんでした: ${error.message}`, 'error');
        });
    }

    /** フォームを新しい記録の入力に戻す（日付は今日） */
    _resetForm() {
        this.editingId = null;
        Utils.clearInputs(['familyCardStore', 'familyCardAmount', 'familyCardMemo', 'familyCardNewCategory']);
        const dateEl = document.getElementById('familyCardDate');
        if (dateEl) dateEl.value = Utils.formatDateString(Utils.getJSTDate());
        this._renderCategoryOptions('');
        this._renderFormMode();
    }

    /** 一覧・件数の表示を更新 */
    _render() {
        this._renderList();
        this._renderCount();
    }

    /** 送信ボタンと「やめる」を、新規か修正かに合わせる */
    _renderFormMode() {
        const submit = document.getElementById('familyCardSubmit');
        if (submit) submit.textContent = this.editingId ? '直した内容で保存' : '記録する';
        Utils.setVisible('familyCardCancelEdit', !!this.editingId);
    }

    /**
     * カテゴリーの選択肢を作る（表示中の月のカテゴリーと、記録で使ったカテゴリー）
     * @param {string} selected - 選んだ状態にするカテゴリー名
     */
    _renderCategoryOptions(selected) {
        const select = document.getElementById('familyCardCategory');
        if (!select) return;

        const names = this._categoryNames();
        if (selected && !names.includes(selected)) names.push(selected);
        select.innerHTML = [
            `<option value="">あとで決める</option>`,
            ...names.map(n => `<option value="${Utils.escapeHtml(n)}">${Utils.escapeHtml(n)}</option>`),
            `<option value="${NEW_CATEGORY}">＋ 新しいカテゴリー</option>`,
        ].join('');
        select.value = selected || '';
        Utils.setVisible('familyCardNewCategory', false);
    }

    /** @returns {string[]} 表示中の月のカテゴリー名に、記録で使ったカテゴリー名を足したもの */
    _categoryNames() {
        const names = this.budget.getCurrentMonthData().categories.map(c => c.name);
        this.list().forEach(p => {
            if (p.category && !names.includes(p.category)) names.push(p.category);
        });
        return names;
    }

    /** 「その他の機能」の件数表示 */
    _renderCount() {
        const el = document.getElementById('familyCardCount');
        if (!el) return;
        const count = this.list().length;
        el.textContent = count > 0 ? `${count}件` : '';
    }

    /** 照合待ちの一覧 */
    _renderList() {
        const listEl = document.getElementById('familyCardList');
        if (!listEl) return;

        const list = this.list();
        const countEl = document.getElementById('familyCardListCount');
        const totalEl = document.getElementById('familyCardListTotal');
        if (countEl) countEl.textContent = `${list.length}件`;
        if (totalEl) totalEl.textContent = `¥${Utils.formatCurrency(purchasesTotal(list))}`;

        if (list.length === 0) {
            listEl.innerHTML = `<li class="py-6 text-center text-sm text-zinc-500">まだ記録がありません</li>`;
            return;
        }
        listEl.innerHTML = list.map(p => this._renderRow(p)).join('');
    }

    /**
     * 一覧の1行
     * @param {Object} p - 記録
     * @returns {string}
     */
    _renderRow(p) {
        const id = Utils.escapeJsArg(p.id);
        const editing = this.editingId === p.id;
        const sub = [p.category || 'カテゴリー未定', p.memo].filter(Boolean).map(Utils.escapeHtml).join('・');
        return `
            <li class="flex items-center gap-2 py-2.5">
                <button type="button" class="flex min-w-0 flex-1 items-baseline gap-3 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-white/5" onclick="app.familyCard.edit(${id})" aria-label="この記録を直す">
                    <span class="w-10 shrink-0 font-mono text-xs tabular-nums ${editing ? 'text-amber-300' : 'text-zinc-500'}">${formatShortDate(p.date)}</span>
                    <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm ${p.store ? 'text-zinc-100' : 'text-zinc-500'}">${Utils.escapeHtml(p.store || '店名なし')}</span>
                        <span class="block truncate text-xs text-zinc-500">${sub}</span>
                    </span>
                    <span class="shrink-0 font-mono text-sm tabular-nums text-zinc-100">¥${Utils.formatCurrency(p.amount)}</span>
                </button>
                <button type="button" aria-label="削除" class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-sm text-zinc-400 ring-1 ring-inset ring-white/10 transition-colors hover:bg-rose-500/10 hover:text-rose-300" onclick="app.familyCard.remove(${id})">${Icons.svg('x')}</button>
            </li>`;
    }
}
