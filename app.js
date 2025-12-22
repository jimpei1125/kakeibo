import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getFirestore, doc, setDoc, onSnapshot, collection, addDoc, updateDoc, deleteDoc, query, where, getDocs } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

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

// 休日カレンダークラス
class HolidayCalendar {
    constructor() {
        this.currentYear = new Date().getFullYear();
        this.currentMonth = new Date().getMonth() + 1;
        this.editYear = this.currentYear;
        this.editMonth = this.currentMonth;
        this.users = [];
        this.holidays = [];
        this.selectedUser = null;
        this.editingUserId = null;
        this.selectedColor = null;
        this.tempHolidays = []; // 編集中の一時的な休日データ
        
        this.colors = [
            { name: '赤', value: '#FF5733', emoji: '🔴' },
            { name: 'オレンジ', value: '#FF8C42', emoji: '🟠' },
            { name: '黄', value: '#FFC300', emoji: '🟡' },
            { name: '緑', value: '#38EF7D', emoji: '🟢' },
            { name: '青', value: '#4FACFE', emoji: '🔵' },
            { name: '紫', value: '#9B59B6', emoji: '🟣' },
            { name: 'ピンク', value: '#FF69B4', emoji: '💗' },
            { name: '茶', value: '#8B4513', emoji: '🟤' }
        ];
    }

    async init() {
        await this.loadUsers();
        await this.loadHolidays();
        this.renderCalendar();
    }

    async loadUsers() {
        const usersCol = collection(db, 'holidayUsers');
        const q = query(usersCol, orderBy('order', 'asc'));
        
        onSnapshot(q, (snapshot) => {
            this.users = [];
            snapshot.forEach(doc => {
                this.users.push({
                    id: doc.id,
                    ...doc.data()
                });
            });
            this.updateUsersList();
            this.renderCalendar();
        });
    }

    async loadHolidays() {
        const holidaysCol = collection(db, 'holidays');
        
        onSnapshot(holidaysCol, (snapshot) => {
            this.holidays = [];
            snapshot.forEach(doc => {
                this.holidays.push({
                    id: doc.id,
                    ...doc.data()
                });
            });
            this.renderCalendar();
        });
    }

    updateUsersList() {
        const usersList = document.getElementById('usersList');
        
        if (this.users.length === 0) {
            usersList.innerHTML = '<span class="no-users">ユーザーが登録されていません</span>';
            return;
        }
        
        let html = '';
        this.users.forEach(user => {
            html += `
                <div class="user-tag">
                    <div class="user-color-dot" style="background-color: ${user.color}"></div>
                    <span>${user.name}</span>
                </div>
            `;
        });
        
        usersList.innerHTML = html;
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

    changeEditMonth(delta) {
        this.editMonth += delta;
        if (this.editMonth > 12) {
            this.editMonth = 1;
            this.editYear++;
        } else if (this.editMonth < 1) {
            this.editMonth = 12;
            this.editYear--;
        }
        this.renderEditCalendar();
    }

    renderCalendar() {
        document.getElementById('calendarCurrentMonth').textContent = 
            this.currentYear + '年' + this.currentMonth + '月';

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
            html += '<div class="calendar-date-cell other-month">';
            html += '<div class="calendar-date-number">' + (prevMonthDays - i) + '</div>';
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
            const dayHolidays = this.holidays.filter(h => h.date === dateStr);

            html += '<div class="calendar-date-cell' + (isToday ? ' today' : '') + '">';
            html += '<div class="calendar-date-number">' + day + '</div>';
            html += '<div class="calendar-holiday-users">';
            
            // 最大3人まで表示
            const displayUsers = dayHolidays.slice(0, 3);
            displayUsers.forEach(holiday => {
                const user = this.users.find(u => u.id === holiday.userId);
                if (user) {
                    html += `
                        <div class="calendar-holiday-user">
                            <div class="calendar-holiday-dot" style="background-color: ${user.color}"></div>
                            <span class="calendar-holiday-name">${user.name}</span>
                        </div>
                    `;
                }
            });
            
            // 4人以上の場合は「+N」と表示
            if (dayHolidays.length > 3) {
                html += '<div class="calendar-more-users">+' + (dayHolidays.length - 3) + '</div>';
            }
            
            html += '</div></div>';
        }

        // 次月の日付
        const remainingDays = 42 - (startDayOfWeek + daysInMonth);
        for (let i = 1; i <= remainingDays; i++) {
            html += '<div class="calendar-date-cell other-month">';
            html += '<div class="calendar-date-number">' + i + '</div>';
            html += '</div>';
        }

        document.getElementById('holidayCalendar').innerHTML = html;
    }

