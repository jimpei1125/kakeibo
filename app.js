import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getFirestore, doc, setDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

// Firebase設定
const firebaseConfig = {
    apiKey: "AIzaSyBhFzS8r2T4zvaEwC6EbH4wbt2sEuf9sEE",
    authDomain: "kakeibo-cc964.firebaseapp.com",
    projectId: "kakeibo-cc964",
    storageBucket: "kakeibo-cc964.firebasestorage.app",
    messagingSenderId: "120845540864",
    appId: "1:120845540864:web:a7a3d776ba900f2e0202e5"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// ユーティリティクラス
class Utils {
    static showToast(message) {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2000);
    }

    static getJSTDate() {
        const today = new Date();
        const jstOffset = 9 * 60;
        return new Date(today.getTime() + (today.getTimezoneOffset() + jstOffset) * 60000);
    }
}

// 計算機クラス
class Calculator {
    constructor() {
        this.expression = '';
    }

    show() {
        document.getElementById('calculatorModal').classList.add('show');
        this.clear();
    }

    close() {
        document.getElementById('calculatorModal').classList.remove('show');
    }

    clear() {
        this.expression = '';
        document.getElementById('calcDisplay').textContent = '0';
    }

    append(value) {
        if (this.expression === '0' || this.expression === 'エラー') {
            this.expression = value;
        } else {
            this.expression += value;
        }
        document.getElementById('calcDisplay').textContent = this.expression;
    }

    calculate() {
        try {
            let expression = this.expression.replace(/×/g, '*').replace(/÷/g, '/');
            let result = eval(expression);
            result = Math.round(result * 100) / 100;
            this.expression = result.toString();
            document.getElementById('calcDisplay').textContent = result;
        } catch (error) {
            document.getElementById('calcDisplay').textContent = 'エラー';
            this.expression = 'エラー';
        }
    }

    copyResult() {
        const result = document.getElementById('calcDisplay').textContent;
        if (result && result !== '0' && result !== 'エラー') {
            const textarea = document.createElement('textarea');
            textarea.value = result;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            
            try {
                document.execCommand('copy');
                document.body.removeChild(textarea);
                Utils.showToast('コピーしました！');
            } catch (err) {
                document.body.removeChild(textarea);
                Utils.showToast('コピーに失敗しました');
            }
        }
    }
}

// CSV出力クラス
class CSVExporter {
    constructor(budgetManager) {
        this.budgetManager = budgetManager;
    }

    showModal() {
        document.getElementById('csvModal').classList.add('show');
    }

    closeModal() {
        document.getElementById('csvModal').classList.remove('show');
    }

    toggleDateRange() {
        const rangeType = document.getElementById('csvRangeType').value;
        const dateRangeInputs = document.getElementById('dateRangeInputs');
        
        if (rangeType === 'range') {
            dateRangeInputs.style.display = 'block';
            const today = new Date();
            const currentMonth = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0');
            document.getElementById('csvStartDate').value = currentMonth;
            document.getElementById('csvEndDate').value = currentMonth;
        } else {
            dateRangeInputs.style.display = 'none';
        }
    }

