/**
 * 月間コピーモジュール
 * 他の月のカテゴリーを選んで表示中の月に追加する（上書きではなく追加）
 */

import { Utils } from './utils.js';
import { Icons } from './icons.js';
import { categoryDisplayAmount } from './budget.js';


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
        const { year, month } = Utils.shiftMonth(
            this.budgetManager.currentYear, this.budgetManager.currentMonth, -1);
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
            return {
                id: cat.id,
                name: cat.name,
                amount: categoryDisplayAmount(cat),
                budget: cat.budget || 0,
                payer: cat.payer,
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
                // payerは「未設定＝夫払い」。undefinedのキーを作るとFirestoreの保存が
                // 失敗するため、妻払いのときだけフィールドを持たせる
                ...(sub.payer ? { payer: sub.payer } : {}),
                note: sub.note || ''
            }));

            return {
                id: Utils.generateId(),
                name: item.name,
                amount: keepAmount ? (subcategories.length > 0 ? 0 : item.amount) : 0,
                budget: item.budget || 0,
                ...(item.payer ? { payer: item.payer } : {}),
                note: item.note || '',
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

