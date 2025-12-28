/**
 * 買い物リストモジュール
 * 買い物アイテム管理、テンプレート機能を提供
 */

import { db, doc, collection, addDoc, updateDoc, deleteDoc, query, orderBy, onSnapshot } from './firebase-config.js';
import { Utils } from './utils.js';

// ============================================================
// 定数定義
// ============================================================

/** カテゴリ別絵文字 */
const CATEGORY_EMOJIS = {
    '野菜・果物': '🥬', '肉・魚': '🍖', '乳製品・卵': '🥛', '調味料': '🧂',
    '飲料': '🥤', 'お菓子': '🍪', '日用品': '🧴', 'その他': '📦'
};

/** カテゴリ推測用キーワード */
const CATEGORY_KEYWORDS = {
    '野菜・果物': ['野菜', '果物', 'りんご', 'みかん', 'バナナ', 'トマト', 'キャベツ', 'にんじん', 'たまねぎ', '玉ねぎ', 'レタス', 'きゅうり', 'なす', 'ピーマン', 'ほうれん草', '白菜', '大根', 'じゃがいも', 'さつまいも'],
    '肉・魚': ['肉', '魚', '鶏', '豚', '牛', 'ひき肉', '鮭', 'まぐろ', 'さば', 'えび', 'いか', 'ベーコン', 'ハム', 'ソーセージ', 'ウインナー'],
    '乳製品・卵': ['牛乳', 'ミルク', 'ヨーグルト', 'チーズ', 'バター', '卵', 'たまご', '生クリーム'],
    '調味料': ['醤油', 'しょうゆ', '味噌', 'みそ', '塩', '砂糖', '酢', 'みりん', '料理酒', 'マヨネーズ', 'ケチャップ', 'ソース', 'ドレッシング', '油', 'オリーブオイル'],
    '飲料': ['水', 'お茶', 'ジュース', 'コーヒー', '紅茶', 'ビール', '酒', 'ワイン', 'コーラ', 'サイダー'],
    'お菓子': ['お菓子', 'チョコ', 'クッキー', 'ポテチ', 'アイス', 'ケーキ', 'せんべい', 'ガム', '飴', 'グミ'],
    '日用品': ['洗剤', 'シャンプー', 'リンス', '石鹸', 'ティッシュ', 'トイレットペーパー', 'ラップ', 'アルミホイル', 'ゴミ袋', '歯磨き粉', '歯ブラシ', '綿棒']
};

// ============================================================
// 買い物リストクラス
// ============================================================

export class ShoppingList {
    /**
     * @param {Object} budgetManager - 予算管理インスタンス（購入履歴参照用）
     */
    constructor(budgetManager) {
        this.budgetManager = budgetManager;
        this.items = [];
        this.templates = [];
        this.editingTemplateId = null;
        this.tempTemplateItems = [];
        this.currentFilter = 'all';
        this.completedExpanded = false;
        this.categoryEmojis = CATEGORY_EMOJIS;
    }

    // ==================== 初期化 ====================

    async init() {
        await Promise.all([this.loadItems(), this.loadTemplates()]);
        this.setupSuggestions();
    }

    // ==================== 同期ステータス ====================

    showSyncStatus(status, message) {
        const el = document.getElementById('shoppingSyncStatus');
        if (!el) return;
        
        el.textContent = message;
        el.className = 'sync-status';
        
        const styles = {
            synced: { bg: 'rgba(56,239,125,0.2)', color: '#38ef7d' },
            syncing: { bg: 'rgba(255,193,7,0.2)', color: '#ffc107' },
            error: { bg: 'rgba(245,87,108,0.2)', color: '#f5576c' }
        };
        const s = styles[status] || styles.synced;
        el.style.background = s.bg;
        el.style.color = s.color;
    }

    // ==================== データ読み込み ====================

    async loadItems() {
        onSnapshot(query(collection(db, 'shoppingItems'), orderBy('createdAt', 'desc')), 
            (snap) => {
                this.items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                this.renderList();
                this.showSyncStatus('synced', '✓ 同期済み');
            },
            (err) => {
                console.error('買い物リスト読み込みエラー:', err);
                this.showSyncStatus('error', '✗ 接続エラー');
            }
        );
    }

    async loadTemplates() {
        onSnapshot(collection(db, 'shoppingTemplates'), (snap) => {
            this.templates = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        });
    }

    // ==================== 入力候補 ====================

    setupSuggestions() {
        const input = document.getElementById('newItemName');
        if (!input) return;
        
        input.addEventListener('input', () => this.updateSuggestions());
        input.addEventListener('focus', () => this.updateSuggestions());
        
        document.addEventListener('click', (e) => {
            const el = document.getElementById('shoppingSuggestions');
            if (el && !el.contains(e.target) && e.target.id !== 'newItemName') {
                el.style.display = 'none';
            }
        });
    }

