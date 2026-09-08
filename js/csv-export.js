/**
 * CSV出力モジュール
 * 家計簿データを月・期間指定でCSV（BOM付きUTF-8）にエクスポートする
 */

import { Utils } from './utils.js';


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
        return Utils.getMonthKey(today.getFullYear(), today.getMonth() + 1);
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