    // ユーザー管理
    showUserManagement() {
        this.renderUserList();
        document.getElementById('userModal').classList.add('show');
    }

    closeUserModal() {
        document.getElementById('userModal').classList.remove('show');
    }

    renderUserList() {
        const userListModal = document.getElementById('userListModal');
        
        if (this.users.length === 0) {
            userListModal.innerHTML = '<p style="text-align: center; color: rgba(255,255,255,0.5);">ユーザーが登録されていません</p>';
            return;
        }
        
        let html = '';
        this.users.forEach(user => {
            html += `
                <div class="user-item" onclick="app.holidayCalendar.editUser('${user.id}')">
                    <div class="user-color-dot" style="background-color: ${user.color}"></div>
                    <span>${user.name}</span>
                </div>
            `;
        });
        
        userListModal.innerHTML = html;
    }

    showUserForm(userId = null) {
        this.editingUserId = userId;
        
        if (userId) {
            // 編集モード
            const user = this.users.find(u => u.id === userId);
            document.getElementById('userFormTitle').textContent = '✏️ ユーザー編集';
            document.getElementById('userName').value = user.name;
            this.selectedColor = user.color;
            document.getElementById('deleteUserBtn').style.display = 'block';
        } else {
            // 新規登録モード
            document.getElementById('userFormTitle').textContent = '✨ ユーザー新規登録';
            document.getElementById('userName').value = '';
            this.selectedColor = null;
            document.getElementById('deleteUserBtn').style.display = 'none';
        }
        
        this.renderColorPalette();
        document.getElementById('userModal').classList.remove('show');
        document.getElementById('userFormModal').classList.add('show');
    }

    editUser(userId) {
        this.showUserForm(userId);
    }

    closeUserForm() {
        document.getElementById('userFormModal').classList.remove('show');
        document.getElementById('userModal').classList.add('show');
    }

    renderColorPalette() {
        const palette = document.getElementById('colorPalette');
        const usedColors = this.users
            .filter(u => u.id !== this.editingUserId)
            .map(u => u.color);
        
        let html = '';
        this.colors.forEach(color => {
            const isUsed = usedColors.includes(color.value);
            const isSelected = this.selectedColor === color.value;
            const classes = ['color-option'];
            if (isUsed) classes.push('disabled');
            if (isSelected) classes.push('selected');
            
            html += `
                <div class="${classes.join(' ')}" 
                     style="background-color: ${color.value}"
                     onclick="app.holidayCalendar.selectColor('${color.value}', ${isUsed})">
                    ${isSelected ? '✓' : color.emoji}
                </div>
            `;
        });
        
        palette.innerHTML = html;
    }

    selectColor(color, isDisabled) {
        if (isDisabled) return;
        this.selectedColor = color;
        this.renderColorPalette();
    }