    updateSuggestions() {
        const input = document.getElementById('newItemName');
        const suggestionsEl = document.getElementById('shoppingSuggestions');
        if (!input || !suggestionsEl) return;
        
        const inputValue = input.value.trim().toLowerCase();
        const history = this.getPurchaseHistory();
        
        const suggestions = inputValue.length > 0
            ? history.filter(i => i.name.toLowerCase().includes(inputValue)).slice(0, 8)
            : history.slice(0, 8);
        
        if (suggestions.length === 0) {
            suggestionsEl.style.display = 'none';
            return;
        }
        
        suggestionsEl.innerHTML = `
            <div class="suggestions-title">💡 過去の購入履歴から</div>
            <div class="suggestion-items">
                ${suggestions.map(i => `
                    <div class="suggestion-item" onclick="app.shopping.selectSuggestion('${i.name}','${i.category || 'その他'}')">
                        ${i.name}<span class="count">(${i.count}回)</span>
                    </div>
                `).join('')}
            </div>
        `;
        suggestionsEl.style.display = 'block';
    }

    getPurchaseHistory() {
        const history = {};
        
        Object.values(this.budgetManager.data).forEach(monthData => {
            if (!monthData.categories) return;
            
            monthData.categories.forEach(cat => {
                [cat, ...(cat.subcategories || [])].forEach(item => {
                    if (!item.name) return;
                    if (!history[item.name]) {
                        history[item.name] = { name: item.name, count: 0, category: this.guessCategory(item.name) };
                    }
                    history[item.name].count++;
                });
            });
        });
        
        return Object.values(history).sort((a, b) => b.count - a.count);
    }

