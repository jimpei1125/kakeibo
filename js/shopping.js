import { db, doc, collection, addDoc, updateDoc, deleteDoc, query, orderBy, onSnapshot } from './firebase-config.js';
import { Utils } from './utils.js';

// 買い物リストクラス
export class ShoppingList {
    constructor(budgetManager) {
        this.budgetManager = budgetManager;
        this.items = [];
        this.templates = [];
        this.editingTemplateId = null;
        this.tempTemplateItems = [];
        this.currentFilter = 'all';
        this.completedExpanded = false;
        
        this.categoryEmojis = {
            '野菜・果物': '🥬',
            '肉・魚': '🍖',
            '乳製品・卵': '🥛',
            '調味料': '🧂',
            '飲料': '🥤',
            'お菓子': '🍪',
            '日用品': '🧴',
            'その他': '📦'
        };
    }

    async init() {
        await this.loadItems();
        await this.loadTemplates();
        this.setupSuggestions();
    }

    showSyncStatus(status, message) {
        const statusEl = document.getElementById('shoppingSyncStatus');
        if (!statusEl) return;
        
        statusEl.textContent = message;
        statusEl.className = 'sync-status';
        
        if (status === 'synced') {
            statusEl.style.background = 'rgba(56, 239, 125, 0.2)';
            statusEl.style.color = '#38ef7d';
        } else if (status === 'syncing') {
            statusEl.style.background = 'rgba(255, 193, 7, 0.2)';
            statusEl.style.color = '#ffc107';
        } else if (status === 'error') {
            statusEl.style.background = 'rgba(245, 87, 108, 0.2)';
            statusEl.style.color = '#f5576c';
        }
    }

    async loadItems() {
        const itemsCol = collection(db, 'shoppingItems');
        const q = query(itemsCol, orderBy('createdAt', 'desc'));
        
        onSnapshot(q, (snapshot) => {
            this.items = [];
            snapshot.forEach(doc => {
                this.items.push({
                    id: doc.id,
                    ...doc.data()
                });
            });
            this.renderList();
            this.showSyncStatus('synced', '✓ 同期済み');
        }, (error) => {
            console.error('買い物リスト読み込みエラー:', error);
            this.showSyncStatus('error', '✗ 接続エラー');
        });
    }

    async loadTemplates() {
        const templatesCol = collection(db, 'shoppingTemplates');
        
        onSnapshot(templatesCol, (snapshot) => {
            this.templates = [];
            snapshot.forEach(doc => {
                this.templates.push({
                    id: doc.id,
                    ...doc.data()
                });
            });
        });
    }

    setupSuggestions() {
        const input = document.getElementById('newItemName');
        if (!input) return;
        
        input.addEventListener('input', () => this.updateSuggestions());
        input.addEventListener('focus', () => this.updateSuggestions());
        
        document.addEventListener('click', (e) => {
            const suggestionsEl = document.getElementById('shoppingSuggestions');
            if (suggestionsEl && !suggestionsEl.contains(e.target) && e.target.id !== 'newItemName') {
                suggestionsEl.style.display = 'none';
            }
        });
    }

    updateSuggestions() {
        const input = document.getElementById('newItemName');
        const suggestionsEl = document.getElementById('shoppingSuggestions');
        if (!input || !suggestionsEl) return;
        
        const inputValue = input.value.trim().toLowerCase();
        
        const purchaseHistory = this.getPurchaseHistory();
        
        let suggestions = [];
        if (inputValue.length > 0) {
            suggestions = purchaseHistory.filter(item => 
                item.name.toLowerCase().includes(inputValue)
            ).slice(0, 8);
        } else {
            suggestions = purchaseHistory.slice(0, 8);
        }
        
        if (suggestions.length === 0) {
            suggestionsEl.style.display = 'none';
            return;
        }
        
        let html = '<div class="suggestions-title">💡 過去の購入履歴から</div>';
        html += '<div class="suggestion-items">';
        suggestions.forEach(item => {
            html += `<div class="suggestion-item" onclick="app.shopping.selectSuggestion('${item.name}', '${item.category || 'その他'}')">
                ${item.name}
                <span class="count">(${item.count}回)</span>
            </div>`;
        });
        html += '</div>';
        
        suggestionsEl.innerHTML = html;
        suggestionsEl.style.display = 'block';
    }

