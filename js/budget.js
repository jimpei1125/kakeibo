/**
 * 家計簿モジュール
 * 予算管理、計算機、CSV出力の機能を提供
 */

import { db, doc, getDoc, setDoc, onSnapshot, collection } from './firebase-config.js';
import { Utils } from './utils.js';
import { Icons } from './icons.js';
import { Dialog } from './dialog.js';
import { buildPie, CATEGORY_COLORS, OTHER_COLOR } from './chart.js';

// ============================================================
// 定数定義
// ============================================================

/** 同期ステータスの自動非表示時間（ミリ秒） */
const SYNC_STATUS_HIDE_DELAY = 2000;

/** 同期ステータスの種類 */
const SYNC_STATUS = {
    SYNCING: 'syncing',
    SYNCED: 'synced',
    ERROR: 'error'
};

// ============================================================
// 計算機クラス
// ============================================================

/**
 * 電卓機能を提供するクラス
 */
export class Calculator {
    constructor() {
        /** @type {string} 現在の計算式 */
        this.expression = '';
    }

    /**
     * 計算機モーダルを表示
     */
    show() {
        Utils.showModal('calculatorModal');
        this.clear();
    }

    /**
     * 計算機モーダルを閉じる
     */
    close() {
        Utils.closeModal('calculatorModal');
    }

    /**
     * 計算式をクリア
     */
    clear() {
        this.expression = '';
        this._updateDisplay('0');
    }

    /**
     * 数字または演算子を追加
     * @param {string} value - 追加する値
     */
    append(value) {
        // 初期状態またはエラー時は入力値で置換
        this.expression = (this.expression === '0' || this.expression === 'エラー') 
            ? value 
            : this.expression + value;
        this._updateDisplay(this.expression);
    }

    /**
     * 計算を実行
     */
    calculate() {
        try {
            const result = Math.round(Calculator.evaluate(this.expression) * 100) / 100;
            this.expression = result.toString();
            this._updateDisplay(result);
        } catch {
            this._updateDisplay('エラー');
            this.expression = 'エラー';
        }
    }

    /**
     * 四則演算式を安全に評価する（evalは使わない）
     * 対応: + - × ÷ * / 括弧 小数 単項マイナス
     * @param {string} expression - 計算式
     * @returns {number} 計算結果
     * @throws {Error} 不正な式の場合
     */
    static evaluate(expression) {
        const tokens = expression
            .replace(/×/g, '*')
            .replace(/÷/g, '/')
            .match(/(?:\d+\.?\d*|\.\d+)|[+\-*/()]/g);
        if (!tokens) throw new Error('式が空です');

        let pos = 0;
        const peek = () => tokens[pos];
        const next = () => tokens[pos++];

        const parseFactor = () => {
            const token = next();
            if (token === '(') {
                const value = parseExpression();
                if (next() !== ')') throw new Error('括弧が閉じられていません');
                return value;
            }
            if (token === '-') return -parseFactor();
            if (token === '+') return parseFactor();
            const num = parseFloat(token);
            if (Number.isNaN(num)) throw new Error('不正なトークン');
            return num;
        };

        const parseTerm = () => {
            let value = parseFactor();
            while (peek() === '*' || peek() === '/') {
                value = next() === '*' ? value * parseFactor() : value / parseFactor();
            }
            return value;
        };

        const parseExpression = () => {
            let value = parseTerm();
            while (peek() === '+' || peek() === '-') {
                value = next() === '+' ? value + parseTerm() : value - parseTerm();
            }
            return value;
        };

        const result = parseExpression();
        if (pos < tokens.length || !Number.isFinite(result)) throw new Error('不正な式');
        return result;
    }

    /**
     * 計算結果をクリップボードにコピー
     */
    copyResult() {
        const result = document.getElementById('calcDisplay')?.textContent;
        if (!result || result === '0' || result === 'エラー') return;
        
        this._copyToClipboard(result)
            .then(() => Utils.showToast('コピーしました！'))
            .catch(() => Utils.showToast('コピーに失敗しました'));
    }

    /**
     * ディスプレイを更新
     * @private
     * @param {string|number} value - 表示する値
     */
    _updateDisplay(value) {
        const display = document.getElementById('calcDisplay');
        if (display) display.textContent = value;
    }

    /**
     * テキストをクリップボードにコピー（レガシーブラウザ対応）
     * @private
     * @param {string} text - コピーするテキスト
     * @returns {Promise<void>}
     */
    async _copyToClipboard(text) {
        // モダンブラウザ
        if (navigator.clipboard?.writeText) {
            return navigator.clipboard.writeText(text);
        }
        // レガシーブラウザ用フォールバック
        const textarea = document.createElement('textarea');
        textarea.value = text;
        Object.assign(textarea.style, { position: 'fixed', opacity: '0' });
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
    }
}

// ============================================================
// CSV出力クラス
// ============================================================

/**
 * 家計簿データをCSV形式でエクスポートするクラス
 */
export class CSVExporter {
    /**
     * @param {BudgetManager} budgetManager - 予算管理インスタンス
     */
    constructor(budgetManager) {
        /** @type {BudgetManager} */
        this.budgetManager = budgetManager;
    }

    /**
     * CSV出力モーダルを表示
     */
    showModal() {
        Utils.showModal('csvModal');
    }

    /**
     * CSV出力モーダルを閉じる
     */
    closeModal() {
        Utils.closeModal('csvModal');
    }

    /**
     * 日付範囲入力の表示を切り替え
     */
    toggleDateRange() {
        const rangeType = document.getElementById('csvRangeType')?.value;
        const dateRangeInputs = document.getElementById('dateRangeInputs');
        if (!dateRangeInputs) return;
        
        if (rangeType === 'range') {
            dateRangeInputs.style.display = 'block';
            const currentMonth = this._getCurrentMonth();
            document.getElementById('csvStartDate').value = currentMonth;
            document.getElementById('csvEndDate').value = currentMonth;
        } else {
            dateRangeInputs.style.display = 'none';
        }
    }

    /**
     * CSVファイルをエクスポート
     */
    export() {
        const rangeType = document.getElementById('csvRangeType')?.value;
        const includeNotes = document.getElementById('csvIncludeNotes')?.checked;
        const includeHalf = document.getElementById('csvIncludeHalf')?.checked;
        
        const monthsToExport = this._getMonthsToExport(rangeType);
        if (!monthsToExport) return;
        
        if (monthsToExport.length === 0) {
            Utils.showToast('出力するデータがありません', 'error');
            return;
        }
        
        const csvContent = this._generateCSV(monthsToExport, includeNotes, includeHalf);
        const filename = this._generateFilename(rangeType);
        this._downloadCSV(csvContent, filename);
        
        Utils.showToast('CSVファイルをダウンロードしました');
        this.closeModal();
    }

    /**
     * 現在の年月を取得
     * @private
     * @returns {string} YYYY-MM形式
     */
    _getCurrentMonth() {
        const today = new Date();
        return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    }

    /**
     * エクスポート対象の月を取得
     * @private
     * @param {string} rangeType - 範囲タイプ
     * @returns {string[]|null} 月のキー配列
     */
    _getMonthsToExport(rangeType) {
        const budgetData = this.budgetManager.data;
        
        switch (rangeType) {
            case 'current':
                return [this.budgetManager.getCurrentMonthKey()];
            case 'all':
                return Object.keys(budgetData).sort();
            case 'range':
                return this._getDateRangeMonths(budgetData);
            default:
                return [];
        }
    }

    /**
     * 日付範囲から対象月を取得
     * @private
     * @param {Object} budgetData - 予算データ
     * @returns {string[]|null}
     */
    _getDateRangeMonths(budgetData) {
        const startDate = document.getElementById('csvStartDate')?.value;
        const endDate = document.getElementById('csvEndDate')?.value;
        
        if (!startDate || !endDate) {
            Utils.showToast('開始年月と終了年月を選択してください', 'error');
            return null;
        }

        const start = new Date(`${startDate}-01`);
        const end = new Date(`${endDate}-01`);

        if (start > end) {
            Utils.showToast('開始年月は終了年月より前に設定してください', 'error');
            return null;
        }
        
        return Object.keys(budgetData)
            .filter(key => {
                const date = new Date(`${key}-01`);
                return date >= start && date <= end;
            })
            .sort();
    }