    async saveUser() {
        const name = document.getElementById('userName').value.trim();
        
        if (!name) {
            alert('名前を入力してください');
            return;
        }
        
        if (name.length > 15) {
            alert('名前は15文字以内で入力してください');
            return;
        }
        
        if (!this.selectedColor) {
            alert('カラーを選択してください');
            return;
        }
        
        try {
            if (this.editingUserId) {
                // 更新
                const userRef = doc(db, 'holidayUsers', this.editingUserId);
                await updateDoc(userRef, {
                    name: name,
                    color: this.selectedColor
                });
                Utils.showToast('ユーザー情報を更新しました');
            } else {
                // 新規登録
                const usersCol = collection(db, 'holidayUsers');
                await addDoc(usersCol, {
                    name: name,
                    color: this.selectedColor,
                    order: this.users.length,
                    createdAt: new Date().toISOString()
                });
                Utils.showToast('ユーザーを登録しました');
            }
            
            document.getElementById('userFormModal').classList.remove('show');
            document.getElementById('userModal').classList.add('show');
        } catch (error) {
            console.error('ユーザー保存エラー:', error);
            alert('保存に失敗しました');
        }
    }

    async deleteUser() {
        if (!confirm('このユーザーを削除しますか？\n休日データもすべて削除されます。')) {
            return;
        }
        
        try {
            // ユーザー削除
            await deleteDoc(doc(db, 'holidayUsers', this.editingUserId));
            
            // 該当ユーザーの休日をすべて削除
            const holidaysQuery = query(
                collection(db, 'holidays'),
                where('userId', '==', this.editingUserId)
            );
            const snapshot = await getDocs(holidaysQuery);
            const deletePromises = snapshot.docs.map(doc => deleteDoc(doc.ref));
            await Promise.all(deletePromises);
            
            Utils.showToast('ユーザーを削除しました');
            document.getElementById('userFormModal').classList.remove('show');
            document.getElementById('userModal').classList.add('show');
        } catch (error) {
            console.error('ユーザー削除エラー:', error);
            alert('削除に失敗しました');
        }
    }

    // 休日編集
    showHolidayEdit() {
        if (this.users.length === 0) {
            alert('ユーザーが登録されていません。\n先にユーザー編集から登録してください。');
            return;
        }
        
        this.renderHolidayUserList();
        document.getElementById('holidayUserSelectModal').classList.add('show');
    }

    closeHolidayUserSelect() {
        document.getElementById('holidayUserSelectModal').classList.remove('show');
    }

    renderHolidayUserList() {
        const list = document.getElementById('holidayUserList');
        
        let html = '';
        this.users.forEach(user => {
            html += `
                <button class="holiday-user-btn" onclick="app.holidayCalendar.startHolidayEdit('${user.id}')">
                    <div class="user-color-dot" style="background-color: ${user.color}"></div>
                    <span>${user.name}</span>
                </button>
            `;
        });
        
        list.innerHTML = html;
    }

    startHolidayEdit(userId) {
        this.selectedUser = this.users.find(u => u.id === userId);
        this.editYear = this.currentYear;
        this.editMonth = this.currentMonth;
        
        // 現在の休日データをコピー
        this.tempHolidays = this.holidays
            .filter(h => h.userId === userId)
            .map(h => h.date);
        
        document.getElementById('holidayEditTitle').textContent = 
            '📅 ' + this.selectedUser.name + 'の休日編集';
        
        document.getElementById('holidayUserSelectModal').classList.remove('show');
        this.renderEditCalendar();
        document.getElementById('holidayEditModal').classList.add('show');
    }