    getPurchaseHistory() {
        const history = {};
        const budgetData = this.budgetManager.data;
        
        Object.values(budgetData).forEach(monthData => {
            if (!monthData.categories) return;
            
            monthData.categories.forEach(category => {
                if (category.name) {
                    const name = category.name;
                    if (!history[name]) {
                        history[name] = { name, count: 0, category: this.guessCategory(name) };
                    }
                    history[name].count++;
                }
                
                if (category.subcategories) {
                    category.subcategories.forEach(sub => {
                        const name = sub.name;
                        if (!history[name]) {
                            history[name] = { name, count: 0, category: this.guessCategory(name) };
                        }
                        history[name].count++;
                    });
                }
            });
        });
        
        return Object.values(history).sort((a, b) => b.count - a.count);
    }

    guessCategory(name) {
        const categoryKeywords = {
            '野菜・果物': ['野菜', '果物', 'りんご', 'みかん', 'バナナ', 'トマト', 'キャベツ', 'にんじん', 'たまねぎ', '玉ねぎ', 'レタス', 'きゅうり', 'なす', 'ピーマン', 'ほうれん草', '白菜', '大根', 'じゃがいも', 'さつまいも'],
            '肉・魚': ['肉', '魚', '鶏', '豚', '牛', 'ひき肉', '鮭', 'まぐろ', 'さば', 'えび', 'いか', 'ベーコン', 'ハム', 'ソーセージ', 'ウインナー'],
            '乳製品・卵': ['牛乳', 'ミルク', 'ヨーグルト', 'チーズ', 'バター', '卵', 'たまご', '生クリーム'],
            '調味料': ['醤油', 'しょうゆ', '味噌', 'みそ', '塩', '砂糖', '酢', 'みりん', '料理酒', 'マヨネーズ', 'ケチャップ', 'ソース', 'ドレッシング', '油', 'オリーブオイル'],
            '飲料': ['水', 'お茶', 'ジュース', 'コーヒー', '紅茶', 'ビール', '酒', 'ワイン', 'コーラ', 'サイダー'],
            'お菓子': ['お菓子', 'チョコ', 'クッキー', 'ポテチ', 'アイス', 'ケーキ', 'せんべい', 'ガム', '飴', 'グミ'],
            '日用品': ['洗剤', 'シャンプー', 'リンス', '石鹸', 'ティッシュ', 'トイレットペーパー', 'ラップ', 'アルミホイル', 'ゴミ袋', '歯磨き粉', '歯ブラシ', '綿棒']
        };
        
        for (const [category, keywords] of Object.entries(categoryKeywords)) {
            if (keywords.some(keyword => name.includes(keyword))) {
                return category;
            }
        }
        return 'その他';
    }

    selectSuggestion(name, category) {
        document.getElementById('newItemName').value = name;
        document.getElementById('newItemCategory').value = category;
        document.getElementById('shoppingSuggestions').style.display = 'none';
    }