    export() {
        const rangeType = document.getElementById('csvRangeType').value;
        const includeNotes = document.getElementById('csvIncludeNotes').checked;
        const includeHalf = document.getElementById('csvIncludeHalf').checked;
        
        let monthsToExport = [];
        const budgetData = this.budgetManager.data;
        
        if (rangeType === 'current') {
            monthsToExport.push(this.budgetManager.getCurrentMonthKey());
        } else if (rangeType === 'all') {
            monthsToExport = Object.keys(budgetData).sort();
        } else if (rangeType === 'range') {
            const startDate = document.getElementById('csvStartDate').value;
            const endDate = document.getElementById('csvEndDate').value;
            
            if (!startDate || !endDate) {
                alert('開始年月と終了年月を選択してください');
                return;
            }
            
            const start = new Date(startDate + '-01');
            const end = new Date(endDate + '-01');
            
            if (start > end) {
                alert('開始年月は終了年月より前に設定してください');
                return;
            }
            
            Object.keys(budgetData).forEach(key => {
                const date = new Date(key + '-01');
                if (date >= start && date <= end) {
                    monthsToExport.push(key);
                }
            });
            
            monthsToExport.sort();
        }
        
        if (monthsToExport.length === 0) {
            alert('出力するデータがありません');
            return;
        }
        
        let csvContent = '\uFEFF';
        let headers = ['年月', '大カテゴリー', '小カテゴリー', '金額'];
        if (includeHalf) headers.push('折半金額');
        if (includeNotes) headers.push('備考');
        csvContent += headers.join(',') + '\n';
        
        monthsToExport.forEach(monthKey => {
            const monthData = budgetData[monthKey];
            if (!monthData || !monthData.categories) return;
            
            monthData.categories.forEach(category => {
                if (category.subcategories && category.subcategories.length > 0) {
                    category.subcategories.forEach(sub => {
                        let row = [
                            monthKey,
                            '"' + category.name + '"',
                            '"' + sub.name + '"',
                            sub.amount || 0
                        ];
                        
                        if (includeHalf) row.push(Math.round((sub.amount || 0) / 2));
                        if (includeNotes) row.push('"' + (sub.note || '') + '"');
                        
                        csvContent += row.join(',') + '\n';
                    });
                } else {
                    let row = [
                        monthKey,
                        '"' + category.name + '"',
                        '',
                        category.amount || 0
                    ];
                    
                    if (includeHalf) row.push(Math.round((category.amount || 0) / 2));
                    if (includeNotes) row.push('"' + (category.note || '') + '"');
                    
                    csvContent += row.join(',') + '\n';
                }
            });
        });
        
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        
        const filename = rangeType === 'current' 
            ? '家計簿_' + this.budgetManager.getCurrentMonthKey() + '.csv'
            : rangeType === 'all'
            ? '家計簿_全期間.csv'
            : '家計簿_' + document.getElementById('csvStartDate').value + '_' + document.getElementById('csvEndDate').value + '.csv';
        
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        Utils.showToast('CSVファイルをダウンロードしました');
        this.closeModal();
    }
}

// カレンダー管理クラス
class CalendarManager {
    constructor() {
        this.currentYear = new Date().getFullYear();
        this.currentMonth = new Date().getMonth() + 1;
        this.data = { events: {}, todos: {} };
        this.selectedEventId = null;
        this.selectedDate = null;
        this.isEditMode = false;
    }

    async loadFromFirestore() {
        const docRef = doc(db, 'calendarData', 'data');
        
        onSnapshot(docRef, (docSnap) => {
            if (docSnap.exists()) {
                this.data = docSnap.data();
                if (!this.data.events) this.data.events = {};
                if (!this.data.todos) this.data.todos = {};
                this.renderCalendar();
            }
        });
    }

    async saveToFirestore() {
        try {
            const docRef = doc(db, 'calendarData', 'data');
            await setDoc(docRef, this.data);
        } catch (error) {
            console.error('カレンダーデータ保存エラー:', error);
            Utils.showToast('保存に失敗しました');
        }
    }

    changeMonth(delta) {
        this.currentMonth += delta;
        if (this.currentMonth > 12) {
            this.currentMonth = 1;
            this.currentYear++;
        } else if (this.currentMonth < 1) {
            this.currentMonth = 12;
            this.currentYear--;
        }
        this.renderCalendar();
    }

    goToToday() {
        const today = new Date();
        this.currentYear = today.getFullYear();
        this.currentMonth = today.getMonth() + 1;
        this.renderCalendar();
    }