    renderEditCalendar() {
        document.getElementById('editCalendarMonth').textContent = 
            this.editYear + '年' + this.editMonth + '月';

        const firstDay = new Date(this.editYear, this.editMonth - 1, 1);
        const lastDay = new Date(this.editYear, this.editMonth, 0);
        const daysInMonth = lastDay.getDate();
        const startDayOfWeek = firstDay.getDay();

        let html = '';
        
        // 曜日ヘッダー
        ['日', '月', '火', '水', '木', '金', '土'].forEach(day => {
            html += '<div class="calendar-weekday">' + day + '</div>';
        });

        // 前月の日付
        const prevMonthDays = new Date(this.editYear, this.editMonth - 1, 0).getDate();
        for (let i = startDayOfWeek - 1; i >= 0; i--) {
            html += '<div class="edit-date-cell other-month">' + (prevMonthDays - i) + '</div>';
        }

        // 当月の日付
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = this.editYear + '-' + 
                          String(this.editMonth).padStart(2, '0') + '-' +
                          String(day).padStart(2, '0');
            
            const isHoliday = this.tempHolidays.includes(dateStr);
            const style = isHoliday ? `background-color: ${this.selectedUser.color}` : '';
            
            html += `
                <div class="edit-date-cell ${isHoliday ? 'holiday' : ''}" 
                     style="${style}"
                     onclick="app.holidayCalendar.toggleHoliday('${dateStr}')">
                    ${day}
                </div>
            `;
        }

        // 次月の日付
        const remainingDays = 42 - (startDayOfWeek + daysInMonth);
        for (let i = 1; i <= remainingDays; i++) {
            html += '<div class="edit-date-cell other-month">' + i + '</div>';
        }

        document.getElementById('holidayEditCalendar').innerHTML = html;
    }

    toggleHoliday(dateStr) {
        const index = this.tempHolidays.indexOf(dateStr);
        if (index > -1) {
            this.tempHolidays.splice(index, 1);
        } else {
            this.tempHolidays.push(dateStr);
        }
        this.renderEditCalendar();
    }

    async completeHolidayEdit() {
        try {
            // 既存の休日データを削除
            const existingQuery = query(
                collection(db, 'holidays'),
                where('userId', '==', this.selectedUser.id)
            );
            const snapshot = await getDocs(existingQuery);
            const deletePromises = snapshot.docs.map(doc => deleteDoc(doc.ref));
            await Promise.all(deletePromises);
            
            // 新しい休日データを追加
            const addPromises = this.tempHolidays.map(date => 
                addDoc(collection(db, 'holidays'), {
                    userId: this.selectedUser.id,
                    date: date,
                    createdAt: new Date().toISOString()
                })
            );
            await Promise.all(addPromises);
            
            Utils.showToast('休日を保存しました');
            document.getElementById('holidayEditModal').classList.remove('show');
        } catch (error) {
            console.error('休日保存エラー:', error);
            alert('保存に失敗しました');
        }
    }

    cancelHolidayEdit() {
        document.getElementById('holidayEditModal').classList.remove('show');
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
        this.holidayCalendar = new HolidayCalendar();
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
        // カレンダーページを非表示
        document.getElementById('calendarSection').style.display = 'none';
        // 家計簿ページを表示
        document.getElementById('budgetSection').style.display = 'block';
        // フッターを表示
        document.querySelector('.footer').style.display = 'block';
        // メニュー項目を切り替え
        document.getElementById('menuCalendar').style.display = 'block';
        document.getElementById('menuBudget').style.display = 'none';
        
        const jstDate = Utils.getJSTDate();
        this.budget.currentYear = jstDate.getFullYear();
        this.budget.currentMonth = jstDate.getMonth() + 1;
        this.budget.updateDisplay();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    showCalendar() {
        // 家計簿ページを非表示
        document.getElementById('budgetSection').style.display = 'none';
        // カレンダーページを表示
        document.getElementById('calendarSection').style.display = 'block';
        // フッターを非表示
        document.querySelector('.footer').style.display = 'none';
        // メニュー項目を切り替え
        document.getElementById('menuCalendar').style.display = 'none';
        document.getElementById('menuBudget').style.display = 'block';
        
        const jstDate = Utils.getJSTDate();
        this.holidayCalendar.currentYear = jstDate.getFullYear();
        this.holidayCalendar.currentMonth = jstDate.getMonth() + 1;
        this.holidayCalendar.renderCalendar();
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
        this.holidayCalendar.loadData();
    }
}

// グローバルインスタンス
const app = new KakeiboApp();
window.app = app;

// 初期化
app.init();
