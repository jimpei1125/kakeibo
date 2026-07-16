/**
 * 固定費（定期支出）モジュール
 * 家賃・サブスクなど毎月発生する項目をセットとして保存し、
 * 表示中の月が実際の今月かつまだデータが無いときにだけ1回自動記帳する。
 */

import { db, doc, setDoc, onSnapshot } from './firebase-config.js';
import { Utils } from './utils.js';
import { Icons } from './icons.js';
import { Dialog } from './dialog.js';

export class RecurringManager {
    /**
     * @param {import('./budget.js').BudgetManager} budgetManager - 予算管理インスタンス
     */
    constructor(budgetManager) {
        /** @type {import('./budget.js').BudgetManager} */
        this.budgetManager = budgetManager;
        /** @type {Array<{id: number, name: string, amount: number, note: string, payer?: string}>} */
        this.items = [];
        /** @type {boolean} Firestoreからの初回読み込みが完了したか */
        this.loaded = false;
    }

    /**
     * Firestoreから固定費セットを購読開始
     */
    init() {
        onSnapshot(
            doc(db, 'budgetData', 'recurringItems'),
            (snap) => {
                this.items = (snap.exists() && snap.data().items) || [];
                this.loaded = true;
                if (document.getElementById('recurringModal')?.classList.contains('show')) {
                    this._renderList();
                    this._renderFromCategoryList();
                }
                this.budgetManager.maybeAutoEntry();
            },
            (error) => console.error('固定費データ読み込みエラー:', error)
        );
    }

    /**
     * Firestoreへ保存
     * @private
     */
    async _save() {
        try {
            await setDoc(doc(db, 'budgetData', 'recurringItems'), { items: this.items });
        } catch (error) {
            console.error('固定費データ保存エラー:', error);
            Utils.showToast('保存に失敗しました');
        }
    }

    /**
     * 固定費管理モーダルを表示
     */
    showModal() {
        this._renderFromCategoryList();
        this._renderList();
        Utils.showModal('recurringModal');
    }

    /**
     * 固定費管理モーダルを閉じる
     */
    closeModal() {
        Utils.closeModal('recurringModal');
    }

    /**
     * 今月のカテゴリ（小カテゴリを持たない項目）を1タップ登録候補として表示
     * @private
     */
    _renderFromCategoryList() {
        const container = document.getElementById('recurringFromCategoryList');
        if (!container) return;

        const monthData = this.budgetManager.getCurrentMonthData();
        const existingNames = new Set(this.items.map(i => i.name));
        const candidates = monthData.categories.filter(c => c.subcategories.length === 0 && !existingNames.has(c.name));

        if (candidates.length === 0) {
            container.innerHTML = '<p class="text-xs text-zinc-500">登録できるカテゴリーはありません</p>';
            return;
        }

        container.innerHTML = candidates.map(cat => `
            <button type="button" onclick="app.recurring.addFromCategory(${cat.id})"
                class="rounded-full bg-indigo-500/15 px-3 py-1.5 text-xs font-semibold text-indigo-300 ring-1 ring-inset ring-indigo-500/30 transition hover:bg-indigo-500/25">
                ＋ ${Utils.escapeHtml(cat.name)}
            </button>
        `).join('');
    }

    /**
     * 今月のカテゴリから1件を固定費セットへ登録
     * @param {number} categoryId
     */
    addFromCategory(categoryId) {
        const category = this.budgetManager.getCurrentMonthData().categories.find(c => c.id === categoryId);
        if (!category) return;

        this.items.push({
            id: Utils.generateId(),
            name: category.name,
            amount: category.amount || 0,
            payer: category.payer,
            note: category.note || ''
        });

        this._save();
        this._renderList();
        this._renderFromCategoryList();
        Utils.showToast(`「${category.name}」を固定費に登録しました`);
    }