    renderCalendar() {
        document.getElementById('calendarMonthDisplay').textContent = 
            this.currentYear + '年 ' + this.currentMonth + '月';

        const firstDay = new Date(this.currentYear, this.currentMonth - 1, 1);
        const lastDay = new Date(this.currentYear, this.currentMonth, 0);
        const daysInMonth = lastDay.getDate();
        const startDayOfWeek = firstDay.getDay();

        let html = '';
        
        // 曜日ヘッダー
        ['日', '月', '火', '水', '木', '金', '土'].forEach(day => {
            html += '<div class="calendar-weekday">' + day + '</div>';
        });

        // 前月の日付
        const prevMonthDays = new Date(this.currentYear, this.currentMonth - 1, 0).getDate();
        for (let i = startDayOfWeek - 1; i >= 0; i--) {
            html += '<div class="calendar-day other-month">';
            html += '<div class="calendar-day-number">' + (prevMonthDays - i) + '</div>';
            html += '</div>';
        }

        // 今日の日付
        const today = new Date();
        const todayStr = today.getFullYear() + '-' + 
                       String(today.getMonth() + 1).padStart(2, '0') + '-' +
                       String(today.getDate()).padStart(2, '0');

        // 当月の日付
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = this.currentYear + '-' + 
                          String(this.currentMonth).padStart(2, '0') + '-' +
                          String(day).padStart(2, '0');
            
            const isToday = dateStr === todayStr;
            const events = this.data.events[dateStr] || [];
            const todos = this.data.todos[dateStr] || [];

            html += '<div class="calendar-day' + (isToday ? ' today' : '') + 
                   '" onclick="app.calendar.showEventModal(\'' + dateStr + '\')">';
            html += '<div class="calendar-day-number">' + day + '</div>';
            
            // イベント表示
            events.forEach(event => {
                html += '<div class="calendar-event-item" onclick="event.stopPropagation(); app.calendar.editEvent(\'' + 
                       dateStr + '\', \'' + event.id + '\')">';
                html += event.title;
                html += '</div>';
            });
            
            // Todo表示
            todos.forEach(todo => {
                html += '<div class="calendar-todo-item' + (todo.completed ? ' completed' : '') + 
                       '" onclick="event.stopPropagation(); app.calendar.toggleTodo(\'' + 
                       dateStr + '\', \'' + todo.id + '\')">';
                html += '✓ ' + todo.title;
                html += '</div>';
            });
            
            html += '</div>';
        }

        // 次月の日付
        const remainingDays = 42 - (startDayOfWeek + daysInMonth);
        for (let i = 1; i <= remainingDays; i++) {
            html += '<div class="calendar-day other-month">';
            html += '<div class="calendar-day-number">' + i + '</div>';
            html += '</div>';
        }