    /**
     * CSV文字列を生成
     * @private
     * @param {string[]} months - 対象月
     * @param {boolean} includeNotes - 備考を含むか
     * @param {boolean} includeHalf - 折半金額を含むか
     * @returns {string} CSV文字列
     */
    _generateCSV(months, includeNotes, includeHalf) {
        // BOM付きUTF-8
        let csv = '\uFEFF';
        
        // ヘッダー
        const headers = ['年月', '大カテゴリー', '小カテゴリー', '金額'];
        if (includeHalf) headers.push('折半金額');
        if (includeNotes) headers.push('備考');
        csv += headers.join(',') + '\n';
        
        // データ行
        months.forEach(monthKey => {
            const monthData = this.budgetManager.data[monthKey];
            if (!monthData?.categories) return;
            
            monthData.categories.forEach(category => {
                if (category.subcategories?.length > 0) {
                    category.subcategories.forEach(sub => {
                        csv += this._formatRow(monthKey, category.name, sub.name, sub.amount, sub.note, includeHalf, includeNotes);
                    });
                } else {
                    csv += this._formatRow(monthKey, category.name, '', category.amount, category.note, includeHalf, includeNotes);
                }
            });
        });
        
        return csv;
    }

    /**
     * CSV行を生成
     * @private
     */
    _formatRow(month, category, subcategory, amount, note, includeHalf, includeNotes) {
        const row = [month, this._quote(category), this._quote(subcategory), amount || 0];
        if (includeHalf) row.push(Math.round((amount || 0) / 2));
        if (includeNotes) row.push(this._quote(note));
        return row.join(',') + '\n';
    }

    /**
     * CSVフィールドをクォート（内部のダブルクォートをエスケープ）
     * @private
     * @param {*} value - フィールド値
     * @returns {string}
     */
    _quote(value) {
        return `"${String(value ?? '').replace(/"/g, '""')}"`;
    }

    /**
     * ファイル名を生成
     * @private
     * @param {string} rangeType - 範囲タイプ
     * @returns {string}
     */
    _generateFilename(rangeType) {
        switch (rangeType) {
            case 'current':
                return `家計簿_${this.budgetManager.getCurrentMonthKey()}.csv`;
            case 'all':
                return '家計簿_全期間.csv';
            case 'range':
                const start = document.getElementById('csvStartDate')?.value;
                const end = document.getElementById('csvEndDate')?.value;
                return `家計簿_${start}_${end}.csv`;
            default:
                return '家計簿.csv';
        }
    }

    /**
     * CSVファイルをダウンロード
     * @private
     * @param {string} content - CSV内容
     * @param {string} filename - ファイル名
     */
    _downloadCSV(content, filename) {
        const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    }
}

// ============================================================
// CSVインポートクラス
// ============================================================

/** カテゴリ候補のデフォルト値（既存カテゴリ・学習済みルールに追加で表示） */
const DEFAULT_CATEGORY_SUGGESTIONS = ['食費', '日用品', '外食', '光熱費', '通信費', '交際費', 'その他'];

