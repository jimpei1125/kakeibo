/**
 * 明細読み込みモジュール（CSV / PDF）
 * クレジットカードの利用明細を読み込み、カテゴリを割り当てて家計簿へ取り込む。
 * PDFは三井住友カード（Amazon Mastercard）形式に対応（docs/statement-import-design.md 参照）。
 */

import { db, doc, setDoc, onSnapshot } from './firebase-config.js';
import { Utils } from './utils.js';
import { Dialog } from './dialog.js';
import { Icons } from './icons.js';
import { moveDirectAmountToDetail, addWifePersonal } from './budget.js';
import { matchFamilyRows, formatShortDate } from './family-card.js';


/** カテゴリ候補のデフォルト値（既存カテゴリ・学習済みルールに追加で表示） */
const DEFAULT_CATEGORY_SUGGESTIONS = ['食費', '日用品', '外食', '光熱費', '通信費', '交際費', 'その他'];

/**
 * 康熙部首（Kangxi Radicals/CJK Radicals Supplement）の字形を通常の漢字に正規化するマップ
 * 三井住友カードの明細PDFは一部の漢字（日・月・支・金・手など）を、見た目は同じだが
 * 意味的に異なるUnicodeの部首ブロック（U+2E80-2EFF, U+2F00-2FDF）のコードポイントで
 * 埋め込んでいるため、固定文言の正規表現マッチが失敗する（例: "金"→"⾦"で「遅延損害金」の判定が外れる）。
 * NFKC等の標準正規化では復元できないため、実測で確認した対応表を明示的に用意する。
 */
const KANGXI_RADICAL_TO_KANJI = {
    '⼈': '人', // ⼈→人
    '⼊': '入', // ⼊→入
    '⼤': '大', // ⼤→大
    '⼿': '手', // ⼿→手
    '⽀': '支', // ⽀→支
    '⽇': '日', // ⽇→日
    '⽉': '月', // ⽉→月
    '⽊': '木', // ⽊→木
    '⽤': '用', // ⽤→用
    '⽬': '目', // ⽬→目
    '⽰': '示', // ⽰→示
    '⾏': '行', // ⾏→行
    '⾦': '金', // ⾦→金
    '⾮': '非', // ⾮→非
    '⻑': '長'  // ⻑→長
};

/**
 * 康熙部首の字形を通常の漢字に置換する
 * @param {string} text - 変換前の文字列
 * @returns {string} 変換後の文字列
 */
function normalizeKangxiRadicals(text) {
    return text.replace(/[⺀-⻿⼀-⿟]/g, (ch) => KANGXI_RADICAL_TO_KANJI[ch] || ch);
}

/** 明細の利用日（YYYY/M/D）。見出し行のないCSVで、明細の行を見分けるのに使う */
const ROW_DATE = /^\d{4}\/\d{1,2}\/\d{1,2}$/;

/**
 * 明細の店名を読みやすくする。
 * 全角の英数字・記号を半角にし、続く空白を1つにまとめる。
 * 「Ｕ  Ｂ  Ｅ  Ｒ」のように1文字ずつ空けた名前は、空白を詰める。
 * 長音の代わりに使われている「－」はそのまま残す（半角にすると「ス-パ-」になるため）。
 * @param {string} name
 * @returns {string}
 */