        document.getElementById('calendarGrid').innerHTML = html;
    }

    showEventModal(dateStr) {
        this.isEditMode = false;
        this.selectedDate = dateStr;
        this.selectedEventId = null;
        
        document.getElementById('eventModalTitle').textContent = '📅 スケジュール作成';
        document.getElementById('eventTitle').value = '';
        document.getElementById('eventDate').value = dateStr;
        document.getElementById('eventStartTime').value = '';
        document.getElementById('eventEndTime').value = '';
        document.getElementById('eventDescription').value = '';
        document.getElementById('deleteEventBtn').style.display = 'none';
        
        document.getElementById('eventModal').classList.add('show');
    }

    editEvent(dateStr, eventId) {
        this.isEditMode = true;
        this.selectedDate = dateStr;
        this.selectedEventId = eventId;
        
        const event = this.data.events[dateStr].find(e => e.id === eventId);
        
        document.getElementById('eventModalTitle').textContent = '📅 スケジュール編集';
        document.getElementById('eventTitle').value = event.title;
        document.getElementById('eventDate').value = dateStr;
        document.getElementById('eventStartTime').value = event.startTime || '';
        document.getElementById('eventEndTime').value = event.endTime || '';
        document.getElementById('eventDescription').value = event.description || '';
        document.getElementById('deleteEventBtn').style.display = 'block';
        
        document.getElementById('eventModal').classList.add('show');
    }

    closeEventModal() {
        document.getElementById('eventModal').classList.remove('show');
    }

    saveEvent() {
        const title = document.getElementById('eventTitle').value.trim();
        const date = document.getElementById('eventDate').value;
        const startTime = document.getElementById('eventStartTime').value;
        const endTime = document.getElementById('eventEndTime').value;
        const description = document.getElementById('eventDescription').value.trim();

        if (!title) {
            alert('タイトルを入力してください');
            return;
        }

        if (!date) {
            alert('日付を選択してください');
            return;
        }

        if (!this.data.events[date]) {
            this.data.events[date] = [];
        }

        if (this.isEditMode && this.selectedEventId) {
            // 編集モード
            const eventIndex = this.data.events[date].findIndex(e => e.id === this.selectedEventId);
            this.data.events[date][eventIndex] = {
                id: this.selectedEventId,
                title,
                startTime,
                endTime,
                description,
                updatedAt: new Date().toISOString()
            };
            Utils.showToast('スケジュールを更新しました');
        } else {
            // 新規作成
            const eventId = 'event_' + Date.now();
            this.data.events[date].push({
                id: eventId,
                title,
                startTime,
                endTime,
                description,
                createdAt: new Date().toISOString()
            });
            Utils.showToast('スケジュールを作成しました');
        }

        this.saveToFirestore();
        this.closeEventModal();
        this.renderCalendar();
    }

    deleteEvent() {
        if (!confirm('このスケジュールを削除しますか？')) return;

        const date = this.selectedDate;
        this.data.events[date] = this.data.events[date].filter(e => e.id !== this.selectedEventId);
        
        if (this.data.events[date].length === 0) {
            delete this.data.events[date];
        }

        this.saveToFirestore();
        this.closeEventModal();
        this.renderCalendar();
        Utils.showToast('スケジュールを削除しました');
    }

    showTodoModal() {
        const today = new Date();
        const todayStr = today.getFullYear() + '-' + 
                       String(today.getMonth() + 1).padStart(2, '0') + '-' +
                       String(today.getDate()).padStart(2, '0');
        
        document.getElementById('todoTitle').value = '';
        document.getElementById('todoDate').value = todayStr;
        document.getElementById('todoDescription').value = '';
        
        document.getElementById('todoModal').classList.add('show');
    }

    closeTodoModal() {
        document.getElementById('todoModal').classList.remove('show');
    }

    saveTodo() {
        const title = document.getElementById('todoTitle').value.trim();
        const date = document.getElementById('todoDate').value;
        const description = document.getElementById('todoDescription').value.trim();

        if (!title) {
            alert('Todoタイトルを入力してください');
            return;
        }

        if (!date) {
            alert('日付を選択してください');
            return;
        }

        if (!this.data.todos[date]) {
            this.data.todos[date] = [];
        }

        const todoId = 'todo_' + Date.now();
        this.data.todos[date].push({
            id: todoId,
            title,
            description,
            completed: false,
            createdAt: new Date().toISOString()
        });

        this.saveToFirestore();
        this.closeTodoModal();
        this.renderCalendar();
        Utils.showToast('Todoを追加しました');
    }

    toggleTodo(dateStr, todoId) {
        const todo = this.data.todos[dateStr].find(t => t.id === todoId);
        if (todo) {
            todo.completed = !todo.completed;
            this.saveToFirestore();
            this.renderCalendar();
        }
    }
}

// 予算管理クラス
class BudgetManager {
    constructor() {
        this.currentYear = new Date().getFullYear();
        this.currentMonth = new Date().getMonth() + 1;
        this.data = {};
        this.isInitialLoad = true;
    }

    getCurrentMonthKey() {
        return this.currentYear + '-' + String(this.currentMonth).padStart(2, '0');
    }

    getCurrentMonthData() {
        const key = this.getCurrentMonthKey();
        if (!this.data[key]) {
            this.data[key] = { categories: [] };
        }
        return this.data[key];
    }

    showSyncStatus(status, message) {
        const statusEl = document.getElementById('syncStatus');
        statusEl.className = 'sync-status ' + status;
        statusEl.textContent = message;
    }

    async saveToFirestore() {
        try {
            const docRef = doc(db, 'budgetData', 'data');
            await setDoc(docRef, { data: this.data });
            this.showSyncStatus('synced', '✓ 同期完了');
            setTimeout(() => {
                const statusEl = document.getElementById('syncStatus');
                if (statusEl.textContent === '✓ 同期完了') {
                    statusEl.style.display = 'none';
                }
            }, 2000);
        } catch (error) {
            console.error('Firestore保存エラー:', error);
            this.showSyncStatus('error', '✗ 同期エラー: ' + error.message);
        }
    }

