/**
 * 家計簿モジュール
 * 予算管理、計算機、CSV出力の機能を提供
 */

import { db, doc, setDoc, onSnapshot } from './firebase-config.js';
import { Utils } from './utils.js';

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
            alert('出力するデータがありません');
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
            alert('開始年月と終了年月を選択してください');
            return null;
        }
        
        const start = new Date(`${startDate}-01`);
        const end = new Date(`${endDate}-01`);
        
        if (start > end) {
            alert('開始年月は終了年月より前に設定してください');
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

/**
 * CSVファイルから利用金額を読み込んで合計を計算し、項目として追加するクラス
 */
export class CSVImporter {
    /**
     * @param {BudgetManager} budgetManager - 予算管理インスタンス
     */
    constructor(budgetManager) {
        /** @type {BudgetManager} */
        this.budgetManager = budgetManager;
        /** @type {number|null} 計算された合計金額 */
        this.calculatedTotal = null;
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
        this.calculatedTotal = null;
        const fileInput = document.getElementById('csvFileInput');
        const categoryName = document.getElementById('csvCategoryName');
        const totalDisplay = document.getElementById('csvTotalDisplay');
        const importBtn = document.getElementById('csvImportBtn');
        const fileNameDisplay = document.getElementById('csvFileName');

        if (fileInput) fileInput.value = '';
        if (categoryName) categoryName.value = '';
        if (totalDisplay) {
            totalDisplay.textContent = '';
            totalDisplay.style.display = 'none';
        }
        if (fileNameDisplay) {
            fileNameDisplay.textContent = '';
            fileNameDisplay.style.display = 'none';
        }
        if (importBtn) importBtn.disabled = true;
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
            alert('CSVファイルを選択してください');
            return;
        }

        try {
            Utils.showToast('CSV読み込み中...');
            const content = await this._readFile(file);
            this.calculatedTotal = this._parseCSVAndCalculateTotal(content);
            this._displayTotal();
        } catch (error) {
            console.error('CSV読み込みエラー:', error);
            alert(`CSVファイルの読み込みに失敗しました: ${error.message}`);
            // エラー時はファイル名表示をクリア
            if (fileNameDisplay) {
                fileNameDisplay.style.display = 'none';
            }
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
     * CSVをパースして利用金額の合計を計算
     * @private
     * @param {string} content - CSV内容
     * @returns {number} 合計金額
     */
    _parseCSVAndCalculateTotal(content) {
        const lines = content.split(/\r?\n/).filter(line => line.trim());
        if (lines.length === 0) {
            throw new Error('CSVファイルが空です');
        }

        // ヘッダー行から「利用金額」列のインデックスを取得
        const headers = this._parseCSVLine(lines[0]);
        const amountIndex = headers.findIndex(h =>
            h.includes('利用金額') || h.includes('金額') || h.includes('Amount')
        );

        if (amountIndex === -1) {
            throw new Error('「利用金額」列が見つかりません。ヘッダー行を確認してください。');
        }

        // データ行から金額を抽出して合計
        let total = 0;
        for (let i = 1; i < lines.length; i++) {
            const row = this._parseCSVLine(lines[i]);
            if (row.length > amountIndex) {
                const amountStr = row[amountIndex].replace(/[,¥円]/g, '').trim();
                const amount = parseFloat(amountStr);
                if (!isNaN(amount) && amount > 0) {
                    total += amount;
                }
            }
        }

        if (total === 0) {
            throw new Error('有効な金額データが見つかりませんでした');
        }

        return total;
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

    /**
     * 計算された合計金額を表示
     * @private
     */
    _displayTotal() {
        const totalDisplay = document.getElementById('csvTotalDisplay');
        const importBtn = document.getElementById('csvImportBtn');

        if (totalDisplay) {
            totalDisplay.textContent = `利用金額合計: ¥${Utils.formatCurrency(this.calculatedTotal)}`;
            totalDisplay.style.display = 'block';
        }

        if (importBtn) importBtn.disabled = false;

        Utils.showToast('CSV読み込み完了！');
    }

    /**
     * CSVデータをインポート
     */
    importData() {
        if (this.calculatedTotal === null) {
            alert('CSVファイルを選択してください');
            return;
        }

        const categoryName = document.getElementById('csvCategoryName')?.value.trim();
        if (!categoryName) {
            alert('項目名を入力してください');
            return;
        }

        // 新しいカテゴリとして追加
        this.budgetManager.getCurrentMonthData().categories.push({
            id: Utils.generateId(),
            name: categoryName,
            amount: this.calculatedTotal,
            note: 'CSVインポート',
            subcategories: []
        });

        this.budgetManager.saveWithStatus();

        Utils.showToast(`「${categoryName}」を追加しました！`);
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
        /** @type {Object} 全予算データ */
        this.data = {};
        /** @type {boolean} 初回読み込みフラグ */
        this.isInitialLoad = true;
        /** @type {boolean} クイック入力モード */
        this.quickInputMode = false;
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
            footerBtn.textContent = this.quickInputMode ? '⚡ ON' : '⚡ クイック入力';
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
     * 現在の月のデータを取得（なければ初期化）
     * @returns {Object} 月データ
     */
    getCurrentMonthData() {
        const key = this.getCurrentMonthKey();
        if (!this.data[key]) {
            this.data[key] = { categories: [] };
        }
        return this.data[key];
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
     * Firestoreにデータを保存
     */
    async saveToFirestore() {
        try {
            await setDoc(doc(db, 'budgetData', 'data'), { data: this.data });
            this.showSyncStatus(SYNC_STATUS.SYNCED, '✓ 同期完了');
            this._hideSyncStatusAfterDelay();
        } catch (error) {
            console.error('Firestore保存エラー:', error);
            this.showSyncStatus(SYNC_STATUS.ERROR, `✗ 同期エラー: ${error.message}`);
        }
    }

    /**
     * Firestoreからデータをリアルタイム購読
     */
    loadFromFirestore() {
        onSnapshot(
            doc(db, 'budgetData', 'data'),
            (docSnap) => this._handleSnapshot(docSnap),
            (error) => {
                console.error('Firestore読み込みエラー:', error);
                this.showSyncStatus(SYNC_STATUS.ERROR, `✗ 接続エラー: ${error.message}`);
            }
        );
    }

    /**
     * スナップショット受信時の処理
     * @private
     * @param {Object} docSnap - Firestoreドキュメントスナップショット
     */
    _handleSnapshot(docSnap) {
        if (docSnap.exists() && docSnap.data().data) {
            this.data = docSnap.data().data;
            
            // クイック入力中はDOM再描画をスキップ（フォーカスを維持するため）
            if (!this.quickInputMode) {
                this.updateDisplay();
            }
            
            if (this.isInitialLoad) {
                this.updateDisplay(); // 初回は必ず描画
                this.showSyncStatus(SYNC_STATUS.SYNCED, '✓ データ読み込み完了');
                this.isInitialLoad = false;
                setTimeout(() => {
                    document.getElementById('syncStatus').style.display = 'none';
                }, SYNC_STATUS_HIDE_DELAY);
            }
        } else {
            this.showSyncStatus(SYNC_STATUS.SYNCED, '✓ 接続完了（データなし）');
            setTimeout(() => {
                document.getElementById('syncStatus').style.display = 'none';
            }, SYNC_STATUS_HIDE_DELAY);
        }
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
     * 新規カテゴリを追加
     */
    addCategory() {
        const name = document.getElementById('newCategoryName')?.value.trim();
        const amount = document.getElementById('newCategoryAmount')?.value;
        const note = document.getElementById('newCategoryNote')?.value.trim();

        if (!name) {
            alert('カテゴリー名を入力してください');
            return;
        }

        this.getCurrentMonthData().categories.push({
            id: Utils.generateId(),
            name,
            amount: amount ? parseFloat(amount) : 0,
            note: note || '',
            subcategories: []
        });

        // 入力フィールドをクリア
        this._clearInputFields(['newCategoryName', 'newCategoryAmount', 'newCategoryNote']);
        this.saveWithStatus();
    }

    /**
     * カテゴリを削除
     * @param {number} categoryId - カテゴリID
     */
    deleteCategory(categoryId) {
        if (!confirm('このカテゴリーを削除しますか？')) return;

        const monthData = this.getCurrentMonthData();
        monthData.categories = monthData.categories.filter(c => c.id !== categoryId);
        this.saveWithStatus();
    }

    /**
     * カテゴリ名を編集
     * @param {number} categoryId - カテゴリID
     */
    editCategory(categoryId) {
        const category = this._findCategory(categoryId);
        if (!category) return;
        
        const newName = prompt('カテゴリー名を入力:', category.name);
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
            alert('項目名を入力してください');
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
    deleteSubcategory(categoryId, subcategoryId) {
        if (!confirm('この項目を削除しますか？')) return;

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
    editSubcategory(categoryId, subcategoryId) {
        const category = this._findCategory(categoryId);
        const subcategory = category?.subcategories.find(s => s.id === subcategoryId);
        if (!subcategory) return;
        
        const newName = prompt('項目名を入力:', subcategory.name);
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
    // 先月コピー機能
    // ----------------------------------------

    /**
     * 先月のデータを今月にコピー
     */
    copyFromPreviousMonth() {
        const { year, month, key } = this._getPreviousMonth();
        const prevData = this.data[key];
        
        if (!prevData?.categories?.length) {
            alert('先月のデータがありません');
            return;
        }
        
        const currentData = this.getCurrentMonthData();
        if (currentData.categories.length > 0) {
            if (!confirm('今月のデータが上書きされますが、よろしいですか？')) {
                return;
            }
        }
        
        // 深いコピーを作成し、新しいIDを割り当て
        const copiedCategories = Utils.deepCopy(prevData.categories);
        copiedCategories.forEach(category => {
            category.id = Utils.generateId();
            category.subcategories.forEach(sub => {
                sub.id = Utils.generateId();
            });
        });
        
        currentData.categories = copiedCategories;
        this.saveWithStatus();
        alert('先月分のデータをコピーしました');
    }

    /**
     * 前月の情報を取得
     * @private
     * @returns {{year: number, month: number, key: string}}
     */
    _getPreviousMonth() {
        let prevMonth = this.currentMonth - 1;
        let prevYear = this.currentYear;
        
        if (prevMonth < 1) {
            prevMonth = 12;
            prevYear--;
        }
        
        return {
            year: prevYear,
            month: prevMonth,
            key: Utils.getMonthKey(prevYear, prevMonth)
        };
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
        document.getElementById('currentMonth').textContent =
            `${this.currentYear}年 ${this.currentMonth}月`;

        // カテゴリリスト
        const monthData = this.getCurrentMonthData();
        document.getElementById('categoryList').innerHTML =
            monthData.categories.map(cat => this._renderCategory(cat)).join('');

        // 合計表示
        this._updateTotalDisplay();
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
            <div class="category-item overflow-hidden rounded-xl bg-white/5 ring-1 ring-white/10">
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
            <div class="category-summary flex cursor-pointer items-center justify-between gap-3 px-4 py-3 transition hover:bg-white/5" onclick="app.budget.toggleAccordion(${category.id})">
                <div class="category-summary-left flex min-w-0 items-center gap-2.5">
                    <span class="accordion-icon text-[10px] text-zinc-500" id="icon-${category.id}">▶</span>
                    <span class="category-summary-name truncate text-sm font-semibold text-zinc-100">${Utils.escapeHtml(category.name)}</span>
                </div>
                <div class="category-summary-right flex shrink-0 items-center gap-2">
                    ${quickInput}
                    <span class="category-summary-amount whitespace-nowrap text-sm font-bold text-white">${Utils.formatCurrency(displayAmount)}円</span>
                </div>
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
        const safeCatId = String(category.id).replaceAll('.', '-');

        const items = category.subcategories.map(sub => {
            const safeSubId = String(sub.id).replaceAll('.', '-');

            const quickInput = this.quickInputMode ? `
                <form class="quick-input-wrapper-sub flex items-center gap-1.5" onsubmit="return app.budget.quickInputSubmit('${safeCatId}', '${safeSubId}', event)">
                    <input type="number" class="quick-input-field quick-input-sub w-20 rounded-lg bg-white/5 px-2 py-1.5 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500" id="quick-sub-${safeCatId}-${safeSubId}"
                        placeholder="金額" inputmode="decimal" enterkeyhint="go">
                    <button type="submit" class="quick-add-btn flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500 font-bold text-white transition hover:bg-indigo-400">+</button>
                </form>
            ` : '';

            return `
                <div class="subcategory-item rounded-lg bg-white/5 p-3 ring-1 ring-inset ring-white/5">
                    <div class="sub-row flex flex-wrap items-start justify-between gap-2">
                        <div class="min-w-0">
                            <span class="subcategory-name text-sm font-medium text-zinc-200">${Utils.escapeHtml(sub.name)}</span>
                            ${sub.note ? `<div class="note-text mt-0.5 text-xs text-zinc-500">備考: ${Utils.escapeHtml(sub.note)}</div>` : ''}
                        </div>
                        <div class="category-amount flex items-center gap-2">
                            ${quickInput}
                            <input type="number" id="subamount-${category.id}-${sub.id}" value="${sub.amount ?? 0}"
                                onchange="app.budget.updateAmount(${category.id}, ${sub.id})" class="w-24 rounded-lg bg-white/5 px-2.5 py-1.5 text-right text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none focus:ring-2 focus:ring-indigo-500">
                            <span class="text-sm text-zinc-400">円</span>
                            <div class="category-actions flex gap-1.5">
                                <button class="edit-btn rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-white/15" onclick="app.budget.editSubcategory(${category.id}, ${sub.id})">編集</button>
                                <button class="delete-btn rounded-md bg-rose-500/10 px-2.5 py-1.5 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/20" onclick="app.budget.deleteSubcategory(${category.id}, ${sub.id})">削除</button>
                            </div>
                        </div>
                    </div>
                    <input type="text" class="note-input mt-2 w-full rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500" id="subnote-edit-${category.id}-${sub.id}"
                        value="${Utils.escapeHtml(sub.note || '')}" placeholder="備考を入力..."
                        onchange="app.budget.updateNote(${category.id}, ${sub.id})">
                </div>
            `;
        }).join('');

        return `<div class="subcategory-list mt-3 space-y-2">${items}</div>`;
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

    /**
     * 折半金額をクリップボードにコピー
     */
    copyHalfAmount() {
        const halfTotal = Math.round(this.calculateTotal() / 2);
        navigator.clipboard.writeText(Utils.formatCurrency(halfTotal))
            .then(() => Utils.showToast('コピーしました！'))
            .catch(() => Utils.showToast('コピーに失敗しました'));
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
