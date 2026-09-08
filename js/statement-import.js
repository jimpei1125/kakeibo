/**
 * 明細読み込みモジュール（CSV / PDF）
 * クレジットカードの利用明細を読み込み、カテゴリを割り当てて家計簿へ取り込む。
 * PDFは三井住友カード（Amazon Mastercard）形式に対応（docs/statement-import-design.md 参照）。
 */

import { db, doc, setDoc, onSnapshot } from './firebase-config.js';
import { Utils } from './utils.js';
import { Dialog } from './dialog.js';


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
            this._setupImportUI();

            const autoAssigned = this.transactions.filter(t => t.category).length;
            Utils.showToast(autoAssigned > 0
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

        if (storeCol === -1 || (amountCol === -1 && payAmountCol === -1)) {
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
                checked: false
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
                ? 'bg-indigo-500/20 text-indigo-300 ring-1 ring-inset ring-indigo-400/30 hover:bg-indigo-500/30'
                : 'bg-white/10 text-zinc-300 ring-1 ring-inset ring-white/10 hover:bg-white/15';
            return `<button type="button" onclick="app.csvImporter.assignChip(${index})"
                class="rounded-full px-3 py-1.5 text-xs font-semibold transition ${style}">${Utils.escapeHtml(chip.name)}</button>`;
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
            <label class="flex cursor-pointer items-center gap-2.5 text-xs font-semibold text-zinc-300">
                <input type="checkbox" ${allChecked ? 'checked' : ''}
                    onchange="app.csvImporter.toggleAll(this.checked)"
                    class="h-4 w-4 rounded border-white/20 bg-white/5 text-indigo-500 focus:ring-indigo-500">
                全選択（選択中 ${checkedCount}件）
            </label>
            <button type="button" onclick="app.csvImporter.selectUnassigned()"
                class="rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-white/15">
                未分類を選択
            </button>
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
            const badge = t.category
                ? `<span class="inline-flex max-w-full items-center gap-1 rounded-full bg-indigo-500/20 px-2 py-0.5 text-xs font-semibold text-indigo-300">
                        <span class="truncate">${Utils.escapeHtml(t.category)}</span>
                        <button type="button" onclick="event.preventDefault(); event.stopPropagation(); app.csvImporter.clearCategory(${t.id})"
                            class="shrink-0 text-indigo-300/70 hover:text-indigo-200">✕</button>
                   </span>`
                : '<span class="rounded-full bg-white/10 px-2 py-0.5 text-xs text-zinc-500">未分類</span>';

            return `
                <label class="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition hover:bg-white/5 ${t.checked ? 'bg-indigo-500/10' : ''}" id="csv-row-${t.id}">
                    <input type="checkbox" ${t.checked ? 'checked' : ''}
                        onchange="app.csvImporter.toggleRow(${t.id}, this.checked)"
                        class="h-4 w-4 shrink-0 rounded border-white/20 bg-white/5 text-indigo-500 focus:ring-indigo-500">
                    <div class="min-w-0 flex-1">
                        <div class="truncate text-sm text-zinc-100">${Utils.escapeHtml(t.store)}</div>
                        <div class="text-xs text-zinc-500">${Utils.escapeHtml(shortDate)}</div>
                    </div>
                    <div class="whitespace-nowrap text-sm font-bold ${amountClass}">¥${Utils.formatCurrency(t.amount)}</div>
                    <div class="w-28 shrink-0 text-right">${badge}</div>
                </label>
            `;
        }).join('');
    }

    /**
     * カテゴリ別の集計プレビューを描画
     * @private
     */
    _renderPreview() {
        const preview = document.getElementById('csvPreview');
        if (!preview) return;

        const total = this.transactions.reduce((sum, t) => sum + t.amount, 0);
        const unassigned = this.transactions.filter(t => !t.category);

        // カテゴリごとに集計
        const groups = {};
        this.transactions.forEach(t => {
            if (!t.category) return;
            if (!groups[t.category]) groups[t.category] = { count: 0, sum: 0 };
            groups[t.category].count++;
            groups[t.category].sum += t.amount;
        });

        const chips = Object.entries(groups).map(([name, g]) =>
            `<span class="rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-xs font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
                ${Utils.escapeHtml(name)} ¥${Utils.formatCurrency(g.sum)}（${g.count}件）
            </span>`
        ).join('');

        const unassignedChip = unassigned.length > 0
            ? `<span class="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs font-semibold text-amber-300 ring-1 ring-inset ring-amber-500/20">
                    未分類 ¥${Utils.formatCurrency(unassigned.reduce((s, t) => s + t.amount, 0))}（${unassigned.length}件）
               </span>`
            : '';

        preview.innerHTML = `
            <div class="mb-2 text-xs font-semibold text-zinc-400">全${this.transactions.length}件 / 合計 ¥${Utils.formatCurrency(total)}</div>
            <div class="flex flex-wrap gap-2">${chips}${unassignedChip}</div>
        `;
    }

    /**
     * インポートボタンの有効/無効を更新
     * @private
     */
    _updateImportButton() {
        const importBtn = document.getElementById('csvImportBtn');
        if (importBtn) {
            importBtn.disabled = !this.transactions.some(t => t.category);
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
        if (row) row.classList.toggle('bg-indigo-500/10', checked);
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
        this.transactions.forEach(t => { t.checked = !t.category; });
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

        checked.forEach(t => {
            t.category = categoryName;
            t.checked = false;
        });

        this._renderAll();
        Utils.showToast(`${checked.length}件を「${categoryName}」に割り当てました`);
        return true;
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

        const assigned = this.transactions.filter(t => t.category);
        if (assigned.length === 0) {
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

        const skipped = this.transactions.length - assigned.length;
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

        // 店名→カテゴリのルールを学習して保存
        assigned.forEach(t => { this.rules[t.store] = t.category; });
        this._saveRules();

        // 取込履歴に記録（次回の二重取込検出用）
        if (this.fileHash) {
            this._recordImport({
                hash: this.fileHash,
                month: monthKey,
                date: Utils.getTodayString(),
                count: assigned.length,
                total: assigned.reduce((s, t) => s + t.amount, 0)
            });
        }

        // 取込先の月に表示を切り替えて保存
        const [year, month] = monthKey.split('-');
        this.budgetManager.currentYear = parseInt(year);
        this.budgetManager.currentMonth = parseInt(month);
        this.budgetManager.saveWithStatus();
        this.budgetManager.updateDisplay();

        Utils.showToast(`${assigned.length}件を${parseInt(month)}月に取り込みました！`);
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
        } else if (category.subcategories.length === 0 && category.amount > 0) {
            // 直接金額を持つカテゴリに小カテゴリーを追加すると合計から漏れるため、
            // 既存金額を小カテゴリーに退避する
            category.subcategories.push({
                id: Utils.generateId(),
                name: '既存分',
                amount: category.amount,
                note: ''
            });
            category.amount = 0;
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