    loadFromFirestore() {
        const docRef = doc(db, 'budgetData', 'data');
        
        onSnapshot(docRef, (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                if (data.data) {
                    this.data = data.data;
                    this.updateDisplay();
                    
                    if (this.isInitialLoad) {
                        this.showSyncStatus('synced', '✓ データ読み込み完了');
                        this.isInitialLoad = false;
                        setTimeout(() => {
                            document.getElementById('syncStatus').style.display = 'none';
                        }, 2000);
                    }
                }
            } else {
                this.showSyncStatus('synced', '✓ 接続完了（データなし）');
                setTimeout(() => {
                    document.getElementById('syncStatus').style.display = 'none';
                }, 2000);
            }
        }, (error) => {
            console.error('Firestore読み込みエラー:', error);
            this.showSyncStatus('error', '✗ 接続エラー: ' + error.message);
        });
    }

    changeMonth(delta) {
        this.currentMonth += delta;
        if (this.currentMonth > 12) {
            this.currentMonth = 1;
            this.currentYear++;
        } else if (this.currentMonth < 1) {
            this.currentMonth = 12;
            this.currentYear--;
        }
        
        const monthDisplay = document.getElementById('currentMonth');
        monthDisplay.style.opacity = '0';
        monthDisplay.style.transform = 'scale(0.9)';
        
        setTimeout(() => {
            this.updateDisplay();
            monthDisplay.style.transition = 'all 0.3s ease';
            monthDisplay.style.opacity = '1';
            monthDisplay.style.transform = 'scale(1)';
        }, 150);
    }

    addCategory() {
        const name = document.getElementById('newCategoryName').value.trim();
        const amount = document.getElementById('newCategoryAmount').value;
        const note = document.getElementById('newCategoryNote').value.trim();

        if (!name) {
            alert('カテゴリー名を入力してください');
            return;
        }

        const monthData = this.getCurrentMonthData();
        monthData.categories.push({
            id: Date.now(),
            name: name,
            amount: amount ? parseFloat(amount) : 0,
            note: note,
            subcategories: []
        });

        document.getElementById('newCategoryName').value = '';
        document.getElementById('newCategoryAmount').value = '';
        document.getElementById('newCategoryNote').value = '';
        
        this.showSyncStatus('syncing', '同期中...');
        this.saveToFirestore();
    }

    addSubcategory(categoryId) {
        const name = document.getElementById('subname-' + categoryId).value.trim();
        const amount = document.getElementById('subamount-' + categoryId).value;
        const note = document.getElementById('subnote-' + categoryId).value.trim();

        if (!name) {
            alert('項目名を入力してください');
            return;
        }

        const monthData = this.getCurrentMonthData();
        const category = monthData.categories.find(c => c.id === categoryId);
        
        if (category) {
            category.subcategories.push({
                id: Date.now(),
                name: name,
                amount: amount ? parseFloat(amount) : 0,
                note: note
            });

            document.getElementById('subname-' + categoryId).value = '';
            document.getElementById('subamount-' + categoryId).value = '';
            document.getElementById('subnote-' + categoryId).value = '';
            
            this.showSyncStatus('syncing', '同期中...');
            this.saveToFirestore();
        }
    }

    deleteCategory(categoryId) {
        if (!confirm('このカテゴリーを削除しますか？')) return;

        const monthData = this.getCurrentMonthData();
        monthData.categories = monthData.categories.filter(c => c.id !== categoryId);
        
        this.showSyncStatus('syncing', '同期中...');
        this.saveToFirestore();
    }

    deleteSubcategory(categoryId, subcategoryId) {
        if (!confirm('この項目を削除しますか？')) return;

        const monthData = this.getCurrentMonthData();
        const category = monthData.categories.find(c => c.id === categoryId);
        
        if (category) {
            category.subcategories = category.subcategories.filter(s => s.id !== subcategoryId);
            this.showSyncStatus('syncing', '同期中...');
            this.saveToFirestore();
        }
    }

    editCategory(categoryId) {
        const monthData = this.getCurrentMonthData();
        const category = monthData.categories.find(c => c.id === categoryId);
        
        if (category) {
            const newName = prompt('カテゴリー名を入力:', category.name);
            if (newName !== null && newName.trim()) {
                category.name = newName.trim();
                this.showSyncStatus('syncing', '同期中...');
                this.saveToFirestore();
            }
        }
    }

    editSubcategory(categoryId, subcategoryId) {
        const monthData = this.getCurrentMonthData();
        const category = monthData.categories.find(c => c.id === categoryId);
        
        if (category) {
            const subcategory = category.subcategories.find(s => s.id === subcategoryId);
            if (subcategory) {
                const newName = prompt('項目名を入力:', subcategory.name);
                if (newName !== null && newName.trim()) {
                    subcategory.name = newName.trim();
                    this.showSyncStatus('syncing', '同期中...');
                    this.saveToFirestore();
                }
            }
        }
    }

    updateAmount(categoryId, subcategoryId) {
        const monthData = this.getCurrentMonthData();
        const category = monthData.categories.find(c => c.id === categoryId);
        
        if (category) {
            if (subcategoryId === null) {
                const input = document.getElementById('amount-' + categoryId);
                category.amount = parseFloat(input.value) || 0;
            } else {
                const subcategory = category.subcategories.find(s => s.id === subcategoryId);
                if (subcategory) {
                    const input = document.getElementById('subamount-' + categoryId + '-' + subcategoryId);
                    subcategory.amount = parseFloat(input.value) || 0;
                }
            }
            this.showSyncStatus('syncing', '同期中...');
            this.saveToFirestore();
        }
    }

    updateNote(categoryId, subcategoryId) {
        const monthData = this.getCurrentMonthData();
        const category = monthData.categories.find(c => c.id === categoryId);
        
        if (category) {
            if (subcategoryId === null) {
                const input = document.getElementById('note-' + categoryId);
                category.note = input.value.trim();
            } else {
                const subcategory = category.subcategories.find(s => s.id === subcategoryId);
                if (subcategory) {
                    const input = document.getElementById('subnote-edit-' + categoryId + '-' + subcategoryId);
                    subcategory.note = input.value.trim();
                }
            }
            this.showSyncStatus('syncing', '同期中...');
            this.saveToFirestore();
        }
    }

    toggleAccordion(categoryId) {
        const details = document.getElementById('details-' + categoryId);
        const icon = document.getElementById('icon-' + categoryId);
        
        if (details.classList.contains('open')) {
            details.classList.remove('open');
            icon.classList.remove('open');
        } else {
            details.classList.add('open');
            icon.classList.add('open');
        }
    }

    copyFromPreviousMonth() {
        let prevMonth = this.currentMonth - 1;
        let prevYear = this.currentYear;
        
        if (prevMonth < 1) {
            prevMonth = 12;
            prevYear--;
        }
        
        const prevKey = prevYear + '-' + String(prevMonth).padStart(2, '0');
        
        if (!this.data[prevKey] || !this.data[prevKey].categories || this.data[prevKey].categories.length === 0) {
            alert('先月のデータがありません');
            return;
        }
        
        const currentData = this.getCurrentMonthData();
        if (currentData.categories.length > 0) {
            if (!confirm('今月のデータが上書きされますが、よろしいですか？')) {
                return;
            }
        }
        
        const prevData = this.data[prevKey];
        const copiedCategories = JSON.parse(JSON.stringify(prevData.categories));
        
        copiedCategories.forEach(category => {
            category.id = Date.now() + Math.random();
            category.subcategories.forEach(sub => {
                sub.id = Date.now() + Math.random();
            });
        });
        
        currentData.categories = copiedCategories;
        
        this.showSyncStatus('syncing', '同期中...');
        this.saveToFirestore();
        alert('先月分のデータをコピーしました');
    }

    calculateTotal() {
        const monthData = this.getCurrentMonthData();
        let total = 0;

        monthData.categories.forEach(category => {
            if (category.subcategories.length === 0) {
                total += category.amount || 0;
            } else {
                category.subcategories.forEach(sub => {
                    total += sub.amount || 0;
                });
            }
        });

        return total;
    }

    generateOutput() {
        const monthData = this.getCurrentMonthData();
        const monthKey = this.getCurrentMonthKey();
        const parts = monthKey.split('-');
        const year = parts[0];
        const month = parts[1];
        
        let output = '【' + year + '/' + month + '】\n';
        
        monthData.categories.forEach(category => {
            if (category.subcategories.length === 0) {
                const half = Math.round(category.amount / 2);
                output += category.name + ' ' + category.amount.toLocaleString() + '円（折半: ' + half.toLocaleString() + '円）\n';
            } else {
                const subTotal = category.subcategories.reduce((sum, sub) => sum + (sub.amount || 0), 0);
                const subHalf = Math.round(subTotal / 2);
                const subDetails = category.subcategories
                    .map(sub => {
                        const half = Math.round(sub.amount / 2);
                        return sub.name + ' ' + sub.amount.toLocaleString() + '円（折半: ' + half.toLocaleString() + '円）';
                    })
                    .join(' / ');
                output += category.name + ' ' + subTotal.toLocaleString() + '円（折半: ' + subHalf.toLocaleString() + '円）\n';
                output += '  (' + subDetails + ')\n';
            }
        });
        
        const total = this.calculateTotal();
        const halfTotal = Math.round(total / 2);
        output += '\nTotal: ' + total.toLocaleString() + '円\n';
        output += '折半Total: ' + halfTotal.toLocaleString() + '円';
        
        return output;
    }

    updateDisplay() {
        document.getElementById('currentMonth').textContent = this.currentYear + '年 ' + this.currentMonth + '月';

        const monthData = this.getCurrentMonthData();
        let listHtml = '';
        
        monthData.categories.forEach(category => {
            let subcategoriesHtml = '';
            
            category.subcategories.forEach(sub => {
                subcategoriesHtml += '<div class="subcategory-item">';
                subcategoriesHtml += '<div class="sub-row">';
                subcategoriesHtml += '<div>';
                subcategoriesHtml += '<span class="subcategory-name">' + sub.name + '</span>';
                if (sub.note) {
                    subcategoriesHtml += '<div class="note-text">備考: ' + sub.note + '</div>';
                }
                subcategoriesHtml += '</div>';
                subcategoriesHtml += '<div class="category-amount">';
                subcategoriesHtml += '<input type="number" id="subamount-' + category.id + '-' + sub.id + '" value="' + sub.amount + '" onchange="app.budget.updateAmount(' + category.id + ', ' + sub.id + ')">';
                subcategoriesHtml += '<span>円</span>';
                subcategoriesHtml += '<div class="category-actions">';
                subcategoriesHtml += '<button class="edit-btn" onclick="app.budget.editSubcategory(' + category.id + ', ' + sub.id + ')">編集</button>';
                subcategoriesHtml += '<button class="delete-btn" onclick="app.budget.deleteSubcategory(' + category.id + ', ' + sub.id + ')">削除</button>';
                subcategoriesHtml += '</div></div></div>';
                subcategoriesHtml += '<input type="text" class="note-input" id="subnote-edit-' + category.id + '-' + sub.id + '" value="' + (sub.note || '') + '" placeholder="備考を入力..." onchange="app.budget.updateNote(' + category.id + ', ' + sub.id + ')">';
                subcategoriesHtml += '</div>';
            });

            const subTotal = category.subcategories.reduce((sum, sub) => sum + (sub.amount || 0), 0);
            const displayAmount = category.subcategories.length > 0 ? subTotal : category.amount;

            listHtml += '<div class="category-item">';
            
            listHtml += '<div class="category-summary" onclick="app.budget.toggleAccordion(' + category.id + ')">';
            listHtml += '<div class="category-summary-left">';
            listHtml += '<span class="accordion-icon" id="icon-' + category.id + '">▶</span>';
            listHtml += '<span class="category-summary-name">' + category.name + '</span>';
            listHtml += '</div>';
            listHtml += '<span class="category-summary-amount">' + displayAmount.toLocaleString() + '円</span>';
            listHtml += '</div>';
            
            listHtml += '<div class="category-details" id="details-' + category.id + '">';
            listHtml += '<div class="category-header">';
            listHtml += '<div>';
            listHtml += '<span class="category-name">' + category.name + '</span>';
            if (category.note) {
                listHtml += '<div class="note-text">備考: ' + category.note + '</div>';
            }
            listHtml += '</div>';
            listHtml += '<div class="category-amount">';
            
            if (category.subcategories.length === 0) {
                listHtml += '<input type="number" id="amount-' + category.id + '" value="' + category.amount + '" onchange="app.budget.updateAmount(' + category.id + ', null)">';
                listHtml += '<span>円</span>';
            } else {
                listHtml += '<span style="font-size: 18px; font-weight: bold;">合計: ' + displayAmount.toLocaleString() + '円</span>';
            }
            
            listHtml += '<div class="category-actions">';
            listHtml += '<button class="edit-btn" onclick="app.budget.editCategory(' + category.id + ')">編集</button>';
            listHtml += '<button class="delete-btn" onclick="app.budget.deleteCategory(' + category.id + ')">削除</button>';
            listHtml += '</div></div></div>';
            
            if (category.subcategories.length === 0) {
                listHtml += '<div style="margin-top: 10px;">';
                listHtml += '<input type="text" class="note-input" id="note-' + category.id + '" value="' + (category.note || '') + '" placeholder="備考を入力..." onchange="app.budget.updateNote(' + category.id + ', null)">';
                listHtml += '</div>';
            }
            
            if (category.subcategories.length > 0) {
                listHtml += '<div class="subcategory-list">' + subcategoriesHtml + '</div>';
            }
            
            listHtml += '<div class="add-subcategory">';
            listHtml += '<div class="input-group">';
            listHtml += '<input type="text" id="subname-' + category.id + '" placeholder="小カテゴリー（例：電気）">';
            listHtml += '<input type="number" id="subamount-' + category.id + '" placeholder="金額">';
            listHtml += '<input type="text" id="subnote-' + category.id + '" placeholder="備考（任意）">';
            listHtml += '<button onclick="app.budget.addSubcategory(' + category.id + ')">追加</button>';
            listHtml += '</div></div>';
            
            listHtml += '</div>';
            listHtml += '</div>';
        });

        document.getElementById('categoryList').innerHTML = listHtml;

        const total = this.calculateTotal();
        const half = Math.round(total / 2);
        document.getElementById('totalAmount').textContent = '¥' + total.toLocaleString();
        document.getElementById('halfAmount').textContent = '折半: ¥' + half.toLocaleString();
        document.getElementById('outputText').textContent = this.generateOutput();
    }

    copyOutput() {
        const text = document.getElementById('outputText').textContent;
        navigator.clipboard.writeText(text).then(() => {
            const successMsg = document.getElementById('copySuccess');
            successMsg.style.display = 'block';
            setTimeout(() => {
                successMsg.style.display = 'none';
            }, 2000);
        });
    }
}

