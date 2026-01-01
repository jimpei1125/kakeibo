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
            // 全角演算子を半角に変換して計算
            const expr = this.expression.replace(/×/g, '*').replace(/÷/g, '/');
            const result = Math.round(eval(expr) * 100) / 100;
            this.expression = result.toString();
            this._updateDisplay(result);
        } catch {
            this._updateDisplay('エラー');
            this.expression = 'エラー';
        }
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
        const row = [month, `"${category}"`, `"${subcategory}"`, amount || 0];
        if (includeHalf) row.push(Math.round((amount || 0) / 2));
        if (includeNotes) row.push(`"${note || ''}"`);
        return row.join(',') + '\n';
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
        
        const btn = document.getElementById('quickInputToggle');
        if (btn) {
            btn.classList.toggle('active', this.quickInputMode);
            btn.textContent = this.quickInputMode ? '⚡ クイック入力 ON' : '⚡ クイック入力';
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
        console.log('quickInputSubmit called:', categoryIdStr, subIdStr);
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
        console.log('quickAddAmount called:', categoryIdStr, subIdStr);
        
        // 安全な文字列IDから元のIDを復元（ハイフンを小数点に戻す）
        const categoryId = parseFloat(String(categoryIdStr).replace('-', '.'));
        const subId = subIdStr ? parseFloat(String(subIdStr).replace('-', '.')) : null;
        
        console.log('Parsed IDs:', categoryId, subId);
        
        const inputId = subIdStr ? `quick-sub-${categoryIdStr}-${subIdStr}` : `quick-${categoryIdStr}`;
        console.log('Looking for input:', inputId);
        
        const input = document.getElementById(inputId);
        console.log('Found input:', input);
        
        if (!input) {
            console.error('Input not found!');
            Utils.showToast('エラー: 入力欄が見つかりません');
            return;
        }
        
        const amount = parseFloat(input.value);
        console.log('Amount:', amount, 'Raw value:', input.value);
        
        if (!amount || isNaN(amount)) {
            Utils.showToast('金額を入力してください');
            return;
        }
        
        const category = this._findCategory(categoryId);
        console.log('Found category:', category);
        
        if (!category) {
            console.error('Category not found!');
            Utils.showToast('エラー: カテゴリが見つかりません');
            return;
        }
        
        let newTotal = 0;
        
        if (subId) {
            const sub = category.subcategories.find(s => s.id === subId);
            if (sub) {
                sub.amount = (sub.amount || 0) + amount;
                newTotal = sub.amount;
                // サブカテゴリの金額表示を部分更新
                const subAmountInput = document.getElementById(`subamount-${categoryId}-${subId}`);
                if (subAmountInput) subAmountInput.value = newTotal;
            }
        } else {
            category.amount = (category.amount || 0) + amount;
            newTotal = category.amount;
            console.log('New total for category:', newTotal);
            // カテゴリの金額表示を部分更新
            const amountInput = document.getElementById(`amount-${categoryId}`);
            if (amountInput) amountInput.value = newTotal;
        }
        
        // カテゴリサマリーの金額表示を更新
        this._updateCategorySummaryAmount(categoryId);
        
        // 合計金額を更新
        this._updateTotalDisplay();
        
        // 入力欄をクリア（フォーカスは維持）
        input.value = '';
        
        // 成功フィードバック
        input.classList.add('quick-input-success');
        setTimeout(() => input.classList.remove('quick-input-success'), 300);
        
        Utils.showToast(`+¥${Utils.formatCurrency(amount)} 追加`);
        console.log('Toast shown, saving to Firestore...');
        
        // Firestoreに保存（バックグラウンドで、DOM再描画なし）
        this._saveQuietly();
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
    
    /**
     * Firestoreに静かに保存（DOM再描画なし）
     * @private
     */
    async _saveQuietly() {
        try {
            await setDoc(doc(db, 'budgetData', 'data'), { data: this.data });
            // 同期ステータスは表示するが、updateDisplayは呼ばない
            this.showSyncStatus(SYNC_STATUS.SYNCED, '✓ 同期完了');
            this._hideSyncStatusAfterDelay();
        } catch (error) {
            console.error('Firestore保存エラー:', error);
            this.showSyncStatus(SYNC_STATUS.ERROR, `✗ 同期エラー: ${error.message}`);
        }
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
        this._saveWithStatus();
    }

    /**
     * カテゴリを削除
     * @param {number} categoryId - カテゴリID
     */
    deleteCategory(categoryId) {
        if (!confirm('このカテゴリーを削除しますか？')) return;

        const monthData = this.getCurrentMonthData();
        monthData.categories = monthData.categories.filter(c => c.id !== categoryId);
        this._saveWithStatus();
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
            this._saveWithStatus();
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
        this._saveWithStatus();
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
        this._saveWithStatus();
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
            this._saveWithStatus();
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
        this._saveWithStatus();
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
        this._saveWithStatus();
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
        this._saveWithStatus();
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
        const total = this.calculateTotal();
        const half = Math.round(total / 2);
        document.getElementById('totalAmount').textContent = `¥${Utils.formatCurrency(total)}`;
        document.getElementById('halfAmount').textContent = `折半: ¥${Utils.formatCurrency(half)}`;
        document.getElementById('outputText').textContent = this.generateOutput();
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
            <div class="category-item">
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
        const safeId = String(category.id).replace('.', '-');
        
        const quickInput = this.quickInputMode ? `
            <form class="quick-input-wrapper" onsubmit="return app.budget.quickInputSubmit('${safeId}', null, event)">
                <input type="number" class="quick-input-field" id="quick-${safeId}" 
                    placeholder="金額" inputmode="decimal" enterkeyhint="go"
                    onclick="event.stopPropagation()">
                <button type="submit" class="quick-add-btn" onclick="event.stopPropagation()">+</button>
            </form>
        ` : '';
        
        return `
            <div class="category-summary" onclick="app.budget.toggleAccordion(${category.id})">
                <div class="category-summary-left">
                    <span class="accordion-icon" id="icon-${category.id}">▶</span>
                    <span class="category-summary-name">${category.name}</span>
                </div>
                <div class="category-summary-right">
                    ${quickInput}
                    <span class="category-summary-amount">${Utils.formatCurrency(displayAmount)}円</span>
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
            <div class="category-details" id="details-${category.id}">
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
            ? `<span style="font-size: 18px; font-weight: bold;">合計: ${Utils.formatCurrency(displayAmount)}円</span>`
            : `<input type="number" id="amount-${category.id}" value="${category.amount}" onchange="app.budget.updateAmount(${category.id}, null)"><span>円</span>`;
        
        return `
            <div class="category-header">
                <div>
                    <span class="category-name">${category.name}</span>
                    ${category.note ? `<div class="note-text">備考: ${category.note}</div>` : ''}
                </div>
                <div class="category-amount">
                    ${amountSection}
                    <div class="category-actions">
                        <button class="edit-btn" onclick="app.budget.editCategory(${category.id})">編集</button>
                        <button class="delete-btn" onclick="app.budget.deleteCategory(${category.id})">削除</button>
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
            <div style="margin-top: 10px;">
                <input type="text" class="note-input" id="note-${category.id}" 
                    value="${category.note || ''}" placeholder="備考を入力..." 
                    onchange="app.budget.updateNote(${category.id}, null)">
            </div>
        `;
    }

    /**
     * サブカテゴリリストのHTMLを生成
     * @private
     */
    _renderSubcategories(category) {
        const safeCatId = String(category.id).replace('.', '-');
        
        const items = category.subcategories.map(sub => {
            const safeSubId = String(sub.id).replace('.', '-');
            
            const quickInput = this.quickInputMode ? `
                <form class="quick-input-wrapper-sub" onsubmit="return app.budget.quickInputSubmit('${safeCatId}', '${safeSubId}', event)">
                    <input type="number" class="quick-input-field quick-input-sub" id="quick-sub-${safeCatId}-${safeSubId}" 
                        placeholder="金額" inputmode="decimal" enterkeyhint="go">
                    <button type="submit" class="quick-add-btn">+</button>
                </form>
            ` : '';
            
            return `
                <div class="subcategory-item">
                    <div class="sub-row">
                        <div>
                            <span class="subcategory-name">${sub.name}</span>
                            ${sub.note ? `<div class="note-text">備考: ${sub.note}</div>` : ''}
                        </div>
                        <div class="category-amount">
                            ${quickInput}
                            <input type="number" id="subamount-${category.id}-${sub.id}" value="${sub.amount}" 
                                onchange="app.budget.updateAmount(${category.id}, ${sub.id})">
                            <span>円</span>
                            <div class="category-actions">
                                <button class="edit-btn" onclick="app.budget.editSubcategory(${category.id}, ${sub.id})">編集</button>
                                <button class="delete-btn" onclick="app.budget.deleteSubcategory(${category.id}, ${sub.id})">削除</button>
                            </div>
                        </div>
                    </div>
                    <input type="text" class="note-input" id="subnote-edit-${category.id}-${sub.id}" 
                        value="${sub.note || ''}" placeholder="備考を入力..." 
                        onchange="app.budget.updateNote(${category.id}, ${sub.id})">
                </div>
            `;
        }).join('');
        
        return `<div class="subcategory-list">${items}</div>`;
    }

    /**
     * サブカテゴリ追加フォームのHTMLを生成
     * @private
     */
    _renderAddSubcategoryForm(categoryId) {
        return `
            <div class="add-subcategory">
                <div class="input-group">
                    <input type="text" id="subname-${categoryId}" placeholder="小カテゴリー（例：電気）">
                    <input type="number" id="subamount-${categoryId}" placeholder="金額">
                    <input type="text" id="subnote-${categoryId}" placeholder="備考（任意）">
                    <button onclick="app.budget.addSubcategory(${categoryId})">追加</button>
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
     * @private
     */
    _saveWithStatus() {
        this.showSyncStatus(SYNC_STATUS.SYNCING, '同期中...');
        this.saveToFirestore();
    }
}