    guessCategory(name) {
        for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
            if (keywords.some(kw => name.includes(kw))) return category;
        }
        return 'その他';
    }

    selectSuggestion(name, category) {
        document.getElementById('newItemName').value = name;
        document.getElementById('newItemCategory').value = category;
        document.getElementById('shoppingSuggestions').style.display = 'none';
    }

    // ==================== アイテム操作 ====================

    async addItem() {
        const name = document.getElementById('newItemName')?.value.trim();
        const category = document.getElementById('newItemCategory')?.value;
        const priority = document.getElementById('newItemPriority')?.value;
        const quantity = parseInt(document.getElementById('newItemQuantity')?.value) || 1;
        
        if (!name) return Utils.showToast('商品名を入力してください');
        
        this.showSyncStatus('syncing', '追加中...');
        
        try {
            await addDoc(collection(db, 'shoppingItems'), {
                name, category, priority, quantity,
                completed: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
            
            // 入力欄をリセット
            document.getElementById('newItemName').value = '';
            document.getElementById('newItemQuantity').value = '1';
            document.getElementById('newItemPriority').value = 'normal';
            document.getElementById('shoppingSuggestions').style.display = 'none';
            
            Utils.showToast('追加しました');
        } catch (err) {
            console.error('アイテム追加エラー:', err);
            this.showSyncStatus('error', '✗ エラー');
            Utils.showToast('追加に失敗しました');
        }
    }

    async toggleComplete(itemId) {
        const item = this.items.find(i => i.id === itemId);
        if (!item) return;
        
        try {
            await updateDoc(doc(db, 'shoppingItems', itemId), {
                completed: !item.completed,
                updatedAt: new Date().toISOString()
            });
        } catch (err) {
            console.error('更新エラー:', err);
            Utils.showToast('更新に失敗しました');
        }
    }

    async deleteItem(itemId) {
        if (!confirm('このアイテムを削除しますか？')) return;
        
        try {
            await deleteDoc(doc(db, 'shoppingItems', itemId));
            Utils.showToast('削除しました');
        } catch (err) {
            console.error('削除エラー:', err);
            Utils.showToast('削除に失敗しました');
        }
    }

    async clearCompleted() {
        const completedItems = this.items.filter(i => i.completed);
        if (completedItems.length === 0) return Utils.showToast('購入済みアイテムがありません');
        if (!confirm(`購入済みの${completedItems.length}件を削除しますか？`)) return;
        
        try {
            await Promise.all(completedItems.map(i => deleteDoc(doc(db, 'shoppingItems', i.id))));
            Utils.showToast('削除しました');
        } catch (err) {
            console.error('削除エラー:', err);
            Utils.showToast('削除に失敗しました');
        }
    }

    // ==================== フィルター ====================

    filterItems() {
        this.currentFilter = document.getElementById('shoppingFilter')?.value || 'all';
        this.renderList();
    }

    toggleCompleted() {
        this.completedExpanded = !this.completedExpanded;
        const toggle = document.getElementById('completedToggle');
        const list = document.getElementById('completedList');
        
        toggle?.classList.toggle('open', this.completedExpanded);
        if (list) list.style.display = this.completedExpanded ? 'block' : 'none';
    }

    // ==================== 描画 ====================

    renderList() {
        const listEl = document.getElementById('shoppingList');
        const completedListEl = document.getElementById('completedList');
        const completedSection = document.getElementById('completedSection');
        const countEl = document.getElementById('shoppingCount');
        const completedCountEl = document.getElementById('completedCount');
        if (!listEl) return;
        
        let uncompleted = this.items.filter(i => !i.completed);
        const completed = this.items.filter(i => i.completed);
        
        if (this.currentFilter === 'high') {
            uncompleted = uncompleted.filter(i => i.priority === 'high');
        }
        
        // 優先度でソート
        uncompleted.sort((a, b) => {
            const order = { high: 0, normal: 1, low: 2 };
            return order[a.priority] - order[b.priority];
        });
        
        // カテゴリでグループ化
        const grouped = {};
        uncompleted.forEach(item => {
            const cat = item.category || 'その他';
            (grouped[cat] = grouped[cat] || []).push(item);
        });
        
        countEl.textContent = `${uncompleted.length}件`;
        completedCountEl.textContent = completed.length;
        
        // 未購入リスト
        if (uncompleted.length === 0) {
            listEl.innerHTML = '<div class="shopping-empty"><div class="shopping-empty-icon">🛒</div><div class="shopping-empty-text">買い物リストは空です</div></div>';
        } else {
            listEl.innerHTML = Object.entries(grouped).map(([cat, items]) => `
                <div class="shopping-category-group">
                    <div class="shopping-category-header">${this.categoryEmojis[cat] || '📦'} ${cat}</div>
                    ${items.map(i => this.renderItem(i)).join('')}
                </div>
            `).join('');
        }
        
        // 購入済みリスト
        if (completed.length > 0) {
            completedSection.style.display = 'block';
            completedListEl.innerHTML = completed.map(i => this.renderItem(i, true)).join('');
        } else {
            completedSection.style.display = 'none';
        }
    }

    renderItem(item, isCompleted = false) {
        const priorityClass = item.priority === 'high' ? 'high-priority' : item.priority === 'low' ? 'low-priority' : '';
        
        return `
            <div class="shopping-item ${priorityClass} ${isCompleted ? 'completed' : ''}">
                <div class="shopping-checkbox ${isCompleted ? 'checked' : ''}" onclick="app.shopping.toggleComplete('${item.id}')"></div>
                <div class="shopping-item-content">
                    <div class="shopping-item-name">
                        ${item.name}
                        ${item.priority === 'high' ? '<span class="priority-badge">急ぎ</span>' : ''}
                    </div>
                    <div class="shopping-item-meta">
                        <span>${this.categoryEmojis[item.category] || '📦'} ${item.category}</span>
                    </div>
                </div>
                <div class="shopping-item-quantity">×${item.quantity}</div>
                <button class="shopping-item-delete" onclick="app.shopping.deleteItem('${item.id}')">✕</button>
            </div>
        `;
    }

    // ==================== テンプレート機能 ====================

    showTemplates() {
        const modal = document.getElementById('templateSelectModal');
        const listEl = document.getElementById('templateList');
        
        listEl.innerHTML = this.templates.length === 0
            ? '<div class="shopping-empty"><div class="shopping-empty-text">テンプレートがありません</div></div>'
            : this.templates.map(t => `
                <div class="template-list-item" onclick="app.shopping.applyTemplate('${t.id}')">
                    <div class="template-info">
                        <div class="template-name">${t.name}</div>
                        <div class="template-count">${t.items?.length || 0}件のアイテム</div>
                    </div>
                </div>
            `).join('');
        
        Utils.showModal('templateSelectModal');
    }

    closeTemplateSelect() { Utils.closeModal('templateSelectModal'); }

    async applyTemplate(templateId) {
        const template = this.templates.find(t => t.id === templateId);
        if (!template?.items) return;
        
        this.closeTemplateSelect();
        this.showSyncStatus('syncing', '追加中...');
        
        try {
            for (const item of template.items) {
                await addDoc(collection(db, 'shoppingItems'), {
                    name: item.name, category: item.category, priority: 'normal', quantity: 1,
                    completed: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
                });
            }
            Utils.showToast(`${template.items.length}件を追加しました`);
        } catch (err) {
            console.error('テンプレート適用エラー:', err);
            Utils.showToast('追加に失敗しました');
        }
    }

    // ==================== テンプレート管理 ====================

    showTemplateManager() {
        const listEl = document.getElementById('templateManagerList');
        
        listEl.innerHTML = this.templates.length === 0
            ? '<div class="shopping-empty"><div class="shopping-empty-text">テンプレートがありません</div></div>'
            : this.templates.map(t => `
                <div class="template-list-item">
                    <div class="template-info">
                        <div class="template-name">${t.name}</div>
                        <div class="template-count">${t.items?.length || 0}件のアイテム</div>
                    </div>
                    <div class="template-actions">
                        <button class="template-edit-btn" onclick="app.shopping.editTemplate('${t.id}')">編集</button>
                        <button class="template-delete-btn" onclick="app.shopping.deleteTemplateFromList('${t.id}')">削除</button>
                    </div>
                </div>
            `).join('');
        
        Utils.showModal('templateManagerModal');
    }

    closeTemplateManager() { Utils.closeModal('templateManagerModal'); }

    showTemplateForm(templateId = null) {
        this.editingTemplateId = templateId;
        const template = templateId ? this.templates.find(t => t.id === templateId) : null;
        
        document.getElementById('templateFormTitle').textContent = templateId ? '✏️ テンプレート編集' : '➕ 新規テンプレート作成';
        document.getElementById('templateName').value = template?.name || '';
        document.getElementById('deleteTemplateBtn').style.display = templateId ? 'block' : 'none';
        this.tempTemplateItems = template?.items ? [...template.items] : [];
        
        this.renderTemplateItems();
        Utils.closeModal('templateManagerModal');
        Utils.showModal('templateFormModal');
    }

    editTemplate(templateId) { this.showTemplateForm(templateId); }
    closeTemplateForm() { Utils.closeModal('templateFormModal'); Utils.showModal('templateManagerModal'); }

    renderTemplateItems() {
        const el = document.getElementById('templateItemsList');
        
        if (this.tempTemplateItems.length === 0) {
            el.innerHTML = '<div style="text-align:center;color:rgba(255,255,255,0.5);padding:20px;">アイテムを追加してください</div>';
            return;
        }
        
        el.innerHTML = this.tempTemplateItems.map((item, idx) => `
            <div class="template-item-row">
                <span class="item-name">${item.name}</span>
                <span class="item-category">${this.categoryEmojis[item.category] || '📦'} ${item.category}</span>
                <button class="remove-item" onclick="app.shopping.removeTemplateItem(${idx})">✕</button>
            </div>
        `).join('');
    }

    addTemplateItem() {
        const name = document.getElementById('templateItemName')?.value.trim();
        const category = document.getElementById('templateItemCategory')?.value;
        
        if (!name) return Utils.showToast('商品名を入力してください');
        
        this.tempTemplateItems.push({ name, category });
        document.getElementById('templateItemName').value = '';
        this.renderTemplateItems();
    }

    removeTemplateItem(index) {
        this.tempTemplateItems.splice(index, 1);
        this.renderTemplateItems();
    }

    async saveTemplate() {
        const name = document.getElementById('templateName')?.value.trim();
        
        if (!name) return Utils.showToast('テンプレート名を入力してください');
        if (this.tempTemplateItems.length === 0) return Utils.showToast('アイテムを追加してください');
        
        try {
            const data = { name, items: this.tempTemplateItems, updatedAt: new Date().toISOString() };
            
            if (this.editingTemplateId) {
                await updateDoc(doc(db, 'shoppingTemplates', this.editingTemplateId), data);
                Utils.showToast('更新しました');
            } else {
                data.createdAt = new Date().toISOString();
                await addDoc(collection(db, 'shoppingTemplates'), data);
                Utils.showToast('作成しました');
            }
            
            this.closeTemplateForm();
            this.showTemplateManager();
        } catch (err) {
            console.error('テンプレート保存エラー:', err);
            Utils.showToast('保存に失敗しました');
        }
    }

    async deleteTemplate() {
        if (!this.editingTemplateId || !confirm('このテンプレートを削除しますか？')) return;
        
        try {
            await deleteDoc(doc(db, 'shoppingTemplates', this.editingTemplateId));
            Utils.showToast('削除しました');
            this.closeTemplateForm();
            this.showTemplateManager();
        } catch (err) {
            console.error('テンプレート削除エラー:', err);
            Utils.showToast('削除に失敗しました');
        }
    }

    async deleteTemplateFromList(templateId) {
        if (!confirm('このテンプレートを削除しますか？')) return;
        
        try {
            await deleteDoc(doc(db, 'shoppingTemplates', templateId));
            Utils.showToast('削除しました');
            this.showTemplateManager();
        } catch (err) {
            console.error('テンプレート削除エラー:', err);
            Utils.showToast('削除に失敗しました');
        }
    }
}