    /**
     * 新規固定費を追加
     */
    add() {
        const name = document.getElementById('recurringNewName')?.value.trim();
        const amount = document.getElementById('recurringNewAmount')?.value;
        const note = document.getElementById('recurringNewNote')?.value.trim();

        if (!name) {
            Utils.showToast('名前を入力してください');
            return;
        }

        this.items.push({
            id: Utils.generateId(),
            name,
            amount: amount ? parseFloat(amount) : 0,
            note: note || ''
        });

        ['recurringNewName', 'recurringNewAmount', 'recurringNewNote'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });

        this._save();
        this._renderList();
        this._renderFromCategoryList();
    }

    /**
     * 項目のフィールド（名前・金額・備考）を更新
     * @param {number} id
     * @param {'name'|'amount'|'note'} field
     * @param {string} rawValue
     */
    updateField(id, field, rawValue) {
        const item = this.items.find(i => i.id === id);
        if (!item) return;

        if (field === 'amount') item.amount = parseFloat(rawValue) || 0;
        else if (field === 'name') item.name = rawValue.trim();
        else if (field === 'note') item.note = rawValue.trim();

        this._save();
    }

    /**
     * 支払者（夫／妻）を切り替え
     * @param {number} id
     */
    togglePayer(id) {
        const item = this.items.find(i => i.id === id);
        if (!item) return;

        item.payer = item.payer === 'wife' ? undefined : 'wife';
        this._save();
        this._renderList();
    }

    /**
     * 固定費セットから削除
     * @param {number} id
     */
    async remove(id) {
        const confirmed = await Dialog.confirm('この固定費を削除しますか？', { okLabel: '削除', danger: true });
        if (!confirmed) return;

        this.items = this.items.filter(i => i.id !== id);
        this._save();
        this._renderList();
        this._renderFromCategoryList();
    }

    /**
     * 一覧を描画
     * @private
     */
    _renderList() {
        const listEl = document.getElementById('recurringList');
        const emptyEl = document.getElementById('recurringEmpty');
        if (!listEl) return;

        if (this.items.length === 0) {
            listEl.innerHTML = '';
            if (emptyEl) emptyEl.style.display = 'block';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        listEl.innerHTML = this.items.map(item => this._renderItem(item)).join('');
        Icons.hydrate(listEl);
    }

    /**
     * 1件分のHTMLを生成
     * @private
     */
    _renderItem(item) {
        const isWife = item.payer === 'wife';
        const chipClasses = isWife
            ? 'bg-pink-500/15 text-pink-300 ring-1 ring-inset ring-pink-500/30'
            : 'bg-white/10 text-zinc-300 ring-1 ring-inset ring-white/10';

        return `
            <div class="p-3">
                <div class="flex items-center gap-2">
                    <input type="text" value="${Utils.escapeHtml(item.name)}" placeholder="名前"
                        onchange="app.recurring.updateField(${item.id}, 'name', this.value)"
                        class="min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none focus:ring-2 focus:ring-indigo-500">
                    <input type="number" value="${item.amount ?? 0}"
                        onchange="app.recurring.updateField(${item.id}, 'amount', this.value)"
                        class="w-24 shrink-0 rounded-lg bg-white/5 px-2.5 py-2 text-right text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none focus:ring-2 focus:ring-indigo-500">
                    <span class="shrink-0 text-sm text-zinc-400">円</span>
                </div>
                <div class="mt-2 flex items-center gap-2">
                    <button type="button" class="payer-chip shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${chipClasses}" onclick="app.recurring.togglePayer(${item.id})">${isWife ? '妻' : '夫'}</button>
                    <input type="text" value="${Utils.escapeHtml(item.note || '')}" placeholder="備考（任意）"
                        onchange="app.recurring.updateField(${item.id}, 'note', this.value)"
                        class="min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500">
                    <button class="delete-btn shrink-0 rounded-md bg-rose-500/10 px-2.5 py-1.5 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/20" onclick="app.recurring.remove(${item.id})">削除</button>
                </div>
            </div>
        `;
    }
}