export function normalizeStoreName(name) {
    const half = String(name || '')
        .replace(/[\uFF01-\uFF0C\uFF0E-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/\u3000/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const words = half.split(' ');
    return words.length >= 3 && words.every(w => w.length === 1) ? words.join('') : half;
}

/**
 * 見出し行のないカード明細CSVを読む（家族カードの明細で確認した形式）。
 * 列: 利用日, 利用店名, 利用者（ご本人／ご家族）, 支払区分, (空), 支払月（YY/MM）,
 *     利用金額, 支払金額, …, 現地通貨額, 通貨, 換算レート, 換算日
 * 海外利用は支払金額が空なので、利用金額を使う。利用日で始まらない行（氏名・合計など）は読み飛ばす。
 * @param {string[][]} rows - CSVの各行を列に分けたもの
 * @returns {{rows: Array<{date: string, store: string, amount: number, family: boolean}>, payMonth: string|null}}
 */
export function parseHeaderlessCardRows(rows) {
    const toAmount = (v) => {
        const cleaned = String(v ?? '').replace(/[,¥円\s]/g, '');
        if (!cleaned) return null;
        const n = Number(cleaned);
        return Number.isFinite(n) ? n : null;
    };

    const result = [];
    const payMonths = {};
    rows.forEach(cols => {
        const date = (cols[0] || '').trim();
        if (!ROW_DATE.test(date)) return;
        const store = normalizeStoreName(cols[1]);
        const amount = toAmount(cols[7]) ?? toAmount(cols[6]);
        if (!store || !amount) return;
        result.push({ date, store, amount, family: /家族/.test(cols[2] || '') });

        const pm = /^(\d{2})\/(\d{1,2})$/.exec((cols[5] || '').trim());
        if (pm) {
            const key = Utils.getMonthKey(2000 + Number(pm[1]), Number(pm[2]));
            payMonths[key] = (payMonths[key] || 0) + 1;
        }
    });

    const best = Object.entries(payMonths).sort((a, b) => b[1] - a[1])[0];
    return { rows: result, payMonth: best ? best[0] : null };
}

/** pdf.jsの読み込みPromise（PDF選択時に初回のみCDNから動的import） */
let _pdfjsPromise = null;

/**
 * pdf.jsをCDNから動的に読み込む（PDF未選択時は一切ロードしない）
 * @returns {Promise<any>} pdfjsモジュール
 */
function loadPdfJs() {
    if (!_pdfjsPromise) {
        const VER = '6.1.200';
        const base = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VER}/build`;
        _pdfjsPromise = import(/* webpackIgnore: true */ `${base}/pdf.min.mjs`).then((pdfjs) => {
            pdfjs.GlobalWorkerOptions.workerSrc = `${base}/pdf.worker.min.mjs`;
            return pdfjs;
        });
    }
    return _pdfjsPromise;
}

/**
 * クレジットカード明細（CSV / PDF）を読み込み、明細ごとにカテゴリを割り当てて
 * 家計簿に取り込むクラス
 *
 * フロー:
 * 1. ファイル選択（拡張子でCSV/PDFを自動判定） → 明細（利用日/店名/金額）を一覧表示
 * 2. 明細にチェックを入れ、カテゴリチップをタップして割り当て
 * 3. 取込先の月（CSVは「当月お支払日」、PDFは「お支払い日」から自動設定）を確認してインポート
 *
 * 店名→カテゴリの割り当てはFirestoreに保存され、次回から自動分類される。
 */
export class CSVImporter {
    /**
     * @param {BudgetManager} budgetManager - 予算管理インスタンス
     */
    constructor(budgetManager) {
        /** @type {BudgetManager} */
        this.budgetManager = budgetManager;
        /** @type {Array<{id: number, date: string, store: string, amount: number, category: string|null, checked: boolean}>} 読み込んだ明細 */
        this.transactions = [];
        /** @type {string|null} 当月お支払日から検出した取込先の月（YYYY-MM） */
        this.payMonth = null;
        /** @type {Object<string, string>} 店名→カテゴリ名の学習済みルール */
        this.rules = {};
        /** @type {Array<{name: string, existing: boolean}>} カテゴリチップの候補 */
        this._chips = [];
        /** @type {string|null} 選択中CSVファイルの内容ハッシュ（二重取込検出用） */
        this.fileHash = null;
        /** @type {Array<{hash: string, month: string, date: string, count: number, total: number}>} 取込履歴 */
        this.importHistory = [];
        /** @type {import('./family-card.js').FamilyCardManager|null} 家族カードの買い物の記録（app.jsから注入） */
        this.familyCard = null;
    }

    /**
     * 店名→カテゴリのルール・取込履歴をFirestoreから購読開始
     */
    init() {
        onSnapshot(
            doc(db, 'budgetData', 'csvImportRules'),
            (snap) => {
                this.rules = {};
                const stored = snap.exists() ? snap.data().rules : null;
                (stored || []).forEach(rule => {
                    if (rule.store && rule.category) {
                        this.rules[rule.store] = rule.category;
                    }
                });
            },
            (error) => console.error('CSVインポートルール読み込みエラー:', error)
        );

        onSnapshot(
            doc(db, 'budgetData', 'csvImportHistory'),
            (snap) => {
                this.importHistory = (snap.exists() ? snap.data().imports : null) || [];
            },
            (error) => console.error('CSV取込履歴読み込みエラー:', error)
        );
    }

    /**
     * SHA-256ハッシュ（16進）を計算
     * @private
     * @param {string|ArrayBuffer} data - 文字列（CSV）またはバイト列（PDF）
     * @returns {Promise<string>}
     */
    async _sha256(data) {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        const buf = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * 取込履歴に記録して保存（直近50件を保持）
     * @private
     */
    async _recordImport(entry) {
        this.importHistory = [entry, ...this.importHistory].slice(0, 50);
        try {
            await setDoc(doc(db, 'budgetData', 'csvImportHistory'), { imports: this.importHistory });
        } catch (error) {
            console.error('CSV取込履歴保存エラー:', error);
        }
    }

    /**
     * 店名→カテゴリのルールをFirestoreに保存
     * @private
     */
    async _saveRules() {
        const rules = Object.entries(this.rules).map(([store, category]) => ({ store, category }));
        try {
            await setDoc(doc(db, 'budgetData', 'csvImportRules'), { rules });
        } catch (error) {
            console.error('CSVインポートルール保存エラー:', error);
        }
    }

    /**
     * CSVインポートモーダルを表示
     */
    showModal() {
        Utils.showModal('csvImportModal');
        this._resetImportState();
    }

    /**
     * CSVインポートモーダルを閉じる
     */
    closeModal() {
        Utils.closeModal('csvImportModal');
        this._resetImportState();
    }

    /**
     * インポート状態をリセット
     * @private
     */
    _resetImportState() {
        this.transactions = [];
        this.payMonth = null;
        this._chips = [];
        this.fileHash = null;

        const fileInput = document.getElementById('csvFileInput');
        const fileNameDisplay = document.getElementById('csvFileName');
        const setup = document.getElementById('csvImportSetup');
        const importBtn = document.getElementById('csvImportBtn');
        const newCategoryInput = document.getElementById('csvNewCategoryInput');

        if (fileInput) fileInput.value = '';
        if (fileNameDisplay) {
            fileNameDisplay.textContent = '';
            fileNameDisplay.style.display = 'none';
        }
        if (setup) setup.style.display = 'none';
        if (importBtn) importBtn.disabled = true;
        if (newCategoryInput) newCategoryInput.value = '';
    }

    /**
     * ファイルが選択されたときの処理（拡張子でCSV/PDFを自動判定）
     * @param {Event} event - ファイル選択イベント
     */
    async handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        // ファイル名を表示
        const fileNameDisplay = document.getElementById('csvFileName');
        if (fileNameDisplay) {
            fileNameDisplay.textContent = `選択されたファイル: ${file.name} (${(file.size / 1024).toFixed(1)}KB)`;
            fileNameDisplay.style.display = 'block';
        }

        const lower = file.name.toLowerCase();
        if (!lower.endsWith('.csv') && !lower.endsWith('.pdf')) {
            Utils.showToast('CSVまたはPDFファイルを選択してください', 'error');
            return;
        }

        try {
            if (lower.endsWith('.pdf')) {
                Utils.showToast('PDF読み込み中...');
                await this._handlePdfFile(file);
            } else {
                Utils.showToast('CSV読み込み中...');
                const content = await this._readFile(file);
                this.fileHash = await this._sha256(content);
                this._parseTransactions(content);
            }
            this._applyFamilyMatching();
            this._setupImportUI();

            const familyCount = this.transactions.filter(t => t.family).length;
            const matched = this.transactions.filter(t => t.recordId).length;
            const autoAssigned = this.transactions.filter(t => t.category && !t.personal).length;
            Utils.showToast(familyCount > 0
                ? `${this.transactions.length}件読み込み（家族カード${familyCount}件のうち、記録と一致${matched}件）`
                : autoAssigned > 0
                    ? `${this.transactions.length}件読み込み（${autoAssigned}件を自動分類）`
                    : `${this.transactions.length}件読み込みました`);
        } catch (error) {
            console.error('明細読み込みエラー:', error);
            Utils.showToast(`ファイルの読み込みに失敗しました: ${error.message}`, 'error');
            this._resetImportState();
        }
    }

    /**
     * ファイルを読み込む（エンコーディング自動検出）
     * @private
     * @param {File} file - 読み込むファイル
     * @returns {Promise<string>} ファイル内容
     */
    async _readFile(file) {
        // まずUTF-8で試す（モバイルやWebでダウンロードしたCSVの多く）
        try {
            const content = await this._readFileWithEncoding(file, 'UTF-8');
            // UTF-8で日本語が正しく読めているか簡易チェック（置換文字が無ければOK）
            if (!content.includes('�') && content.length > 0) {
                return content;
            }
        } catch {
            // フォールバックに進む
        }

        // UTF-8で失敗したらShift_JISで試す（クレジットカード会社のCSV）
        try {
            return await this._readFileWithEncoding(file, 'Shift_JIS');
        } catch {
            throw new Error('ファイルの読み込みに失敗しました（エンコーディングが不明です）');
        }
    }

    /**
     * 指定されたエンコーディングでファイルを読み込む
     * @private
     * @param {File} file - 読み込むファイル
     * @param {string} encoding - エンコーディング
     * @returns {Promise<string>} ファイル内容
     */
    _readFileWithEncoding(file, encoding) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error(`${encoding}での読み込みに失敗しました`));
            reader.readAsText(file, encoding);
        });
    }

    /**
     * CSVをパースして明細リストを作成
     * PayPayカード形式（利用日/利用店名・商品名/利用金額/当月支払金額/当月お支払日）を
     * 基本に、他社カードのCSVもヘッダー名のゆらぎをある程度吸収する
     * @private
     * @param {string} content - CSV内容
     */
    _parseTransactions(content) {
        const lines = content.split(/\r?\n/).filter(line => line.trim());
        if (lines.length < 2) {
            throw new Error('CSVファイルにデータ行がありません');
        }

        const headers = this._parseCSVLine(lines[0]);
        const findCol = (...keywords) =>
            headers.findIndex(h => keywords.some(k => h.includes(k)));

        const storeCol = findCol('利用店名', 'ご利用先', '摘要', '内容', '店名');
        const amountCol = findCol('利用金額', 'ご利用金額');
        const payAmountCol = findCol('当月支払金額', '当月請求額');
        const dateCol = findCol('利用日');
        const payDateCol = findCol('当月お支払日', 'お支払日', '支払日');
        const userCol = findCol('利用者');

        if (storeCol === -1 || (amountCol === -1 && payAmountCol === -1)) {
            // 見出し行がなく、利用日で始まる行が並ぶ形式（家族カードの明細）
            const parsed = lines.map(line => this._parseCSVLine(line));
            if (parsed.some(cols => ROW_DATE.test((cols[0] || '').trim()))) {
                this._useHeaderlessRows(parsed);
                return;
            }
            throw new Error('「利用店名」または「利用金額」の列が見つかりません。ヘッダー行を確認してください。');
        }

        const transactions = [];
        const payDates = [];

        for (let i = 1; i < lines.length; i++) {
            const row = this._parseCSVLine(lines[i]);
            if (row.length <= storeCol) continue;

            const store = (row[storeCol] || '').trim();
            if (!store) continue;

            // 当月支払金額を優先（分割・リボでも当月の実支払額を取り込める）
            const amount = this._pickAmount(row, payAmountCol, amountCol);
            if (amount === null || amount === 0) continue;

            transactions.push({
                id: transactions.length,
                date: dateCol !== -1 ? (row[dateCol] || '').trim() : '',
                store,
                amount,
                category: this.rules[store] || null,
                checked: false,
                family: userCol !== -1 && /家族/.test(row[userCol] || '')
            });

            if (payDateCol !== -1 && row[payDateCol]?.trim()) {
                payDates.push(row[payDateCol].trim());
            }
        }

        if (transactions.length === 0) {
            throw new Error('有効な明細が見つかりませんでした');
        }

        this.transactions = transactions;
        this.payMonth = this._detectPayMonth(payDates);
    }

    /**
     * 見出し行のないCSVの行を明細にする
     * @private
     * @param {string[][]} parsed - CSVの各行を列に分けたもの
     */
    _useHeaderlessRows(parsed) {
        const { rows, payMonth } = parseHeaderlessCardRows(parsed);
        if (rows.length === 0) {
            throw new Error('有効な明細が見つかりませんでした');
        }
        this.transactions = rows.map((r, i) => ({
            id: i,
            date: r.date,
            store: r.store,
            amount: r.amount,
            category: this.rules[r.store] || null,
            checked: false,
            family: r.family
        }));
        this.payMonth = payMonth || this._detectPayMonth([]);
    }

    /**
     * 家族カードの行を、共有の買い物の記録と照らし合わせる。
     * 一致した行は共有（記録のカテゴリーを使う）、一致しない行は妻の個人利用にしておく。
     * 取込画面で、行ごとに共有と妻個人を切り替えられる。
     * @private
     */
    _applyFamilyMatching() {
        const familyRows = this.transactions.filter(t => t.family);
        if (familyRows.length === 0) return;

        const matches = matchFamilyRows(familyRows, this.familyCard?.list() || []);
        familyRows.forEach(t => {
            const record = matches.get(t.id);
            t.recordId = record ? record.id : null;
            t.personal = !record;
            if (record?.category) t.category = record.category;
        });
    }

    /**
     * 金額文字列を数値に変換
     * @private
     * @param {string} str - 金額文字列
     * @returns {number|null} 数値（変換不能ならnull）
     */
    _parseAmount(str) {
        if (str == null) return null;
        const cleaned = String(str).replace(/[,¥円\s]/g, '');
        if (!cleaned) return null;
        const num = parseFloat(cleaned);
        return Number.isFinite(num) ? num : null;
    }

    /**
     * 行から取り込む金額を選択（当月支払金額 → 利用金額の順で優先）
     * @private
     */
    _pickAmount(row, payAmountCol, amountCol) {
        if (payAmountCol !== -1) {
            const value = this._parseAmount(row[payAmountCol]);
            if (value !== null) return value;
        }
        if (amountCol !== -1) {
            return this._parseAmount(row[amountCol]);
        }
        return null;
    }

    /**
     * 「当月お支払日」から取込先の月を検出（最頻値を採用）
     * @private
     * @param {string[]} payDates - 支払日文字列の配列（例: "2026/7/27"）
     * @returns {string} YYYY-MM形式の月キー
     */
    _detectPayMonth(payDates) {
        const counts = {};
        payDates.forEach(dateStr => {
            const m = dateStr.match(/^(\d{4})[\/\-](\d{1,2})/);
            if (m) {
                const key = Utils.getMonthKey(parseInt(m[1]), parseInt(m[2]));
                counts[key] = (counts[key] || 0) + 1;
            }
        });

        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        if (best) return best[0];

        // 支払日が読み取れなければ今月をデフォルトに
        const now = Utils.getJSTDate();
        return Utils.getMonthKey(now.getFullYear(), now.getMonth() + 1);
    }

    /**
     * CSV行をパース（簡易実装）
     * @private
     * @param {string} line - CSV行
     * @returns {string[]} パースされた列
     */
    _parseCSVLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current.trim());

        return result;
    }

    // ----------------------------------------
    // PDF明細の読み込み・パース
    // （三井住友カード「お支払い明細」＝Amazon Mastercard発行分。
    //  詳細は docs/statement-import-design.md 参照）
    // ----------------------------------------

    /**
     * PDFファイルを読み込み、明細リストを作成する
     * @private
     * @param {File} file - 選択されたPDFファイル
     */
    async _handlePdfFile(file) {
        const buf = await file.arrayBuffer();
        this.fileHash = await this._sha256(buf);
        const lines = await this._extractPdfLines(buf);
        this._parsePdfStatement(lines);
    }

    /**
     * PDFのテキストをy座標でグルーピングし、上から下・左から右の行データに変換する
     * @private
     * @param {ArrayBuffer} buf - PDFファイルの内容
     * @returns {Promise<Array<{y: number, text: string, tokens: string[]}>>}
     */
    async _extractPdfLines(buf) {
        const pdfjs = await loadPdfJs();
        const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
        const lines = [];

        for (let p = 1; p <= doc.numPages; p++) {
            const page = await doc.getPage(p);
            const tc = await page.getTextContent();
            const byY = new Map();

            for (const item of tc.items) {
                if (!item.str) continue;
                // 康熙部首の字形を通常の漢字に正規化し、制御文字を除去する。
                // 空白文字（実際の列の区切り）はここでは捨てずに残す。
                const s = normalizeKangxiRadicals(item.str).replace(/[\x00-\x1f]/g, '');
                if (!s) continue;
                const y = Math.round(item.transform[5]);
                // 近接するyは同一行とみなす（±2px）
                let key = y;
                for (const k of byY.keys()) {
                    if (Math.abs(k - y) <= 2) { key = k; break; }
                }
                if (!byY.has(key)) byY.set(key, []);
                byY.get(key).push({ x: item.transform[4], s });
            }

            for (const [y, arr] of byY) {
                arr.sort((a, b) => a.x - b.x);
                // pdf.jsが返す空白文字は実際の列の区切りをそのまま表しているため、
                // 独自の区切り文字を挿入せずに連結する（挿入すると単語の途中に
                // 余分な空白が入ってしまう。例: 「手数料」が複数グリフに分割されている場合）。
                const text = arr.map(a => a.s).join('').replace(/\s+/g, ' ').trim();
                const tokens = text.split(/\s+/).filter(Boolean);
                if (tokens.length) lines.push({ y, text, tokens });
            }
        }

        lines.sort((a, b) => b.y - a.y); // 紙面の上から下の順に
        return lines;
    }

    /**
     * 三井住友カード（Amazon Mastercard）のお支払い明細PDFをパースして明細リストを作成
     * 分割払いは「当月支払額」（各行末尾の半角金額）を採用する
     * @private
     * @param {Array<{y: number, text: string, tokens: string[]}>} lines - 抽出済みの行データ
     */
    _parsePdfStatement(lines) {
        const isSmbc = lines.some(l => /お支払い明細|三井住友カード|お支払い合計額/.test(l.text));
        if (!isSmbc) {
            throw new Error('対応していないPDF形式です（三井住友カード/Amazon Mastercardの明細PDFを選択してください）');
        }

        const MONEY = /^\d{1,3}(?:,\d{3})*$/; // 半角・カンマ区切りの整数（全角の回数列とは区別される）
        const DATE = /^\d{2}\/\d{2}\/\d{2}$/; // YY/MM/DD

        const txs = [];
        let total = null;
        let payMonth = null;

        for (const { text, tokens } of lines) {
            const pay = text.match(/お支払い日\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
            if (pay) payMonth = Utils.getMonthKey(parseInt(pay[1]), parseInt(pay[2]));

            // 「＜お支払金額総合計＞ 54,739」のように、ラベルと金額が同じ行にまとまって出現する
            const grand = text.match(/＜お支払金額総合計＞[^\d]*([\d,]+)/);
            if (grand) total = this._parseAmount(grand[1]);

            if (/＜お支払金額総合計＞/.test(text)) continue; // 合計行は明細に含めない

            const moneyTokens = tokens.filter(t => MONEY.test(t));
            const dateTok = tokens.find(t => DATE.test(t));

            if (dateTok && moneyTokens.length) {
                const amount = this._parseAmount(moneyTokens[moneyTokens.length - 1]); // 当月支払額
                if (!amount) continue;
                const dateIdx = tokens.indexOf(dateTok);
                const moneyIdx = tokens.indexOf(moneyTokens[0]);
                const store = tokens.slice(dateIdx + 1, moneyIdx).join(' ').trim();
                if (!store) continue;
                txs.push({
                    id: txs.length,
                    date: this._normPdfDate(dateTok),
                    store,
                    amount,
                    category: this.rules[store] || null,
                    checked: false
                });
            } else if (/^遅延損害金/.test(text) && moneyTokens.length) {
                const amount = this._parseAmount(moneyTokens[moneyTokens.length - 1]);
                const store = text.replace(/\s*[\d,]+\s*$/, '').trim();
                if (amount) {
                    txs.push({
                        id: txs.length,
                        date: '',
                        store,
                        amount,
                        category: this.rules[store] || null,
                        checked: false
                    });
                }
            }
        }

        if (txs.length === 0) {
            throw new Error('有効な明細が見つかりませんでした');
        }

        this.transactions = txs;
        this.payMonth = payMonth || this._detectPayMonth([]);

        // 明細合計と総合計を検算（不一致でも取込自体は継続する）
        if (total != null) {
            const sum = txs.reduce((s, t) => s + t.amount, 0);
            if (Math.abs(sum - total) >= 1) {
                Utils.showToast(
                    `注意: 明細合計(¥${Utils.formatCurrency(sum)})と総合計(¥${Utils.formatCurrency(total)})が一致しません`,
                    'error'
                );
            }
        }
    }

    /**
     * PDF内の日付表記（YY/MM/DD）を YYYY/MM/DD に変換
     * @private
     * @param {string} yymmdd - 例: "26/05/31"
     * @returns {string} 例: "2026/05/31"
     */
    _normPdfDate(yymmdd) {
        const [y, m, d] = yymmdd.split('/');
        return `20${y}/${m}/${d}`;
    }

    // ----------------------------------------
    // 取込設定UIの描画
    // ----------------------------------------

    /**
     * 明細読み込み後の取込設定UIを表示
     * @private
     */
    _setupImportUI() {
        const setup = document.getElementById('csvImportSetup');
        if (setup) setup.style.display = 'block';

        // 取込先の月（当月お支払日から自動設定）
        const monthInput = document.getElementById('csvImportMonth');
        if (monthInput) monthInput.value = this.payMonth;

        const monthHint = document.getElementById('csvImportMonthHint');
        if (monthHint) {
            monthHint.textContent = this.payMonth
                ? '※ 明細の「お支払日」から自動設定しています'
                : '';
        }

        this._renderAll();
    }

    /**
     * 取込先の月から選択中の月キーを取得
     * @private
     * @returns {string} YYYY-MM形式
     */
    _getSelectedMonthKey() {
        return document.getElementById('csvImportMonth')?.value || this.payMonth || '';
    }

    /**
     * 取込先の月が変更されたときの処理（既存カテゴリのチップを更新）
     */
    onMonthChange() {
        this._renderAll();
    }

    /**
     * 取込設定UI全体を再描画
     * @private
     */
    _renderAll() {
        this._buildChipCategories();
        this._renderFamilyPanel();
        this._renderChips();
        this._renderToolbar();
        this._renderTable();
        this._renderPreview();
        this._updateImportButton();
    }

    /**
     * カテゴリチップの候補リストを構築
     * 優先順: 取込先の月の既存カテゴリ → 割り当て済み → 学習済みルール → デフォルト候補
     * @private
     */
    _buildChipCategories() {
        const monthKey = this._getSelectedMonthKey();
        const monthCategories = (this.budgetManager.data[monthKey]?.categories || []).map(c => c.name);
        const assignedCategories = this.transactions.map(t => t.category).filter(Boolean);
        const ruleCategories = Object.values(this.rules);

        const seen = new Set();
        this._chips = [];
        [...monthCategories, ...assignedCategories, ...ruleCategories, ...DEFAULT_CATEGORY_SUGGESTIONS]
            .forEach(name => {
                if (name && !seen.has(name)) {
                    seen.add(name);
                    this._chips.push({ name, existing: monthCategories.includes(name) });
                }
            });
    }

    /**
     * カテゴリチップを描画
     * @private
     */
    _renderChips() {
        const container = document.getElementById('csvCategoryChips');
        if (!container) return;

        container.innerHTML = this._chips.map((chip, index) => {
            const style = chip.existing
                ? 'bg-white/10 text-zinc-200 ring-1 ring-inset ring-white/20 hover:bg-white/15'
                : 'bg-white/10 text-zinc-300 ring-1 ring-inset ring-white/10 hover:bg-white/15';
            return `<button type="button" onclick="app.csvImporter.assignChip(${index})"
                class="rounded-full px-3 py-1.5 text-xs font-medium transition ${style}">${Utils.escapeHtml(chip.name)}</button>`;
        }).join('');
    }

    /**
     * 明細リストのツールバー（全選択・選択件数）を描画
     * @private
     */
    _renderToolbar() {
        const toolbar = document.getElementById('csvTxToolbar');
        if (!toolbar) return;

        const checkedCount = this.transactions.filter(t => t.checked).length;
        const allChecked = checkedCount === this.transactions.length && this.transactions.length > 0;

        toolbar.innerHTML = `
            <label class="flex cursor-pointer items-center gap-2.5 text-xs font-medium text-zinc-300">
                <input type="checkbox" ${allChecked ? 'checked' : ''}
                    onchange="app.csvImporter.toggleAll(this.checked)"
                    class="h-4 w-4 rounded border-white/20 bg-white/5 accent-amber-400 focus:ring-zinc-400">
                全選択（選択中 ${checkedCount}件）
            </label>
            <span class="flex shrink-0 gap-1.5">
                ${this.transactions.some(t => t.family) ? `<button type="button" onclick="app.csvImporter.markCheckedPersonal()"
                    class="rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-white/15">
                    妻個人にする
                </button>` : ''}
                <button type="button" onclick="app.csvImporter.selectUnassigned()"
                    class="rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-white/15">
                    未分類を選択
                </button>
            </span>
        `;
    }

    /**
     * 明細リストを描画
     * @private
     */
    _renderTable() {
        const list = document.getElementById('csvTxList');
        if (!list) return;

        list.innerHTML = this.transactions.map(t => {
            const shortDate = t.date.replace(/^\d{4}[\/\-]/, '');
            const amountClass = t.amount < 0 ? 'text-rose-400' : 'text-white';
            const badge = t.personal
                ? `<span class="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium text-zinc-200"><span class="h-1.5 w-1.5 rounded-full bg-pink-400"></span>妻個人</span>`
                : t.category
                ? `<span class="inline-flex max-w-full items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium text-zinc-200">
                        <span class="truncate">${Utils.escapeHtml(t.category)}</span>
                        <button type="button" onclick="event.preventDefault(); event.stopPropagation(); app.csvImporter.clearCategory(${t.id})"
                            class="shrink-0 text-zinc-200/70 hover:text-zinc-200">✕</button>
                   </span>`
                : '<span class="rounded-full bg-white/10 px-2 py-0.5 text-xs text-zinc-500">未分類</span>';

            return `
                <label class="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition hover:bg-white/5 ${t.checked ? 'bg-white/10' : ''}" id="csv-row-${t.id}">
                    <input type="checkbox" ${t.checked ? 'checked' : ''}
                        onchange="app.csvImporter.toggleRow(${t.id}, this.checked)"
                        class="h-4 w-4 shrink-0 rounded border-white/20 bg-white/5 accent-amber-400 focus:ring-zinc-400">
                    <div class="min-w-0 flex-1">
                        <div class="truncate text-sm text-zinc-100">${Utils.escapeHtml(t.store)}</div>
                        <div class="flex flex-wrap items-center gap-x-1.5 text-xs text-zinc-500">
                            <span class="font-mono tabular-nums">${Utils.escapeHtml(shortDate)}</span>
                            ${t.family ? this._renderFamilyRowStatus(t) : ''}
                        </div>
                    </div>
                    <div class="whitespace-nowrap text-sm font-medium ${amountClass} font-mono tabular-nums">¥${Utils.formatCurrency(t.amount)}</div>
                    <div class="flex w-28 shrink-0 flex-col items-end gap-1 text-right">${badge}${t.family ? this._renderFamilyToggle(t) : ''}</div>
                </label>
            `;
        }).join('');
    }

    /**
     * 家族カードの行の補足（記録と一致したか。一致したら記録の日付を添える）
     * @private
     * @param {Object} t - 明細
     * @returns {string}
     */
    _renderFamilyRowStatus(t) {
        const record = t.recordId ? this.familyCard?.items?.[t.recordId] : null;
        if (!record) return '<span aria-hidden="true">·</span><span>家族カード</span>';
        const title = `記録: ${formatShortDate(record.date)} ${record.store || ''} ¥${Utils.formatCurrency(record.amount)}`;
        return `<span aria-hidden="true">·</span><span class="text-zinc-300" title="${Utils.escapeHtml(title)}">記録あり ${formatShortDate(record.date)}</span>`;
    }

    /**
     * 家族カードの行の、共有と妻の個人利用の切り替えボタン
     * @private
     * @param {Object} t - 明細
     * @returns {string}
     */
    _renderFamilyToggle(t) {
        return `<button type="button" class="text-xs font-medium text-zinc-400 underline decoration-white/20 underline-offset-2 transition-colors hover:text-white"
            onclick="event.preventDefault(); event.stopPropagation(); app.csvImporter.setPersonal(${t.id}, ${!t.personal})">${t.personal ? '共有にする' : '妻個人にする'}</button>`;
    }

    /**
     * 家族カードのまとめ（共有・妻個人の件数と金額、照らし合わせできなかった記録）
     * @private
     */
    _renderFamilyPanel() {
        const panel = document.getElementById('csvFamilyPanel');
        if (!panel) return;

        const familyRows = this.transactions.filter(t => t.family);
        if (familyRows.length === 0) {
            panel.style.display = 'none';
            panel.innerHTML = '';
            return;
        }
        panel.style.display = 'block';

        const sum = (rows) => rows.reduce((s, t) => s + t.amount, 0);
        const personal = familyRows.filter(t => t.personal);
        const shared = familyRows.filter(t => !t.personal);
        const matched = familyRows.filter(t => t.recordId);

        const usedIds = new Set(matched.map(t => t.recordId));
        const leftovers = (this.familyCard?.list() || []).filter(r => !usedIds.has(r.id));
        const leftoverHtml = leftovers.length === 0 ? '' : `
            <div class="mt-4">
                <p class="text-xs font-medium text-zinc-400">照らし合わせできなかった記録 <span class="font-mono tabular-nums">${leftovers.length}件</span></p>
                <ul class="mt-1 divide-y divide-white/[0.06]">
                    ${leftovers.map(r => `
                        <li class="flex items-center gap-3 py-2 text-sm">
                            <span class="w-10 shrink-0 font-mono text-xs tabular-nums text-zinc-500">${formatShortDate(r.date)}</span>
                            <span class="min-w-0 flex-1 truncate ${r.store ? 'text-zinc-200' : 'text-zinc-500'}">${Utils.escapeHtml(r.store || '店名なし')}</span>
                            <span class="shrink-0 font-mono tabular-nums text-zinc-200">¥${Utils.formatCurrency(r.amount)}</span>
                            <button type="button" aria-label="この記録を削除" onclick="app.csvImporter.removeRecord(${Utils.escapeJsArg(r.id)})"
                                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-zinc-400 ring-1 ring-inset ring-white/10 transition-colors hover:bg-rose-500/10 hover:text-rose-300">${Icons.svg('x')}</button>
                        </li>`).join('')}
                </ul>
                <p class="mt-1.5 text-xs leading-relaxed text-zinc-500">来月の明細に載る買い物は、残しておけば次の取込で照らし合わせます。金額が違って一致しなかったもの（分割発送など）は、行を「共有にする」に切り替えてから、記録を削除してください。</p>
            </div>`;

        panel.innerHTML = `
            <div class="flex items-baseline justify-between gap-3">
                <p class="text-sm font-medium text-zinc-300">${Icons.svg('credit-card')} 家族カード <span class="font-mono text-xs tabular-nums text-zinc-500">${familyRows.length}件</span></p>
                <span class="font-mono text-sm tabular-nums text-zinc-200">¥${Utils.formatCurrency(sum(familyRows))}</span>
            </div>
            <dl class="mt-3 space-y-1.5 text-sm">
                <div class="flex items-baseline justify-between gap-3">
                    <dt class="text-zinc-400">共有 <span class="font-mono text-xs tabular-nums text-zinc-500">${shared.length}件・記録と一致 ${matched.length}件</span></dt>
                    <dd class="font-mono tabular-nums text-zinc-200">¥${Utils.formatCurrency(sum(shared))}</dd>
                </div>
                <div class="flex items-baseline justify-between gap-3">
                    <dt class="flex items-center gap-1.5 text-zinc-400"><span class="h-1.5 w-1.5 rounded-full bg-pink-400"></span>妻の個人利用 <span class="font-mono text-xs tabular-nums text-zinc-500">${personal.length}件</span></dt>
                    <dd class="font-mono font-medium tabular-nums text-amber-300">¥${Utils.formatCurrency(sum(personal))}</dd>
                </div>
            </dl>
            <p class="mt-3 text-xs leading-relaxed text-zinc-500">記録と一致しなかった行は、妻の個人利用にしています。共有の買い物だった行は「共有にする」で切り替えるか、チェックを入れてカテゴリーを選んでください。妻の個人利用は家計の合計に入れず、精算で全額を妻が負担します。</p>
            ${leftoverHtml}
        `;
    }

    /**
     * カテゴリ別の集計プレビューを描画
     * @private
     */
    _renderPreview() {
        const preview = document.getElementById('csvPreview');
        if (!preview) return;

        const total = this.transactions.reduce((sum, t) => sum + t.amount, 0);
        const unassigned = this.transactions.filter(t => !t.category && !t.personal);
        const personal = this.transactions.filter(t => t.personal);

        // カテゴリごとに集計
        const groups = {};
        this.transactions.forEach(t => {
            if (!t.category || t.personal) return;
            if (!groups[t.category]) groups[t.category] = { count: 0, sum: 0 };
            groups[t.category].count++;
            groups[t.category].sum += t.amount;
        });

        const chips = Object.entries(groups).map(([name, g]) =>
            `<span class="rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-xs font-medium text-zinc-200 ring-1 ring-inset ring-white/10">
                ${Utils.escapeHtml(name)} ¥${Utils.formatCurrency(g.sum)}（${g.count}件）
            </span>`
        ).join('');

        const unassignedChip = unassigned.length > 0
            ? `<span class="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-300 ring-1 ring-inset ring-amber-500/20">
                    未分類 ¥${Utils.formatCurrency(unassigned.reduce((s, t) => s + t.amount, 0))}（${unassigned.length}件）
               </span>`
            : '';

        const personalChip = personal.length > 0
            ? `<span class="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 py-1.5 text-xs font-medium text-zinc-200 ring-1 ring-inset ring-white/10">
                    <span class="h-1.5 w-1.5 rounded-full bg-pink-400"></span>妻の個人利用 ¥${Utils.formatCurrency(personal.reduce((s, t) => s + t.amount, 0))}（${personal.length}件・合計外）
               </span>`
            : '';

        preview.innerHTML = `
            <div class="mb-2 text-xs font-medium text-zinc-400">全${this.transactions.length}件 / 合計 ¥${Utils.formatCurrency(total)}</div>
            <div class="flex flex-wrap gap-2">${chips}${personalChip}${unassignedChip}</div>
        `;
    }

    /**
     * インポートボタンの有効/無効を更新
     * @private
     */
    _updateImportButton() {
        const importBtn = document.getElementById('csvImportBtn');
        if (importBtn) {
            importBtn.disabled = !this.transactions.some(t => t.personal || t.category);
        }
    }

    // ----------------------------------------
    // 明細の選択・カテゴリ割り当て
    // ----------------------------------------

    /**
     * 明細のチェック状態を切り替え
     * @param {number} id - 明細ID
     * @param {boolean} checked - チェック状態
     */
    toggleRow(id, checked) {
        const transaction = this.transactions.find(t => t.id === id);
        if (!transaction) return;
        transaction.checked = checked;

        // 行のハイライトとツールバーだけ更新（リスト全体は再描画しない＝スクロール位置維持）
        const row = document.getElementById(`csv-row-${id}`);
        if (row) row.classList.toggle('bg-white/10', checked);
        this._renderToolbar();
    }

    /**
     * 全明細のチェック状態を一括切り替え
     * @param {boolean} checked - チェック状態
     */
    toggleAll(checked) {
        this.transactions.forEach(t => { t.checked = checked; });
        this._renderToolbar();
        this._renderTable();
    }

    /**
     * 未分類の明細のみを選択
     */
    selectUnassigned() {
        this.transactions.forEach(t => { t.checked = !t.category && !t.personal; });
        this._renderToolbar();
        this._renderTable();
    }

    /**
     * チップをタップしてチェック済み明細にカテゴリを割り当て
     * @param {number} index - チップのインデックス
     */
    assignChip(index) {
        const chip = this._chips[index];
        if (chip) this._assignToChecked(chip.name);
    }

    /**
     * 新規カテゴリ名を入力してチェック済み明細に割り当て
     */
    assignNewCategory() {
        const input = document.getElementById('csvNewCategoryInput');
        const name = input?.value.trim();
        if (!name) {
            Utils.showToast('カテゴリ名を入力してください');
            return;
        }
        if (this._assignToChecked(name) && input) input.value = '';
    }

    /**
     * チェック済み明細にカテゴリを割り当てる
     * @private
     * @param {string} categoryName - カテゴリ名
     * @returns {boolean} 割り当てできたか
     */
    _assignToChecked(categoryName) {
        const checked = this.transactions.filter(t => t.checked);
        if (checked.length === 0) {
            Utils.showToast('明細にチェックを入れてからカテゴリを選択してください');
            return false;
        }

        // カテゴリーを選んだ家族カードの行は共有の買い物として扱う
        checked.forEach(t => {
            t.category = categoryName;
            t.personal = false;
            t.checked = false;
        });

        this._renderAll();
        Utils.showToast(`${checked.length}件を「${categoryName}」に割り当てました`);
        return true;
    }

    /**
     * 家族カードの行を、共有と妻の個人利用で切り替える
     * @param {number} id - 明細ID
     * @param {boolean} personal - 妻の個人利用にするか
     */
    setPersonal(id, personal) {
        const t = this.transactions.find(row => row.id === id);
        if (!t || !t.family) return;
        t.personal = !!personal;
        this._renderAll();
    }

    /** チェックを入れた家族カードの行を、まとめて妻の個人利用にする */
    markCheckedPersonal() {
        const checked = this.transactions.filter(t => t.checked && t.family);
        if (checked.length === 0) {
            Utils.showToast('家族カードの行にチェックを入れてください');
            return;
        }
        checked.forEach(t => {
            t.personal = true;
            t.checked = false;
        });
        this._renderAll();
        Utils.showToast(`${checked.length}件を妻の個人利用にしました`);
    }

    /**
     * 照らし合わせできなかった記録を削除する（確認あり）
     * @param {string} recordId
     */
    async removeRecord(recordId) {
        await this.familyCard?.remove(recordId);
        this._renderFamilyPanel();
    }

    /**
     * 明細のカテゴリ割り当てを解除
     * @param {number} id - 明細ID
     */
    clearCategory(id) {
        const transaction = this.transactions.find(t => t.id === id);
        if (!transaction) return;
        transaction.category = null;
        this._renderAll();
    }

    // ----------------------------------------
    // インポート実行
    // ----------------------------------------

    /**
     * カテゴリ割り当て済みの明細を家計簿に取り込む
     */
    async importData() {
        const monthKey = this._getSelectedMonthKey();
        if (!/^\d{4}-\d{2}$/.test(monthKey)) {
            Utils.showToast('取込先の月を選択してください', 'error');
            return;
        }

        const assigned = this.transactions.filter(t => t.category && !t.personal);
        const personal = this.transactions.filter(t => t.personal);
        if (assigned.length === 0 && personal.length === 0) {
            Utils.showToast('カテゴリを割り当てた明細がありません', 'error');
            return;
        }

        // 同一CSVの二重取込を検出して警告（二重計上の防止）
        const dup = this.fileHash && this.importHistory.find(h => h.hash === this.fileHash);
        if (dup) {
            const when = dup.date ? dup.date.replace(/-/g, '/') : '過去';
            const proceed = await Dialog.confirm(
                `このCSVは既に取り込み済みです（${when}に${dup.count}件を取込）。\nもう一度取り込むと二重計上になります。続行しますか？`,
                { okLabel: '続行', danger: true }
            );
            if (!proceed) return;
        }

        const skipped = this.transactions.length - assigned.length - personal.length;
        if (skipped > 0) {
            const proceed = await Dialog.confirm(`未分類の${skipped}件は取り込まれません。続行しますか？`, { okLabel: '続行' });
            if (!proceed) return;
        }

        const detailMode = document.querySelector('input[name="csvImportMode"]:checked')?.value !== 'sum';
        const monthData = this.budgetManager.getMonthData(monthKey);

        // カテゴリごとにグループ化して登録
        const groups = new Map();
        assigned.forEach(t => {
            if (!groups.has(t.category)) groups.set(t.category, []);
            groups.get(t.category).push(t);
        });

        groups.forEach((rows, name) => {
            if (detailMode) {
                this._importAsDetails(monthData, name, rows);
            } else {
                this._importAsSum(monthData, name, rows);
            }
        });

        // 妻の個人利用は、家計の合計に入れず別に持つ（精算で全額を妻が負担する）
        addWifePersonal(monthData, personal.map(t => ({ name: t.store, amount: t.amount, note: t.date })));

        // 店名→カテゴリのルールを学習して保存（妻の個人利用の行は学習しない）
        assigned.forEach(t => { this.rules[t.store] = t.category; });
        if (assigned.length > 0) this._saveRules();

        // 共有として取り込んだ行と一致した記録は、照らし合わせ済みなので消す
        const usedRecordIds = assigned.map(t => t.recordId).filter(Boolean);
        if (usedRecordIds.length > 0) this.familyCard?.removeMatched(usedRecordIds);

        // 取込履歴に記録（次回の二重取込検出用）
        const importedRows = [...assigned, ...personal];
        if (this.fileHash) {
            this._recordImport({
                hash: this.fileHash,
                month: monthKey,
                date: Utils.getTodayString(),
                count: importedRows.length,
                total: importedRows.reduce((s, t) => s + t.amount, 0)
            });
        }

        // 取込先の月に表示を切り替えて保存
        const [year, month] = monthKey.split('-');
        this.budgetManager.currentYear = parseInt(year);
        this.budgetManager.currentMonth = parseInt(month);
        this.budgetManager.saveWithStatus();
        this.budgetManager.updateDisplay();

        const personalTotal = personal.reduce((s, t) => s + t.amount, 0);
        Utils.showToast(personal.length > 0
            ? `${assigned.length}件を${parseInt(month)}月に取り込み、妻の個人利用${personal.length}件（¥${Utils.formatCurrency(personalTotal)}）を分けました`
            : `${assigned.length}件を${parseInt(month)}月に取り込みました`);
        this.closeModal();
    }

    /**
     * 明細を小カテゴリーとして取り込む
     * @private
     */
    _importAsDetails(monthData, categoryName, rows) {
        let category = monthData.categories.find(c => c.name === categoryName);

        if (!category) {
            category = {
                id: Utils.generateId(),
                name: categoryName,
                amount: 0,
                note: '',
                subcategories: []
            };
            monthData.categories.push(category);
        } else {
            // 直接金額を持つカテゴリに小カテゴリーを追加すると合計から漏れるため、既存金額を退避する
            moveDirectAmountToDetail(category);
        }

        rows.forEach(t => {
            category.subcategories.push({
                id: Utils.generateId(),
                name: t.store,
                amount: t.amount,
                note: t.date
            });
        });
    }

    /**
     * カテゴリごとの合計金額のみ取り込む
     * @private
     */
    _importAsSum(monthData, categoryName, rows) {
        const sum = rows.reduce((total, t) => total + t.amount, 0);
        const category = monthData.categories.find(c => c.name === categoryName);

        if (!category) {
            monthData.categories.push({
                id: Utils.generateId(),
                name: categoryName,
                amount: sum,
                note: 'CSVインポート',
                subcategories: []
            });
        } else if (category.subcategories.length > 0) {
            category.subcategories.push({
                id: Utils.generateId(),
                name: `CSV取込（${rows.length}件）`,
                amount: sum,
                note: ''
            });
        } else {
            category.amount = (category.amount || 0) + sum;
        }
    }
}