// アプリケーションクラス
class KakeiboApp {
    constructor() {
        this.budget = new BudgetManager();
        this.calculator = new Calculator();
        this.csv = new CSVExporter(this.budget);
        this.calendar = new CalendarManager();
    }

    toggleMenu() {
        document.getElementById('sideMenu').classList.toggle('open');
        document.getElementById('menuOverlay').classList.toggle('show');
    }

    closeMenu() {
        document.getElementById('sideMenu').classList.remove('open');
        document.getElementById('menuOverlay').classList.remove('show');
    }

    showBudget() {
        document.getElementById('budgetSection').style.display = 'block';
        document.getElementById('calendarSection').style.display = 'none';
        
        const jstDate = Utils.getJSTDate();
        this.budget.currentYear = jstDate.getFullYear();
        this.budget.currentMonth = jstDate.getMonth() + 1;
        this.budget.updateDisplay();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    showCalendar() {
        document.getElementById('budgetSection').style.display = 'none';
        document.getElementById('calendarSection').style.display = 'block';
        
        const jstDate = Utils.getJSTDate();
        this.calendar.currentYear = jstDate.getFullYear();
        this.calendar.currentMonth = jstDate.getMonth() + 1;
        this.calendar.renderCalendar();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    showSection(section) {
        document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
        event.target.classList.add('active');
        
        if (section === 'budget') {
            this.showBudget();
        }
    }

    init() {
        this.budget.showSyncStatus('syncing', '接続中...');
        this.budget.loadFromFirestore();
        this.budget.updateDisplay();
        this.calendar.loadFromFirestore();
    }
}

// グローバルインスタンス
const app = new KakeiboApp();
window.app = app;

// 初期化
app.init();