    async addItem() {
        const name = document.getElementById('newItemName').value.trim();
        const category = document.getElementById('newItemCategory').value;
        const priority = document.getElementById('newItemPriority').value;
        const quantity = parseInt(document.getElementById('newItemQuantity').value) || 1;
        
        if (!name) {
            Utils.showToast('商品名を入力してください');
            return;
        }
        
        this.showSyncStatus('syncing', '追加中...');
        
        try {
            await addDoc(collection(db, 'shoppingItems'), {
                name,
                category,
                priority,
                quantity,
                completed: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
            
            document.getElementById('newItemName').value = '';
            document.getElementById('newItemQuantity').value = '1';
            document.getElementById('newItemPriority').value = 'normal';
            document.getElementById('shoppingSuggestions').style.display = 'none';
            
            Utils.showToast('追加しました');
        } catch (error) {
            console.error('アイテム追加エラー:', error);
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
        } catch (error) {
            console.error('更新エラー:', error);
            Utils.showToast('更新に失敗しました');
        }
    }

    async deleteItem(itemId) {
        if (!confirm('このアイテムを削除しますか？')) return;
        
        try {
            await deleteDoc(doc(db, 'shoppingItems', itemId));
            Utils.showToast('削除しました');
        } catch (error) {
            console.error('削除エラー:', error);
            Utils.showToast('削除に失敗しました');
        }
    }

    async clearCompleted() {
        const completedItems = this.items.filter(i => i.completed);
        if (completedItems.length === 0) {
            Utils.showToast('購入済みアイテムがありません');
            return;
        }
        
        if (!confirm(`購入済みの${completedItems.length}件を削除しますか？`)) return;
        
        try {
            for (const item of completedItems) {
                await deleteDoc(doc(db, 'shoppingItems', item.id));
            }
            Utils.showToast('削除しました');
        } catch (error) {
            console.error('削除エラー:', error);
            Utils.showToast('削除に失敗しました');
        }
    }

    filterItems() {
        this.currentFilter = document.getElementById('shoppingFilter').value;
        this.renderList();
    }

    toggleCompleted() {
        this.completedExpanded = !this.completedExpanded;
        const toggle = document.getElementById('completedToggle');
        const list = document.getElementById('completedList');
        
        if (this.completedExpanded) {
            toggle.classList.add('open');
            list.style.display = 'block';
        } else {
            toggle.classList.remove('open');
            list.style.display = 'none';
        }
    }

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
        
        uncompleted.sort((a, b) => {
            const priorityOrder = { high: 0, normal: 1, low: 2 };
            return priorityOrder[a.priority] - priorityOrder[b.priority];
        });
        
        const grouped = {};
        uncompleted.forEach(item => {
            const cat = item.category || 'その他';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(item);
        });
        
        countEl.textContent = uncompleted.length + '件';
        completedCountEl.textContent = completed.length;
        
        if (uncompleted.length === 0) {
            listEl.innerHTML = `
                <div class="shopping-empty">
                    <div class="shopping-empty-icon">🛒</div>
                    <div class="shopping-empty-text">買い物リストは空です</div>
                </div>
            `;
        } else {
            let html = '';
            for (const [category, items] of Object.entries(grouped)) {
                html += `<div class="shopping-category-group">`;
                html += `<div class="shopping-category-header">${this.categoryEmojis[category] || '📦'} ${category}</div>`;
                
                items.forEach(item => {
                    html += this.renderItem(item);
                });
                
                html += `</div>`;
            }
            listEl.innerHTML = html;
        }
        
        if (completed.length > 0) {
            completedSection.style.display = 'block';
            let completedHtml = '';
            completed.forEach(item => {
                completedHtml += this.renderItem(item, true);
            });
            completedListEl.innerHTML = completedHtml;
        } else {
            completedSection.style.display = 'none';
        }
    }

    renderItem(item, isCompleted = false) {
        const priorityClass = item.priority === 'high' ? 'high-priority' : (item.priority === 'low' ? 'low-priority' : '');
        const completedClass = isCompleted ? 'completed' : '';
        
        return `
            <div class="shopping-item ${priorityClass} ${completedClass}">
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

    // テンプレート機能
    showTemplates() {
        const modal = document.getElementById('templateSelectModal');
        const listEl = document.getElementById('templateList');
        
        if (this.templates.length === 0) {
            listEl.innerHTML = `
                <div class="shopping-empty">
                    <div class="shopping-empty-text">テンプレートがありません</div>
                </div>
            `;
        } else {
            let html = '';
            this.templates.forEach(template => {
                html += `
                    <div class="template-list-item" onclick="app.shopping.applyTemplate('${template.id}')">
                        <div class="template-info">
                            <div class="template-name">${template.name}</div>
                            <div class="template-count">${template.items ? template.items.length : 0}件のアイテム</div>
                        </div>
                    </div>
                `;
            });
            listEl.innerHTML = html;
        }
        
        modal.classList.add('show');
    }

    closeTemplateSelect() {
        document.getElementById('templateSelectModal').classList.remove('show');
    }

    async applyTemplate(templateId) {
        const template = this.templates.find(t => t.id === templateId);
        if (!template || !template.items) return;
        
        this.closeTemplateSelect();
        this.showSyncStatus('syncing', '追加中...');
        
        try {
            for (const item of template.items) {
                await addDoc(collection(db, 'shoppingItems'), {
                    name: item.name,
                    category: item.category,
                    priority: 'normal',
                    quantity: 1,
                    completed: false,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
            }
            Utils.showToast(`${template.items.length}件を追加しました`);
        } catch (error) {
            console.error('テンプレート適用エラー:', error);
            Utils.showToast('追加に失敗しました');
        }
    }

    showTemplateManager() {
        const modal = document.getElementById('templateManagerModal');
        const listEl = document.getElementById('templateManagerList');
        
        if (this.templates.length === 0) {
            listEl.innerHTML = `
                <div class="shopping-empty">
                    <div class="shopping-empty-text">テンプレートがありません</div>
                </div>
            `;
        } else {
            let html = '';
            this.templates.forEach(template => {
                html += `
                    <div class="template-list-item">
                        <div class="template-info">
                            <div class="template-name">${template.name}</div>
                            <div class="template-count">${template.items ? template.items.length : 0}件のアイテム</div>
                        </div>
                        <div class="template-actions">
                            <button class="template-edit-btn" onclick="app.shopping.editTemplate('${template.id}')">編集</button>
                            <button class="template-delete-btn" onclick="app.shopping.deleteTemplateFromList('${template.id}')">削除</button>
                        </div>
                    </div>
                `;
            });
            listEl.innerHTML = html;
        }
        
        modal.classList.add('show');
    }

    closeTemplateManager() {
        document.getElementById('templateManagerModal').classList.remove('show');
    }

    showTemplateForm(templateId = null) {
        this.editingTemplateId = templateId;
        this.tempTemplateItems = [];
        
        const modal = document.getElementById('templateFormModal');
        const titleEl = document.getElementById('templateFormTitle');
        const nameInput = document.getElementById('templateName');
        const deleteBtn = document.getElementById('deleteTemplateBtn');
        
        if (templateId) {
            const template = this.templates.find(t => t.id === templateId);
            titleEl.textContent = '✏️ テンプレート編集';
            nameInput.value = template.name;
            this.tempTemplateItems = [...(template.items || [])];
            deleteBtn.style.display = 'block';
        } else {
            titleEl.textContent = '➕ 新規テンプレート作成';
            nameInput.value = '';
            deleteBtn.style.display = 'none';
        }
        
        this.renderTemplateItems();
        document.getElementById('templateManagerModal').classList.remove('show');
        modal.classList.add('show');
    }

    editTemplate(templateId) {
        this.showTemplateForm(templateId);
    }

    closeTemplateForm() {
        document.getElementById('templateFormModal').classList.remove('show');
        document.getElementById('templateManagerModal').classList.add('show');
    }

    renderTemplateItems() {
        const listEl = document.getElementById('templateItemsList');
        
        if (this.tempTemplateItems.length === 0) {
            listEl.innerHTML = '<div style="text-align: center; color: rgba(255,255,255,0.5); padding: 20px;">アイテムを追加してください</div>';
            return;
        }
        
        let html = '';
        this.tempTemplateItems.forEach((item, index) => {
            html += `
                <div class="template-item-row">
                    <span class="item-name">${item.name}</span>
                    <span class="item-category">${this.categoryEmojis[item.category] || '📦'} ${item.category}</span>
                    <button class="remove-item" onclick="app.shopping.removeTemplateItem(${index})">✕</button>
                </div>
            `;
        });
        
        listEl.innerHTML = html;
    }

    addTemplateItem() {
        const name = document.getElementById('templateItemName').value.trim();
        const category = document.getElementById('templateItemCategory').value;
        
        if (!name) {
            Utils.showToast('商品名を入力してください');
            return;
        }
        
        this.tempTemplateItems.push({ name, category });
        document.getElementById('templateItemName').value = '';
        this.renderTemplateItems();
    }

    removeTemplateItem(index) {
        this.tempTemplateItems.splice(index, 1);
        this.renderTemplateItems();
    }

    async saveTemplate() {
        const name = document.getElementById('templateName').value.trim();
        
        if (!name) {
            Utils.showToast('テンプレート名を入力してください');
            return;
        }
        
        if (this.tempTemplateItems.length === 0) {
            Utils.showToast('アイテムを追加してください');
            return;
        }
        
        try {
            if (this.editingTemplateId) {
                await updateDoc(doc(db, 'shoppingTemplates', this.editingTemplateId), {
                    name,
                    items: this.tempTemplateItems,
                    updatedAt: new Date().toISOString()
                });
                Utils.showToast('更新しました');
            } else {
                await addDoc(collection(db, 'shoppingTemplates'), {
                    name,
                    items: this.tempTemplateItems,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
                Utils.showToast('作成しました');
            }
            
            this.closeTemplateForm();
            this.showTemplateManager();
        } catch (error) {
            console.error('テンプレート保存エラー:', error);
            Utils.showToast('保存に失敗しました');
        }
    }

    async deleteTemplate() {
        if (!this.editingTemplateId) return;
        if (!confirm('このテンプレートを削除しますか？')) return;
        
        try {
            await deleteDoc(doc(db, 'shoppingTemplates', this.editingTemplateId));
            Utils.showToast('削除しました');
            this.closeTemplateForm();
            this.showTemplateManager();
        } catch (error) {
            console.error('テンプレート削除エラー:', error);
            Utils.showToast('削除に失敗しました');
        }
    }

    async deleteTemplateFromList(templateId) {
        if (!confirm('このテンプレートを削除しますか？')) return;
        
        try {
            await deleteDoc(doc(db, 'shoppingTemplates', templateId));
            Utils.showToast('削除しました');
            this.showTemplateManager();
        } catch (error) {
            console.error('テンプレート削除エラー:', error);
            Utils.showToast('削除に失敗しました');
        }
    }
}