/**
 * クレジットカード明細CSVを読み込み、明細ごとにカテゴリを割り当てて
 * 家計簿に取り込むクラス
 *
 * フロー:
 * 1. CSVファイル選択 → 明細（利用日/店名/金額）を一覧表示
 * 2. 明細にチェックを入れ、カテゴリチップをタップして割り当て
 * 3. 取込先の月（「当月お支払日」から自動設定）を確認してインポート
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
     * 文字列のSHA-256ハッシュ（16進）を計算
     * @private
     * @param {string} text
     * @returns {Promise<string>}
     */
    async _sha256(text) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
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
     * CSVファイルが選択されたときの処理
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

        if (!file.name.toLowerCase().endsWith('.csv')) {
            Utils.showToast('CSVファイルを選択してください', 'error');
            return;
        }

        try {
            Utils.showToast('CSV読み込み中...');
            const content = await this._readFile(file);
            this.fileHash = await this._sha256(content);
            this._parseTransactions(content);
            this._setupImportUI();

            const autoAssigned = this.transactions.filter(t => t.category).length;
            Utils.showToast(autoAssigned > 0
                ? `${this.transactions.length}件読み込み（${autoAssigned}件を自動分類）`
                : `${this.transactions.length}件読み込みました`);
        } catch (error) {
            console.error('CSV読み込みエラー:', error);
            Utils.showToast(`CSVファイルの読み込みに失敗しました: ${error.message}`, 'error');
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
                ? '※ CSVの「当月お支払日」から自動設定しています'
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

// ============================================================
// 月間コピークラス
// ============================================================

/**
 * 他の月のカテゴリーを選んで今月に追加するクラス
 * （上書きではなく追加。金額を引き継ぐか項目だけコピーするかを選択可能）
 */
export class CopyMonthManager {
    /**
     * @param {BudgetManager} budgetManager - 予算管理インスタンス
     */
    constructor(budgetManager) {
        /** @type {BudgetManager} */
        this.budgetManager = budgetManager;
        /** @type {Array<{id: number, name: string, amount: number, budget: number, note: string, subcategories: Array, checked: boolean, duplicate: boolean}>} コピー元カテゴリの表示用リスト */
        this.items = [];
    }

    /**
     * コピー元月選択のデフォルト値（前月）を計算
     * @private
     * @returns {string} YYYY-MM形式
     */
    _getDefaultSourceMonth() {
        let month = this.budgetManager.currentMonth - 1;
        let year = this.budgetManager.currentYear;
        if (month < 1) {
            month = 12;
            year--;
        }
        return Utils.getMonthKey(year, month);
    }

    /**
     * モーダルを表示
     */
    showModal() {
        const sourceInput = document.getElementById('copyMonthSource');
        if (sourceInput) sourceInput.value = this._getDefaultSourceMonth();

        const keepAmount = document.getElementById('copyMonthKeepAmount');
        if (keepAmount) keepAmount.checked = true;

        Utils.showModal('copyMonthModal');
        this._buildList();
    }

    /**
     * モーダルを閉じる
     */
    closeModal() {
        Utils.closeModal('copyMonthModal');
    }

    /**
     * コピー元の月が変更されたときの処理
     */
    onSourceChange() {
        this._buildList();
    }

    /**
     * オプション（金額を引き継ぐか）が変更されたときの処理
     */
    onOptionsChange() {
        this._renderList();
    }

    /**
     * コピー元月のカテゴリ一覧を構築
     * @private
     */
    _buildList() {
        const sourceKey = document.getElementById('copyMonthSource')?.value;
        const sourceData = sourceKey ? this.budgetManager.data[sourceKey] : null;
        const currentNames = new Set(
            this.budgetManager.getCurrentMonthData().categories.map(c => c.name)
        );

        this.items = (sourceData?.categories || []).map(cat => {
            const amount = cat.subcategories.length > 0
                ? cat.subcategories.reduce((sum, sub) => sum + (sub.amount || 0), 0)
                : (cat.amount || 0);
            return {
                id: cat.id,
                name: cat.name,
                amount,
                budget: cat.budget || 0,
                note: cat.note || '',
                subcategories: cat.subcategories,
                checked: !currentNames.has(cat.name),
                duplicate: currentNames.has(cat.name)
            };
        });

        this._renderList();
    }

    /**
     * 一覧・ツールバー・実行ボタンを再描画
     * @private
     */
    _renderList() {
        const listSection = document.getElementById('copyMonthListSection');
        const emptyEl = document.getElementById('copyMonthEmpty');

        if (this.items.length === 0) {
            if (listSection) listSection.style.display = 'none';
            if (emptyEl) emptyEl.style.display = 'block';
            this._updateExecuteButton();
            return;
        }

        if (listSection) listSection.style.display = 'block';
        if (emptyEl) emptyEl.style.display = 'none';

        this._renderToolbar();
        this._renderItems();
        this._updateExecuteButton();
    }

    /**
     * ツールバー（全選択・選択件数）を描画
     * @private
     */
    _renderToolbar() {
        const toolbar = document.getElementById('copyMonthToolbar');
        if (!toolbar) return;

        const checkedCount = this.items.filter(i => i.checked).length;
        const allChecked = checkedCount === this.items.length && this.items.length > 0;

        toolbar.innerHTML = `
            <label class="flex cursor-pointer items-center gap-2.5 text-xs font-semibold text-zinc-300">
                <input type="checkbox" ${allChecked ? 'checked' : ''}
                    onchange="app.copyMonth.toggleAll(this.checked)"
                    class="h-4 w-4 rounded border-white/20 bg-white/5 text-indigo-500 focus:ring-indigo-500">
                全選択（選択中 ${checkedCount}件）
            </label>
        `;
    }

    /**
     * 項目一覧を描画
     * @private
     */
    _renderItems() {
        const listEl = document.getElementById('copyMonthList');
        if (!listEl) return;

        const keepAmount = document.getElementById('copyMonthKeepAmount')?.checked ?? true;

        listEl.innerHTML = this.items.map((item, index) => {
            const subCount = item.subcategories.length > 0
                ? `<span class="ml-1.5 text-zinc-500">(小${item.subcategories.length}件)</span>`
                : '';
            const displayAmount = keepAmount ? item.amount : 0;
            const badge = item.duplicate
                ? `<span class="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-400/10 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
                        <span data-icon="alert-circle"></span>今月に同名あり
                   </span>`
                : '';

            return `
                <label class="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition hover:bg-white/5">
                    <input type="checkbox" ${item.checked ? 'checked' : ''}
                        onchange="app.copyMonth.toggleItem(${index}, this.checked)"
                        class="h-4 w-4 shrink-0 rounded border-white/20 bg-white/5 text-indigo-500 focus:ring-indigo-500">
                    <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center text-sm text-zinc-100">
                            <span class="truncate">${Utils.escapeHtml(item.name)}</span>${subCount}${badge}
                        </div>
                    </div>
                    <div class="whitespace-nowrap text-sm font-bold text-white">¥${Utils.formatCurrency(displayAmount)}</div>
                </label>
            `;
        }).join('');

        // data-icon をSVGへ展開（一覧を動的生成しているため個別にhydrate）
        Icons.hydrate(listEl);
    }

    /**
     * 実行ボタンの有効/無効・ラベルを更新
     * @private
     */
    _updateExecuteButton() {
        const btn = document.getElementById('copyMonthExecuteBtn');
        const label = document.getElementById('copyMonthExecuteLabel');
        const checkedCount = this.items.filter(i => i.checked).length;

        if (btn) btn.disabled = checkedCount === 0;
        if (label) label.textContent = checkedCount > 0
            ? `選択した${checkedCount}件を今月に追加`
            : '選択した項目を今月に追加';
    }

    /**
     * 全項目のチェック状態を一括切り替え
     * @param {boolean} checked
     */
    toggleAll(checked) {
        this.items.forEach(item => { item.checked = checked; });
        this._renderList();
    }

    /**
     * 項目のチェック状態を切り替え
     * @param {number} index - itemsのインデックス
     * @param {boolean} checked
     */
    toggleItem(index, checked) {
        if (this.items[index]) this.items[index].checked = checked;
        this._renderToolbar();
        this._updateExecuteButton();
    }

    /**
     * 選択したカテゴリを今月に追加する（既存カテゴリは維持＝追加方式）
     */
    execute() {
        const checked = this.items.filter(i => i.checked);
        if (checked.length === 0) return;

        const keepAmount = document.getElementById('copyMonthKeepAmount')?.checked ?? true;
        const currentData = this.budgetManager.getCurrentMonthData();

        const newCategories = checked.map(item => {
            const subcategories = item.subcategories.map(sub => ({
                id: Utils.generateId(),
                name: sub.name,
                amount: keepAmount ? (sub.amount || 0) : 0,
                note: sub.note || ''
            }));

            return {
                id: Utils.generateId(),
                name: item.name,
                amount: keepAmount ? (subcategories.length > 0 ? 0 : item.amount) : 0,
                budget: item.budget || 0,
                note: item.note,
                subcategories
            };
        });

        currentData.categories = [...currentData.categories, ...newCategories];
        this.budgetManager.updateDisplay();
        this.budgetManager.saveWithStatus();

        Utils.showToast(`${checked.length}件を追加しました`);
        this.closeModal();
    }
}

// ============================================================
// 予算管理クラス
// ============================================================

/**
 * 家計簿の予算管理を行うメインクラス
 */
export class BudgetManager {
    constructor() {
        const now = new Date();
        /** @type {number} 現在表示中の年 */
        this.currentYear = now.getFullYear();
        /** @type {number} 現在表示中の月 */
        this.currentMonth = now.getMonth() + 1;
        /** @type {Object} 全予算データ（月キー→月データ） */
        this.data = {};
        /** @type {boolean} 初回読み込みフラグ */
        this.isInitialLoad = true;
        /** @type {boolean} クイック入力モード */
        this.quickInputMode = false;
        /** @type {boolean} 旧形式データの移行チェック済みフラグ */
        this._migrationChecked = false;
        /** @type {boolean} 合計カードが円グラフ面を表示中か */
        this.totalFlipped = false;
        /** @type {boolean} 明細のドラッグ並び替え中か（同期による再描画をスキップする） */
        this._reordering = false;
    }

    // ----------------------------------------
    // クイック入力モード
    // ----------------------------------------

    /**
     * クイック入力モードを切り替え
     */
    toggleQuickInputMode() {
        this.quickInputMode = !this.quickInputMode;
        
        // モード終了時は全体を再描画して最新状態に
        this.updateDisplay();
        
        // フッターのボタン状態を更新
        const footerBtn = document.getElementById('footerQuickInput');
        if (footerBtn) {
            footerBtn.classList.toggle('active', this.quickInputMode);
            // アイコンは維持し、ラベルのみ差し替え
            const label = footerBtn.querySelector('.nav-label');
            if (label) label.textContent = this.quickInputMode ? 'ON' : 'クイック入力';
        }
        
        if (this.quickInputMode) {
            Utils.showToast('クイック入力モード ON');
            // 最初の入力欄にフォーカス
            setTimeout(() => {
                const firstInput = document.querySelector('.quick-input-field');
                if (firstInput) firstInput.focus();
            }, 100);
        } else {
            Utils.showToast('クイック入力モード OFF');
        }
    }

    /**
     * クイック入力のフォームsubmit処理
     * @param {string} categoryIdStr - カテゴリID（安全な文字列形式）
     * @param {string|null} subIdStr - サブカテゴリID（安全な文字列形式）
     * @param {Event} event - submitイベント
     * @returns {boolean} false（フォーム送信を防止）
     */
    quickInputSubmit(categoryIdStr, subIdStr, event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        this.quickAddAmount(categoryIdStr, subIdStr);
        return false;
    }

    /**
     * クイック入力で金額を追加
     * @param {string} categoryIdStr - カテゴリID（安全な文字列形式、ハイフン区切り）
     * @param {string|null} subIdStr - サブカテゴリID（安全な文字列形式）
     */
    quickAddAmount(categoryIdStr, subIdStr = null) {
        // 安全な文字列IDから元のIDを復元（ハイフンを小数点に戻す）
        const categoryId = parseFloat(String(categoryIdStr).replaceAll('-', '.'));
        const subId = subIdStr ? parseFloat(String(subIdStr).replaceAll('-', '.')) : null;

        const inputId = subIdStr ? `quick-sub-${categoryIdStr}-${subIdStr}` : `quick-${categoryIdStr}`;
        const input = document.getElementById(inputId);

        if (!input) {
            Utils.showToast('エラー: 入力欄が見つかりません');
            return;
        }

        const amount = parseFloat(input.value);
        if (!amount || isNaN(amount)) {
            Utils.showToast('金額を入力してください');
            return;
        }

        const category = this._findCategory(categoryId);
        if (!category) {
            Utils.showToast('エラー: カテゴリが見つかりません');
            return;
        }

        if (subId) {
            const sub = category.subcategories.find(s => s.id === subId);
            if (sub) {
                sub.amount = (sub.amount || 0) + amount;
                // サブカテゴリの金額表示を部分更新
                const subAmountInput = document.getElementById(`subamount-${categoryId}-${subId}`);
                if (subAmountInput) subAmountInput.value = sub.amount;
            }
        } else {
            category.amount = (category.amount || 0) + amount;
            // カテゴリの金額表示を部分更新
            const amountInput = document.getElementById(`amount-${categoryId}`);
            if (amountInput) amountInput.value = category.amount;
        }

        // サマリーと合計の表示を部分更新（DOM全体は再描画しない＝フォーカス維持）
        this._updateCategorySummaryAmount(categoryId);
        this._updateTotalDisplay();

        // 入力欄をクリア（フォーカスは維持）
        input.value = '';

        // 成功フィードバック
        input.classList.add('quick-input-success');
        setTimeout(() => input.classList.remove('quick-input-success'), 300);

        Utils.showToast(`+¥${Utils.formatCurrency(amount)} 追加`);

        // Firestoreに保存（スナップショット受信時の再描画はクイック入力中スキップされる）
        this.saveToFirestore();
    }
    
    /**
     * カテゴリサマリーの金額表示を更新
     * @private
     */
    _updateCategorySummaryAmount(categoryId) {
        const category = this._findCategory(categoryId);
        if (!category) return;
        
        const subTotal = category.subcategories.reduce((sum, sub) => sum + (sub.amount || 0), 0);
        const displayAmount = category.subcategories.length > 0 ? subTotal : category.amount;
        
        // icon要素からサマリー行を取得（getElementByIdは小数点を含むIDでも動作）
        const iconEl = document.getElementById(`icon-${categoryId}`);
        if (iconEl) {
            const summaryEl = iconEl.closest('.category-summary');
            if (summaryEl) {
                const amountEl = summaryEl.querySelector('.category-summary-amount');
                if (amountEl) {
                    amountEl.textContent = `${Utils.formatCurrency(displayAmount)}円`;
                }
            }
        }
    }
    
    /**
     * 合計金額の表示を更新
     * @private
     */
    _updateTotalDisplay() {
        const total = this.calculateTotal();
        const half = Math.round(total / 2);
        
        const totalEl = document.getElementById('totalAmount');
        const halfEl = document.getElementById('halfAmount');
        const outputEl = document.getElementById('outputText');
        
        if (totalEl) totalEl.textContent = `¥${Utils.formatCurrency(total)}`;
        if (halfEl) halfEl.textContent = `折半: ¥${Utils.formatCurrency(half)}`;
        if (outputEl) outputEl.textContent = this.generateOutput();

        // ミニヘッダーの合計額も追従
        const miniTotalEl = document.getElementById('miniHeaderTotal');
        if (miniTotalEl) miniTotalEl.textContent = `¥${Utils.formatCurrency(total)}`;

        // 円グラフ面を表示中ならグラフも更新
        if (this.totalFlipped) this.renderPie();
    }

    // ----------------------------------------
    // データアクセス
    // ----------------------------------------

    /**
     * 現在の年月キーを取得
     * @returns {string} YYYY-MM形式
     */
    getCurrentMonthKey() {
        return Utils.getMonthKey(this.currentYear, this.currentMonth);
    }

    /**
     * 指定した月のデータを取得（なければ初期化）
     * @param {string} monthKey - YYYY-MM形式の月キー
     * @returns {Object} 月データ
     */
    getMonthData(monthKey) {
        if (!this.data[monthKey]) {
            this.data[monthKey] = { categories: [] };
        }
        return this.data[monthKey];
    }

    /**
     * 現在の月のデータを取得（なければ初期化）
     * @returns {Object} 月データ
     */
    getCurrentMonthData() {
        return this.getMonthData(this.getCurrentMonthKey());
    }

    // ----------------------------------------
    // 同期ステータス
    // ----------------------------------------

    /**
     * 同期ステータスを表示
     * @param {string} status - syncing|synced|error
     * @param {string} message - 表示メッセージ
     */
    showSyncStatus(status, message) {
        const statusEl = document.getElementById('syncStatus');
        if (!statusEl) return;
        
        statusEl.className = `sync-status ${status}`;
        statusEl.textContent = message;
        statusEl.style.display = 'block';
    }

    /**
     * 同期ステータスを自動で非表示に
     * @private
     */
    _hideSyncStatusAfterDelay() {
        setTimeout(() => {
            const statusEl = document.getElementById('syncStatus');
            if (statusEl?.textContent === '✓ 同期完了') {
                statusEl.style.display = 'none';
            }
        }, SYNC_STATUS_HIDE_DELAY);
    }

    // ----------------------------------------
    // Firestore操作
    // ----------------------------------------

    /**
     * Firestoreにデータを保存（現在表示中の月のドキュメントのみ）
     *
     * 全月を1ドキュメントに一括保存する旧方式は、複数端末の同時編集や
     * 古い端末からの保存で他の月のデータまで巻き戻る危険があったため、
     * 編集対象の月だけを budgetMonths/{YYYY-MM} に保存する方式に変更。
     */
    async saveToFirestore() {
        const monthKey = this.getCurrentMonthKey();
        const monthData = this.data[monthKey] || { categories: [] };
        try {
            await setDoc(doc(db, 'budgetMonths', monthKey), monthData);
            this.showSyncStatus(SYNC_STATUS.SYNCED, '✓ 同期完了');
            this._hideSyncStatusAfterDelay();
        } catch (error) {
            console.error('Firestore保存エラー:', error);
            this.showSyncStatus(SYNC_STATUS.ERROR, `✗ 同期エラー: ${error.message}`);
        }
    }

    /**
     * Firestoreからデータをリアルタイム購読（budgetMonthsコレクション全体）
     */
    loadFromFirestore() {
        onSnapshot(
            collection(db, 'budgetMonths'),
            (snap) => this._handleMonthsSnapshot(snap),
            (error) => {
                console.error('Firestore読み込みエラー:', error);
                this.showSyncStatus(SYNC_STATUS.ERROR, `✗ 接続エラー: ${error.message}`);
            }
        );
    }

    /**
     * 月コレクションのスナップショット受信時の処理
     * @private
     * @param {Object} snap - QuerySnapshot
     */
    _handleMonthsSnapshot(snap) {
        // コレクション全体から月データを再構築
        const newData = {};
        snap.forEach(docSnap => {
            newData[docSnap.id] = docSnap.data();
        });
        this.data = newData;

        // 初回かつ空 → 旧形式（budgetData/data）からの移行を試みる
        if (this.isInitialLoad && snap.empty && !this._migrationChecked) {
            this._migrationChecked = true;
            this._migrateLegacyData();
            return; // 移行後にsnapshotが再発火するのでここでは描画しない
        }

        // クイック入力中・ドラッグ並び替え中はDOM再描画をスキップ
        // （フォーカス維持／ドラッグ中の行が消えるのを防ぐ）
        if (!this.quickInputMode && !this._reordering) {
            this.updateDisplay();
        }

        if (this.isInitialLoad) {
            this.updateDisplay(); // 初回は必ず描画
            this._finishInitialLoad('✓ データ読み込み完了');
        }
    }

    /**
     * 旧形式データ（budgetData/data の全月一括ドキュメント）を
     * 月別ドキュメント（budgetMonths/{YYYY-MM}）へ移行する（初回のみ）
     * @private
     */
    async _migrateLegacyData() {
        const legacyRef = doc(db, 'budgetData', 'data');
        try {
            const legacy = await getDoc(legacyRef);

            // 既に移行済みマークがあれば何もしない（削除済みデータの復活を防ぐ）
            if (legacy.exists() && legacy.data().migrated) {
                this._finishInitialLoad('✓ 接続完了');
                return;
            }

            const legacyMonths = legacy.exists() ? legacy.data().data : null;
            if (legacyMonths && Object.keys(legacyMonths).length > 0) {
                // 各月を個別ドキュメントとして書き込み
                for (const monthKey of Object.keys(legacyMonths)) {
                    await setDoc(doc(db, 'budgetMonths', monthKey), legacyMonths[monthKey]);
                }
                // 再移行を防ぐマークを付与（元データはバックアップとして残す）
                await setDoc(legacyRef, { migrated: true }, { merge: true });
                Utils.showToast('データを新形式に移行しました');
                // 書き込みによりコレクションのsnapshotが再発火し、そこで描画される
            } else {
                // 移行元データなし → マークだけ付けて空表示
                if (legacy.exists()) {
                    await setDoc(legacyRef, { migrated: true }, { merge: true });
                }
                this._finishInitialLoad('✓ 接続完了（データなし）');
            }
        } catch (error) {
            console.error('データ移行エラー:', error);
            // 移行に失敗しても空データで初期表示は完了させる
            this._finishInitialLoad('✓ 接続完了');
        }
    }

    /**
     * 初回読み込み完了処理（同期ステータス表示と自動非表示）
     * @private
     * @param {string} message - 表示メッセージ
     */
    _finishInitialLoad(message) {
        this.showSyncStatus(SYNC_STATUS.SYNCED, message);
        this.isInitialLoad = false;
        setTimeout(() => {
            const statusEl = document.getElementById('syncStatus');
            if (statusEl) statusEl.style.display = 'none';
        }, SYNC_STATUS_HIDE_DELAY);
    }

    // ----------------------------------------
    // 月切り替え
    // ----------------------------------------

    /**
     * 月を変更
     * @param {number} delta - 増減値（-1: 前月, 1: 翌月）
     */
    changeMonth(delta) {
        this.currentMonth += delta;

        // 年をまたぐ処理
        if (this.currentMonth > 12) {
            this.currentMonth = 1;
            this.currentYear++;
        } else if (this.currentMonth < 1) {
            this.currentMonth = 12;
            this.currentYear--;
        }

        // 月を切り替えたら合計カードは表（合計金額）に戻す
        this._resetTotalView();
        this._animateMonthChange();
    }

    /**
     * 月切り替え時のアニメーション
     * @private
     */
    _animateMonthChange() {
        const monthDisplay = document.getElementById('currentMonth');
        if (!monthDisplay) return;
        
        monthDisplay.style.opacity = '0';
        monthDisplay.style.transform = 'scale(0.9)';
        
        setTimeout(() => {
            this.updateDisplay();
            monthDisplay.style.transition = 'all 0.3s ease';
            monthDisplay.style.opacity = '1';
            monthDisplay.style.transform = 'scale(1)';
        }, 150);
    }

    // ----------------------------------------
    // カテゴリ操作
    // ----------------------------------------

    /**
     * カテゴリー追加シートを表示
     */
    showAddCategorySheet() {
        Utils.showModal('addCategorySheet');
        // シートのスライドインが終わる頃に名前欄へフォーカス（即入力できるように）
        setTimeout(() => document.getElementById('newCategoryName')?.focus(), 150);
    }

    /**
     * カテゴリー追加シートを閉じる
     */
    closeAddCategorySheet() {
        Utils.closeModal('addCategorySheet');
        this._clearInputFields(['newCategoryName', 'newCategoryAmount', 'newCategoryBudget', 'newCategoryNote']);
    }

    /**
     * 新規カテゴリを追加
     */
    addCategory() {
        const name = document.getElementById('newCategoryName')?.value.trim();
        const amount = document.getElementById('newCategoryAmount')?.value;
        const budget = document.getElementById('newCategoryBudget')?.value;
        const note = document.getElementById('newCategoryNote')?.value.trim();

        if (!name) {
            Utils.showToast('カテゴリー名を入力してください', 'error');
            return;
        }

        this.getCurrentMonthData().categories.push({
            id: Utils.generateId(),
            name,
            amount: amount ? parseFloat(amount) : 0,
            budget: budget ? parseFloat(budget) : 0,
            note: note || '',
            subcategories: []
        });

        this.closeAddCategorySheet();
        this.saveWithStatus();
    }

    /**
     * カテゴリを削除
     * @param {number} categoryId - カテゴリID
     */
    async deleteCategory(categoryId) {
        const confirmed = await Dialog.confirm('このカテゴリーを削除しますか？', { okLabel: '削除', danger: true });
        if (!confirmed) return;

        const monthData = this.getCurrentMonthData();
        monthData.categories = monthData.categories.filter(c => c.id !== categoryId);
        this.saveWithStatus();
    }

    /**
     * カテゴリ名を編集
     * @param {number} categoryId - カテゴリID
     */
    async editCategory(categoryId) {
        const category = this._findCategory(categoryId);
        if (!category) return;

        const newName = await Dialog.prompt('カテゴリー名を入力:', category.name);
        if (newName?.trim()) {
            category.name = newName.trim();
            this.saveWithStatus();
        }
    }

    // ----------------------------------------
    // サブカテゴリ操作
    // ----------------------------------------

    /**
     * サブカテゴリを追加
     * @param {number} categoryId - 親カテゴリID
     */
    addSubcategory(categoryId) {
        const name = document.getElementById(`subname-${categoryId}`)?.value.trim();
        const amount = document.getElementById(`subamount-${categoryId}`)?.value;
        const note = document.getElementById(`subnote-${categoryId}`)?.value.trim();

        if (!name) {
            Utils.showToast('項目名を入力してください', 'error');
            return;
        }

        const category = this._findCategory(categoryId);
        if (!category) return;
        
        category.subcategories.push({
            id: Utils.generateId(),
            name,
            amount: amount ? parseFloat(amount) : 0,
            note: note || ''
        });

        this._clearInputFields([
            `subname-${categoryId}`,
            `subamount-${categoryId}`,
            `subnote-${categoryId}`
        ]);
        this.saveWithStatus();
    }

    /**
     * サブカテゴリを削除
     * @param {number} categoryId - 親カテゴリID
     * @param {number} subcategoryId - サブカテゴリID
     */
    async deleteSubcategory(categoryId, subcategoryId) {
        const confirmed = await Dialog.confirm('この項目を削除しますか？', { okLabel: '削除', danger: true });
        if (!confirmed) return;

        const category = this._findCategory(categoryId);
        if (!category) return;

        category.subcategories = category.subcategories.filter(s => s.id !== subcategoryId);
        this.saveWithStatus();
    }

    /**
     * サブカテゴリ名を編集
     * @param {number} categoryId - 親カテゴリID
     * @param {number} subcategoryId - サブカテゴリID
     */
    async editSubcategory(categoryId, subcategoryId) {
        const category = this._findCategory(categoryId);
        const subcategory = category?.subcategories.find(s => s.id === subcategoryId);
        if (!subcategory) return;

        const newName = await Dialog.prompt('項目名を入力:', subcategory.name);
        if (newName?.trim()) {
            subcategory.name = newName.trim();
            this.saveWithStatus();
        }
    }

    // ----------------------------------------
    // 金額・備考の更新
    // ----------------------------------------

    /**
     * 金額を更新
     * @param {number} categoryId - カテゴリID
     * @param {number|null} subcategoryId - サブカテゴリID（カテゴリ直接の場合はnull）
     */
    updateAmount(categoryId, subcategoryId) {
        const category = this._findCategory(categoryId);
        if (!category) return;

        if (subcategoryId === null) {
            const input = document.getElementById(`amount-${categoryId}`);
            category.amount = parseFloat(input?.value) || 0;
        } else {
            const subcategory = category.subcategories.find(s => s.id === subcategoryId);
            if (subcategory) {
                const input = document.getElementById(`subamount-${categoryId}-${subcategoryId}`);
                subcategory.amount = parseFloat(input?.value) || 0;
            }
        }
        this.saveWithStatus();
        Utils.showToast('保存しました');
    }

    /**
     * カテゴリの予算額を更新
     * @param {number} categoryId - カテゴリID
     */
    updateBudget(categoryId) {
        const category = this._findCategory(categoryId);
        if (!category) return;

        const input = document.getElementById(`budget-${categoryId}`);
        category.budget = parseFloat(input?.value) || 0;

        this.saveWithStatus();
        Utils.showToast('保存しました');
    }

    /**
     * 備考を更新
     * @param {number} categoryId - カテゴリID
     * @param {number|null} subcategoryId - サブカテゴリID
     */
    updateNote(categoryId, subcategoryId) {
        const category = this._findCategory(categoryId);
        if (!category) return;

        if (subcategoryId === null) {
            const input = document.getElementById(`note-${categoryId}`);
            category.note = input?.value.trim() || '';
        } else {
            const subcategory = category.subcategories.find(s => s.id === subcategoryId);
            if (subcategory) {
                const input = document.getElementById(`subnote-edit-${categoryId}-${subcategoryId}`);
                subcategory.note = input?.value.trim() || '';
            }
        }
        this.saveWithStatus();
        Utils.showToast('保存しました');
    }

    // ----------------------------------------
    // アコーディオン
    // ----------------------------------------

    /**
     * アコーディオンの開閉を切り替え
     * @param {number} categoryId - カテゴリID
     */
    toggleAccordion(categoryId) {
        const details = document.getElementById(`details-${categoryId}`);
        const icon = document.getElementById(`icon-${categoryId}`);

        details?.classList.toggle('open');
        icon?.classList.toggle('open');
    }

    // ----------------------------------------
    // 明細の並び替え（ドラッグハンドル）
    // ----------------------------------------

    /**
     * 大カテゴリーの並び替えドラッグを開始
     * @param {PointerEvent} event
     * @param {number} categoryId
     */
    startCategoryDrag(event, categoryId) {
        const container = document.getElementById('categoryList');
        const item = container?.querySelector(`.category-item[data-cat-id="${categoryId}"]`);
        if (!container || !item) return;

        // ドラッグ開始時は全アコーディオンを閉じて高さを揃える（並び替え中の見た目を安定させるため）
        container.querySelectorAll('.category-details.open').forEach(el => el.classList.remove('open'));
        container.querySelectorAll('.accordion-icon.open').forEach(el => el.classList.remove('open'));

        this._beginDrag(event, {
            container,
            item,
            itemSelector: '.category-item',
            onDrop: (fromIndex, toIndex) => {
                const monthData = this.getCurrentMonthData();
                const [moved] = monthData.categories.splice(fromIndex, 1);
                monthData.categories.splice(toIndex, 0, moved);
                this.updateDisplay();
                this.saveWithStatus();
            }
        });
    }

    /**
     * 小カテゴリーの並び替えドラッグを開始
     * @param {PointerEvent} event
     * @param {number} categoryId - 親カテゴリID
     * @param {number} subId - 小カテゴリID
     */
    startSubcategoryDrag(event, categoryId, subId) {
        const container = document.getElementById(`sublist-${categoryId}`);
        const item = container?.querySelector(`.subcategory-item[data-sub-id="${subId}"]`);
        if (!container || !item) return;

        this._beginDrag(event, {
            container,
            item,
            itemSelector: '.subcategory-item',
            onDrop: (fromIndex, toIndex) => {
                const category = this._findCategory(categoryId);
                if (!category) return;
                const [moved] = category.subcategories.splice(fromIndex, 1);
                category.subcategories.splice(toIndex, 0, moved);
                // 親カテゴリの開閉状態を保ったまま、サブカテゴリ一覧だけ再描画
                container.innerHTML = this._renderSubcategoryItems(category);
                this.saveWithStatus();
            }
        });
    }

    /**
     * ポインタードラッグによる並び替えの汎用エンジン
     * グリップ（onpointerdown）から呼ばれ、ポインター移動に追従して対象要素を
     * 視覚的に移動させ、通過した兄弟要素をtransformで滑らかに詰める。
     * 指を離した時点の順序を onDrop(fromIndex, toIndex) に渡す。
     * @private
     * @param {PointerEvent} event
     * @param {{container: HTMLElement, item: HTMLElement, itemSelector: string, onDrop: Function}} config
     */
    _beginDrag(event, { container, item, itemSelector, onDrop }) {
        event.preventDefault();
        const grip = event.currentTarget;
        const pointerId = event.pointerId;

        const items = Array.from(container.querySelectorAll(`:scope > ${itemSelector}`));
        const fromIndex = items.indexOf(item);
        if (fromIndex === -1) return;

        const rects = items.map(el => el.getBoundingClientRect());
        const step = items.length > 1
            ? rects[1].top - rects[0].top
            : rects[0].height + 10;

        this._reordering = true;
        item.classList.add('dragging');
        document.body.classList.add('reorder-active');

        const startY = event.clientY;
        let currentIndex = fromIndex;

        const move = (e) => {
            const dy = e.clientY - startY;
            item.style.transform = `translateY(${dy}px)`;

            const rawIndex = fromIndex + Math.round(dy / step);
            const newIndex = Math.max(0, Math.min(items.length - 1, rawIndex));
            if (newIndex === currentIndex) return;

            items.forEach((el, i) => {
                if (el === item) return;
                let shift = 0;
                if (newIndex > fromIndex && i > fromIndex && i <= newIndex) {
                    shift = -step; // 下方向へドラッグ：通過した項目は1つ前に詰める
                } else if (newIndex < fromIndex && i >= newIndex && i < fromIndex) {
                    shift = step; // 上方向へドラッグ：通過した項目は1つ後ろへ
                }
                el.style.transform = shift ? `translateY(${shift}px)` : '';
            });

            currentIndex = newIndex;
        };

        const finish = () => {
            grip.releasePointerCapture(pointerId);
            grip.removeEventListener('pointermove', move);
            grip.removeEventListener('pointerup', finish);
            grip.removeEventListener('pointercancel', finish);

            item.classList.remove('dragging');
            item.style.transform = '';
            items.forEach(el => { if (el !== item) el.style.transform = ''; });
            document.body.classList.remove('reorder-active');
            this._reordering = false;

            if (currentIndex !== fromIndex) {
                onDrop(fromIndex, currentIndex);
            }
        };

        grip.setPointerCapture(pointerId);
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', finish);
        grip.addEventListener('pointercancel', finish);
    }

    // ----------------------------------------
    // 計算
    // ----------------------------------------

    /**
     * 合計金額を計算
     * @returns {number} 合計金額
     */
    calculateTotal() {
        const monthData = this.getCurrentMonthData();
        
        return monthData.categories.reduce((total, category) => {
            if (category.subcategories.length === 0) {
                return total + (category.amount || 0);
            }
            return total + category.subcategories.reduce(
                (subTotal, sub) => subTotal + (sub.amount || 0), 
                0
            );
        }, 0);
    }

    // ----------------------------------------
    // 出力テキスト生成
    // ----------------------------------------

    /**
     * 家計簿の出力テキストを生成
     * @returns {string} フォーマットされた出力テキスト
     */
    generateOutput() {
        const monthData = this.getCurrentMonthData();
        const { year, month } = this._parseMonthKey(this.getCurrentMonthKey());
        
        let output = '━━━━━━━━━━━━━━━━\n';
        output += `📅 ${year}年${month}月 家計簿\n`;
        output += '━━━━━━━━━━━━━━━━\n\n';
        
        monthData.categories.forEach((category, index) => {
            output += this._formatCategoryOutput(category);
            if (index < monthData.categories.length - 1) output += '\n';
        });
        
        const total = this.calculateTotal();
        const halfTotal = Math.round(total / 2);
        output += '\n━━━━━━━━━━━━━━━━\n';
        output += `💰 Total：${Utils.formatCurrency(total)}円\n`;
        output += `👥 折半：${Utils.formatCurrency(halfTotal)}円\n`;
        output += '━━━━━━━━━━━━━━━━';
        
        return output;
    }

    /**
     * 年月キーをパース
     * @private
     * @param {string} monthKey - YYYY-MM形式
     * @returns {{year: string, month: number}}
     */
    _parseMonthKey(monthKey) {
        const [year, month] = monthKey.split('-');
        return { year, month: parseInt(month) };
    }

    /**
     * カテゴリの出力文字列を生成
     * @private
     * @param {Object} category - カテゴリデータ
     * @returns {string}
     */
    _formatCategoryOutput(category) {
        if (category.subcategories.length === 0) {
            return `■ ${category.name}：${Utils.formatCurrency(category.amount)}円\n`;
        }
        
        const subTotal = category.subcategories.reduce((sum, sub) => sum + (sub.amount || 0), 0);
        let output = `■ ${category.name}：${Utils.formatCurrency(subTotal)}円\n`;
        
        category.subcategories.forEach((sub, index) => {
            const isLast = index === category.subcategories.length - 1;
            const prefix = isLast ? '  └ ' : '  ├ ';
            output += `${prefix}${sub.name}：${Utils.formatCurrency(sub.amount)}円\n`;
        });
        
        return output;
    }

    // ----------------------------------------
    // 表示更新
    // ----------------------------------------

    /**
     * 画面表示を更新
     */
    updateDisplay() {
        // 月表示
        const monthLabel = `${this.currentYear}年 ${this.currentMonth}月`;
        document.getElementById('currentMonth').textContent = monthLabel;

        const miniMonthEl = document.getElementById('miniHeaderMonth');
        if (miniMonthEl) miniMonthEl.textContent = monthLabel;

        // カテゴリリスト
        const monthData = this.getCurrentMonthData();
        document.getElementById('categoryList').innerHTML =
            monthData.categories.map(cat => this._renderCategory(cat)).join('');

        // 合計表示
        this._updateTotalDisplay();
    }

    /**
     * 家計簿ミニヘッダーの表示制御を初期化
     * 月セレクタ（#monthSelector）がスクロールで画面外に出たら
     * 画面上部にミニヘッダー（月送り・合計金額）を表示する
     */
    initMiniHeader() {
        const target = document.getElementById('monthSelector');
        const miniHeader = document.getElementById('miniHeader');
        if (!target || !miniHeader || this._miniHeaderObserver) return;

        this._miniHeaderObserver = new IntersectionObserver(
            (entries) => {
                const budgetSection = document.getElementById('budgetSection');
                const onBudgetPage = budgetSection && getComputedStyle(budgetSection).display !== 'none';
                miniHeader.classList.toggle('show', onBudgetPage && !entries[0].isIntersecting);
            },
            { threshold: 0 }
        );
        this._miniHeaderObserver.observe(target);
    }

    /**
     * カテゴリのHTMLを生成
     * @private
     * @param {Object} category - カテゴリデータ
     * @returns {string} HTML文字列
     */
    _renderCategory(category) {
        const subTotal = category.subcategories.reduce((sum, sub) => sum + (sub.amount || 0), 0);
        const displayAmount = category.subcategories.length > 0 ? subTotal : category.amount;

        return `
            <div class="category-item overflow-hidden rounded-xl bg-white/5 ring-1 ring-white/10" data-cat-id="${category.id}">
                ${this._renderCategorySummary(category, displayAmount)}
                ${this._renderCategoryDetails(category, displayAmount)}
            </div>
        `;
    }

    /**
     * カテゴリサマリー行のHTMLを生成
     * @private
     */
    _renderCategorySummary(category, displayAmount) {
        // IDを安全な文字列に変換（小数点をハイフンに置換）
        const safeId = String(category.id).replaceAll('.', '-');

        const quickInput = this.quickInputMode ? `
            <form class="quick-input-wrapper flex items-center gap-1.5" onsubmit="return app.budget.quickInputSubmit('${safeId}', null, event)">
                <input type="number" class="quick-input-field w-24 rounded-lg bg-white/5 px-2.5 py-1.5 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500" id="quick-${safeId}"
                    placeholder="金額" inputmode="decimal" enterkeyhint="go"
                    onclick="event.stopPropagation()">
                <button type="submit" class="quick-add-btn flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500 font-bold text-white transition hover:bg-indigo-400" onclick="event.stopPropagation()">+</button>
            </form>
        ` : '';

        return `
            <div class="category-summary cursor-pointer px-4 py-3 transition hover:bg-white/5" onclick="app.budget.toggleAccordion(${category.id})">
                <div class="flex items-center justify-between gap-3">
                    <div class="category-summary-left flex min-w-0 items-center gap-2.5">
                        <span class="accordion-icon text-xs text-zinc-500" id="icon-${category.id}">${Icons.svg('chevron-right')}</span>
                        <span class="category-summary-name truncate text-sm font-semibold text-zinc-100">${Utils.escapeHtml(category.name)}</span>
                    </div>
                    <div class="category-summary-right flex shrink-0 items-center gap-2">
                        ${quickInput}
                        <span class="category-summary-amount whitespace-nowrap text-sm font-bold text-white">${Utils.formatCurrency(displayAmount)}円</span>
                        <span class="drag-handle flex h-8 w-8 shrink-0 cursor-grab items-center justify-center text-lg text-zinc-500 transition hover:text-zinc-300 active:cursor-grabbing"
                            onpointerdown="app.budget.startCategoryDrag(event, ${category.id})" onclick="event.stopPropagation()">${Icons.svg('grip')}</span>
                    </div>
                </div>
                ${this._renderBudgetBar(displayAmount, category.budget)}
            </div>
        `;
    }

    /**
     * 予算バーのHTMLを生成（予算が未設定・0の場合は非表示）
     * @private
     * @param {number} displayAmount - 現在の使用金額
     * @param {number} budget - 予算額
     * @returns {string}
     */
    _renderBudgetBar(displayAmount, budget) {
        if (!budget || budget <= 0) return '';

        const ratio = displayAmount / budget;
        const percent = Math.round(ratio * 100);
        const widthPercent = Math.min(100, Math.max(0, ratio * 100));
        const barColor = ratio >= 1 ? 'bg-rose-500' : (ratio >= 0.8 ? 'bg-amber-400' : 'bg-emerald-500');
        const textColor = ratio >= 1 ? 'text-rose-300' : (ratio >= 0.8 ? 'text-amber-300' : 'text-emerald-300');

        return `
            <div class="budget-bar mt-2 flex items-center gap-2">
                <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
                    <div class="h-full rounded-full ${barColor} transition-[width]" style="width: ${widthPercent}%"></div>
                </div>
                <span class="shrink-0 whitespace-nowrap text-[11px] font-semibold ${textColor}">${percent}% / 予算${Utils.formatCurrency(budget)}円</span>
            </div>
        `;
    }

    /**
     * カテゴリ詳細のHTMLを生成
     * @private
     */
    _renderCategoryDetails(category, displayAmount) {
        const hasSubcategories = category.subcategories.length > 0;

        return `
            <div class="category-details border-t border-white/10 px-4 pb-4 pt-3" id="details-${category.id}">
                ${this._renderCategoryHeader(category, displayAmount, hasSubcategories)}
                ${!hasSubcategories ? this._renderCategoryNote(category) : ''}
                ${hasSubcategories ? this._renderSubcategories(category) : ''}
                ${this._renderAddSubcategoryForm(category.id)}
            </div>
        `;
    }

    /**
     * カテゴリヘッダーのHTMLを生成
     * @private
     */
    _renderCategoryHeader(category, displayAmount, hasSubcategories) {
        const amountSection = hasSubcategories
            ? `<span class="text-base font-bold text-white">合計: ${Utils.formatCurrency(displayAmount)}円</span>`
            : `<input type="number" id="amount-${category.id}" value="${category.amount ?? 0}" onchange="app.budget.updateAmount(${category.id}, null)" class="w-28 rounded-lg bg-white/5 px-2.5 py-1.5 text-right text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none focus:ring-2 focus:ring-indigo-500"><span class="text-sm text-zinc-400">円</span>`;

        return `
            <div class="category-header flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                    <span class="category-name text-sm font-bold text-white">${Utils.escapeHtml(category.name)}</span>
                    ${category.note ? `<div class="note-text mt-0.5 text-xs text-zinc-500">備考: ${Utils.escapeHtml(category.note)}</div>` : ''}
                </div>
                <div class="category-amount flex items-center gap-2">
                    ${amountSection}
                    <div class="category-actions flex gap-1.5">
                        <button class="edit-btn rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-white/15" onclick="app.budget.editCategory(${category.id})">編集</button>
                        <button class="delete-btn rounded-md bg-rose-500/10 px-2.5 py-1.5 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/20" onclick="app.budget.deleteCategory(${category.id})">削除</button>
                    </div>
                </div>
            </div>
            <div class="category-budget mt-2.5 flex items-center gap-2">
                <span class="text-xs font-semibold text-zinc-400">予算</span>
                <input type="number" id="budget-${category.id}" value="${category.budget || ''}" placeholder="未設定" onchange="app.budget.updateBudget(${category.id})" class="w-28 rounded-lg bg-white/5 px-2.5 py-1.5 text-right text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500">
                <span class="text-sm text-zinc-400">円</span>
            </div>
        `;
    }

    /**
     * カテゴリ備考入力のHTMLを生成
     * @private
     */
    _renderCategoryNote(category) {
        return `
            <div class="mt-3">
                <input type="text" class="note-input w-full rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500" id="note-${category.id}"
                    value="${Utils.escapeHtml(category.note || '')}" placeholder="備考を入力..."
                    onchange="app.budget.updateNote(${category.id}, null)">
            </div>
        `;
    }

    /**
     * サブカテゴリリストのHTMLを生成
     * @private
     */
    _renderSubcategories(category) {
        return `<div class="subcategory-list mt-3 space-y-2" id="sublist-${category.id}">${this._renderSubcategoryItems(category)}</div>`;
    }

    /**
     * サブカテゴリの各行のHTMLを生成（並び替え後の部分更新でも再利用）
     * @private
     */
    _renderSubcategoryItems(category) {
        const safeCatId = String(category.id).replaceAll('.', '-');

        return category.subcategories.map(sub => {
            const safeSubId = String(sub.id).replaceAll('.', '-');

            const quickInput = this.quickInputMode ? `
                <form class="quick-input-wrapper-sub flex items-center gap-1.5" onsubmit="return app.budget.quickInputSubmit('${safeCatId}', '${safeSubId}', event)">
                    <input type="number" class="quick-input-field quick-input-sub w-20 rounded-lg bg-white/5 px-2 py-1.5 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500" id="quick-sub-${safeCatId}-${safeSubId}"
                        placeholder="金額" inputmode="decimal" enterkeyhint="go">
                    <button type="submit" class="quick-add-btn flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500 font-bold text-white transition hover:bg-indigo-400">+</button>
                </form>
            ` : '';

            return `
                <div class="subcategory-item rounded-lg bg-white/5 p-3 ring-1 ring-inset ring-white/5" data-sub-id="${sub.id}">
                    <div class="sub-row-primary flex items-center gap-2">
                        <span class="subcategory-name min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">${Utils.escapeHtml(sub.name)}</span>
                        ${quickInput}
                        <input type="number" id="subamount-${category.id}-${sub.id}" value="${sub.amount ?? 0}"
                            onchange="app.budget.updateAmount(${category.id}, ${sub.id})" class="w-24 shrink-0 rounded-lg bg-white/5 px-2.5 py-1.5 text-right text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none focus:ring-2 focus:ring-indigo-500">
                        <span class="shrink-0 text-sm text-zinc-400">円</span>
                        <span class="drag-handle flex h-8 w-8 shrink-0 cursor-grab items-center justify-center text-base text-zinc-500 transition hover:text-zinc-300 active:cursor-grabbing"
                            onpointerdown="app.budget.startSubcategoryDrag(event, ${category.id}, ${sub.id})">${Icons.svg('grip')}</span>
                    </div>
                    <div class="sub-row-secondary mt-2 flex items-center gap-2">
                        <input type="text" class="note-input min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500" id="subnote-edit-${category.id}-${sub.id}"
                            value="${Utils.escapeHtml(sub.note || '')}" placeholder="備考を入力..."
                            onchange="app.budget.updateNote(${category.id}, ${sub.id})">
                        <div class="category-actions flex shrink-0 gap-1.5">
                            <button class="edit-btn rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-white/15" onclick="app.budget.editSubcategory(${category.id}, ${sub.id})">編集</button>
                            <button class="delete-btn rounded-md bg-rose-500/10 px-2.5 py-1.5 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/20" onclick="app.budget.deleteSubcategory(${category.id}, ${sub.id})">削除</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    /**
     * サブカテゴリ追加フォームのHTMLを生成
     * @private
     */
    _renderAddSubcategoryForm(categoryId) {
        return `
            <div class="add-subcategory mt-3 rounded-lg bg-white/5 p-3 ring-1 ring-inset ring-white/5">
                <div class="input-group flex flex-col gap-2 sm:flex-row">
                    <input type="text" id="subname-${categoryId}" placeholder="小カテゴリー（例：電気）" class="min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500">
                    <input type="number" id="subamount-${categoryId}" placeholder="金額" class="min-w-0 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500 sm:w-24">
                    <input type="text" id="subnote-${categoryId}" placeholder="備考（任意）" class="min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500">
                    <button onclick="app.budget.addSubcategory(${categoryId})" class="shrink-0 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400">追加</button>
                </div>
            </div>
        `;
    }

    // ----------------------------------------
    // コピー機能
    // ----------------------------------------

    /**
     * 出力テキストをクリップボードにコピー
     */
    copyOutput() {
        const text = document.getElementById('outputText')?.textContent;
        if (!text) return;
        
        navigator.clipboard.writeText(text).then(() => {
            const successMsg = document.getElementById('copySuccess');
            if (successMsg) {
                successMsg.style.display = 'block';
                setTimeout(() => successMsg.style.display = 'none', 2000);
            }
        });
    }

    // ----------------------------------------
    // 合計カードのフリップ（内訳円グラフ）
    // ----------------------------------------

    /**
     * 合計カードの表（合計金額）と裏（円グラフ）を切り替える
     */
    toggleTotalView() {
        const flip = document.getElementById('totalFlip');
        const front = document.getElementById('totalFlipFront');
        const back = document.getElementById('totalFlipBack');
        if (!flip || !front || !back) return;

        // 現在の高さを明示的に固定してから遷移（auto→px のジャンプを防ぐ）
        flip.style.height = `${flip.offsetHeight}px`;
        void flip.offsetHeight; // リフローを強制

        this.totalFlipped = !this.totalFlipped;

        if (this.totalFlipped) {
            this.renderPie();
            flip.style.height = `${this._measureHeight(back)}px`;
            flip.classList.add('flipped');
        } else {
            flip.style.height = `${this._measureHeight(front)}px`;
            flip.classList.remove('flipped');
        }
    }

    /**
     * 絶対配置された面の自然な高さを測定する
     * @private
     * @param {HTMLElement} el
     * @returns {number}
     */
    _measureHeight(el) {
        const prev = el.style.position;
        el.style.position = 'relative';
        const h = el.offsetHeight;
        el.style.position = prev;
        return h;
    }

    /**
     * 合計カードを表（合計金額）に戻す
     * @private
     */
    _resetTotalView() {
        this.totalFlipped = false;
        const flip = document.getElementById('totalFlip');
        if (flip) {
            flip.classList.remove('flipped');
            flip.style.height = '';
        }
    }

    /**
     * カテゴリ別の内訳を集計（金額降順、7件以上は上位6＋その他に集約）
     * @private
     * @returns {{breakdown: Array<{name: string, amount: number, color: string}>, total: number}}
     */
    _getCategoryBreakdown() {
        const monthData = this.getCurrentMonthData();

        const items = monthData.categories.map(cat => {
            const amount = cat.subcategories.length > 0
                ? cat.subcategories.reduce((sum, sub) => sum + (sub.amount || 0), 0)
                : (cat.amount || 0);
            return { name: cat.name, amount };
        }).filter(item => item.amount > 0)
          .sort((a, b) => b.amount - a.amount);

        const total = items.reduce((sum, item) => sum + item.amount, 0);

        // 7件以上は上位6件＋「その他」に集約（円グラフは6分割程度が視認の限界）
        let breakdown = items;
        if (items.length > 7) {
            const top = items.slice(0, 6);
            const otherTotal = items.slice(6).reduce((sum, item) => sum + item.amount, 0);
            breakdown = [...top, { name: 'その他', amount: otherTotal }];
        }

        // 金額順に色を固定割当（「その他」はグレー）
        breakdown = breakdown.map((item, i) => ({
            ...item,
            color: item.name === 'その他' ? OTHER_COLOR : CATEGORY_COLORS[i % CATEGORY_COLORS.length]
        }));

        return { breakdown, total };
    }

    /**
     * 円グラフと凡例を描画
     */
    renderPie() {
        const chartEl = document.getElementById('pieChart');
        const legendEl = document.getElementById('pieLegend');
        if (!chartEl || !legendEl) return;

        const { breakdown, total } = this._getCategoryBreakdown();

        if (!breakdown.length || total <= 0) {
            chartEl.innerHTML = '';
            legendEl.innerHTML = '<p class="py-4 text-center text-sm text-zinc-500">データがありません</p>';
            return;
        }

        const { svg, legend } = buildPie(breakdown, total);
        chartEl.innerHTML = svg;
        legendEl.innerHTML = legend;
    }

    // ----------------------------------------
    // ヘルパーメソッド
    // ----------------------------------------

    /**
     * カテゴリを検索
     * @private
     * @param {number} categoryId - カテゴリID
     * @returns {Object|undefined}
     */
    _findCategory(categoryId) {
        return this.getCurrentMonthData().categories.find(c => c.id === categoryId);
    }

    /**
     * 入力フィールドをクリア
     * @private
     * @param {string[]} fieldIds - フィールドID配列
     */
    _clearInputFields(fieldIds) {
        fieldIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
    }

    /**
     * 同期ステータスを表示してから保存
     */
    saveWithStatus() {
        this.showSyncStatus(SYNC_STATUS.SYNCING, '同期中...');
        this.saveToFirestore();
    }
}
