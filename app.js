import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getFirestore, doc, setDoc, onSnapshot, collection, addDoc, updateDoc, deleteDoc, query, where, getDocs, orderBy } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

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
            
            // モーダルを閉じる
            document.getElementById('userFormModal').classList.remove('show');
            document.getElementById('userModal').classList.remove('show');
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
            // モーダルを閉じる
            document.getElementById('userFormModal').classList.remove('show');
            document.getElementById('userModal').classList.remove('show');
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
        const month = parseInt(parts[1]);
        
        let output = '━━━━━━━━━━━━━━━━\n';
        output += '📅 ' + year + '年' + month + '月 家計簿\n';
        output += '━━━━━━━━━━━━━━━━\n\n';
        
        monthData.categories.forEach((category, index) => {
            if (category.subcategories.length === 0) {
                output += '■ ' + category.name + '：' + category.amount.toLocaleString() + '円\n';
            } else {
                const subTotal = category.subcategories.reduce((sum, sub) => sum + (sub.amount || 0), 0);
                output += '■ ' + category.name + '：' + subTotal.toLocaleString() + '円\n';
                
                category.subcategories.forEach((sub, subIndex) => {
                    const isLast = subIndex === category.subcategories.length - 1;
                    const prefix = isLast ? '  └ ' : '  ├ ';
                    output += prefix + sub.name + '：' + sub.amount.toLocaleString() + '円\n';
                });
            }
            
            // カテゴリ間に空行を追加（最後以外）
            if (index < monthData.categories.length - 1) {
                output += '\n';
            }
        });
        
        const total = this.calculateTotal();
        const halfTotal = Math.round(total / 2);
        output += '\n━━━━━━━━━━━━━━━━\n';
        output += '💰 Total：' + total.toLocaleString() + '円\n';
        output += '👥 折半：' + halfTotal.toLocaleString() + '円\n';
        output += '━━━━━━━━━━━━━━━━';
        
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

// 買い物リストクラス
class ShoppingList {
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
        
        // 家計簿から購入履歴を取得
        const purchaseHistory = this.getPurchaseHistory();
        
        // 入力値でフィルタリング
        let suggestions = [];
        if (inputValue.length > 0) {
            suggestions = purchaseHistory.filter(item => 
                item.name.toLowerCase().includes(inputValue)
            ).slice(0, 8);
        } else {
            // 入力がない場合は頻度の高いものを表示
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
        
        // 家計簿データから商品名を抽出
        Object.values(budgetData).forEach(monthData => {
            if (!monthData.categories) return;
            
            monthData.categories.forEach(category => {
                // 大カテゴリー名
                if (category.name) {
                    const name = category.name;
                    if (!history[name]) {
                        history[name] = { name, count: 0, category: this.guessCategory(name) };
                    }
                    history[name].count++;
                }
                
                // 小カテゴリー名
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
        
        // 頻度順にソート
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
        
        // フィルタリング
        let uncompleted = this.items.filter(i => !i.completed);
        const completed = this.items.filter(i => i.completed);
        
        if (this.currentFilter === 'high') {
            uncompleted = uncompleted.filter(i => i.priority === 'high');
        }
        
        // 優先度でソート（急ぎを上に）
        uncompleted.sort((a, b) => {
            const priorityOrder = { high: 0, normal: 1, low: 2 };
            return priorityOrder[a.priority] - priorityOrder[b.priority];
        });
        
        // カテゴリでグループ化
        const grouped = {};
        uncompleted.forEach(item => {
            const cat = item.category || 'その他';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(item);
        });
        
        // 表示件数
        countEl.textContent = uncompleted.length + '件';
        completedCountEl.textContent = completed.length;
        
        // 未購入リスト描画
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
        
        // 購入済みセクション
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

// スマートホームクラス
class SmartHome {
    constructor() {
        this.token = localStorage.getItem('switchbot_token') || '';
        this.secret = localStorage.getItem('switchbot_secret') || '';
        this.devices = [];
        this.infraredDevices = [];
        this.currentAcDevice = null;
        this.acSettings = {
            temperature: 26,
            mode: 2, // 1:暖房, 2:冷房, 3:送風, 5:除湿
            fanSpeed: 1, // 1:自動, 2:弱, 3:中, 4:強
            power: 'on'
        };
        
        this.deviceIcons = {
            'Air Conditioner': '❄️',
            'Fan': '🌀',
            'Light': '💡',
            'TV': '📺',
            'Hub Mini': '📡',
            'Hub 2': '📡',
            'Bot': '🤖',
            'Plug': '🔌',
            'Meter': '🌡️',
            'Motion Sensor': '👁️',
            'Contact Sensor': '🚪',
            'default': '📱'
        };
    }

    init() {
        if (this.token && this.secret) {
            this.showDevicesView();
            this.loadDevices();
        } else {
            this.showSetupView();
        }
    }

    showSetupView() {
        document.getElementById('smartHomeSetup').style.display = 'block';
        document.getElementById('smartHomeDevices').style.display = 'none';
    }

    showDevicesView() {
        document.getElementById('smartHomeSetup').style.display = 'none';
        document.getElementById('smartHomeDevices').style.display = 'block';
    }

    async saveToken() {
        const token = document.getElementById('switchbotToken').value.trim();
        const secret = document.getElementById('switchbotSecret').value.trim();
        
        if (!token || !secret) {
            Utils.showToast('トークンとシークレットを入力してください');
            return;
        }
        
        this.token = token;
        this.secret = secret;
        localStorage.setItem('switchbot_token', token);
        localStorage.setItem('switchbot_secret', secret);
        
        Utils.showToast('保存しました');
        this.showDevicesView();
        await this.loadDevices();
    }

    generateSignature() {
        const t = Date.now();
        const nonce = Math.random().toString(36).substring(2, 15);
        const data = this.token + t + nonce;
        
        // HMAC-SHA256署名を生成（Web Crypto API使用）
        return { t, nonce, sign: null };
    }

    async makeRequest(endpoint, method = 'GET', body = null) {
        const t = Date.now().toString();
        const nonce = Math.random().toString(36).substring(2, 15);
        
        // HMAC-SHA256署名を生成
        const stringToSign = this.token + t + nonce;
        const encoder = new TextEncoder();
        const keyData = encoder.encode(this.secret);
        const messageData = encoder.encode(stringToSign);
        
        const key = await crypto.subtle.importKey(
            'raw',
            keyData,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        
        const signature = await crypto.subtle.sign('HMAC', key, messageData);
        const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
        
        const headers = {
            'Authorization': this.token,
            'sign': signatureBase64,
            't': t,
            'nonce': nonce,
            'Content-Type': 'application/json'
        };
        
        const options = {
            method,
            headers
        };
        
        if (body) {
            options.body = JSON.stringify(body);
        }
        
        const response = await fetch(`https://switchbot-proxy.zinnpei11251818.workers.dev/v1.1${endpoint}`, options);
        return await response.json();
    }

    async loadDevices() {
        const statusEl = document.getElementById('devicesStatus');
        statusEl.textContent = '読み込み中...';
        
        try {
            const result = await this.makeRequest('/devices');
            
            if (result.statusCode === 100) {
                this.devices = result.body.deviceList || [];
                this.infraredDevices = result.body.infraredRemoteList || [];
                this.renderDevices();
                statusEl.textContent = `${this.devices.length + this.infraredDevices.length}台のデバイス`;
            } else {
                statusEl.textContent = 'エラー: ' + result.message;
                Utils.showToast('デバイス取得に失敗しました');
            }
        } catch (error) {
            console.error('デバイス取得エラー:', error);
            statusEl.textContent = '接続エラー';
            Utils.showToast('接続に失敗しました');
        }
    }

    renderDevices() {
        const irListEl = document.getElementById('irDeviceList');
        const physicalListEl = document.getElementById('physicalDeviceList');
        
        // 赤外線デバイス
        if (this.infraredDevices.length === 0) {
            irListEl.innerHTML = '<div class="no-devices">赤外線デバイスがありません</div>';
        } else {
            let html = '';
            this.infraredDevices.forEach(device => {
                const icon = this.deviceIcons[device.remoteType] || this.deviceIcons['default'];
                html += `
                    <div class="device-card" onclick="app.smartHome.controlDevice('${device.deviceId}', '${device.remoteType}', '${device.deviceName}')">
                        <div class="device-icon">${icon}</div>
                        <div class="device-name">${device.deviceName}</div>
                        <div class="device-type">${device.remoteType}</div>
                    </div>
                `;
            });
            irListEl.innerHTML = html;
        }
        
        // 物理デバイス
        if (this.devices.length === 0) {
            physicalListEl.innerHTML = '<div class="no-devices">SwitchBotデバイスがありません</div>';
        } else {
            let html = '';
            this.devices.forEach(device => {
                const icon = this.deviceIcons[device.deviceType] || this.deviceIcons['default'];
                html += `
                    <div class="device-card" onclick="app.smartHome.controlPhysicalDevice('${device.deviceId}', '${device.deviceType}', '${device.deviceName}')">
                        <div class="device-icon">${icon}</div>
                        <div class="device-name">${device.deviceName}</div>
                        <div class="device-type">${device.deviceType}</div>
                    </div>
                `;
            });
            physicalListEl.innerHTML = html;
        }
    }

    controlDevice(deviceId, deviceType, deviceName) {
        if (deviceType === 'Air Conditioner') {
            this.showAcControl(deviceId, deviceName);
        } else if (deviceType === 'Fan') {
            this.showFanControl(deviceId, deviceName);
        } else if (deviceType === 'Light') {
            this.toggleLight(deviceId, deviceName);
        } else if (deviceType === 'TV') {
            this.toggleTV(deviceId, deviceName);
        } else {
            // その他のデバイスはON/OFFトグル
            this.sendCommand(deviceId, 'turnOn');
        }
    }

    controlPhysicalDevice(deviceId, deviceType, deviceName) {
        if (deviceType === 'Bot') {
            this.sendCommand(deviceId, 'press');
            Utils.showToast(`${deviceName}を押しました`);
        } else if (deviceType === 'Plug' || deviceType === 'Plug Mini (US)' || deviceType === 'Plug Mini (JP)') {
            this.togglePlug(deviceId, deviceName);
        } else {
            Utils.showToast(`${deviceName}は直接操作できません`);
        }
    }

    showAcControl(deviceId, deviceName) {
        this.currentAcDevice = { id: deviceId, name: deviceName };
        document.getElementById('acControlTitle').textContent = `❄️ ${deviceName}`;
        document.getElementById('acTempDisplay').textContent = this.acSettings.temperature + '°C';
        
        // モードボタンの状態を更新
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.remove('active');
            if (parseInt(btn.dataset.mode) === this.acSettings.mode) {
                btn.classList.add('active');
            }
        });
        
        // 風量ボタンの状態を更新
        document.querySelectorAll('.fan-btn').forEach(btn => {
            btn.classList.remove('active');
            if (parseInt(btn.dataset.fan) === this.acSettings.fanSpeed) {
                btn.classList.add('active');
            }
        });
        
        document.getElementById('acControlModal').classList.add('show');
    }

    closeAcControl() {
        document.getElementById('acControlModal').classList.remove('show');
        this.currentAcDevice = null;
    }

    adjustTemp(delta) {
        this.acSettings.temperature = Math.max(16, Math.min(30, this.acSettings.temperature + delta));
        document.getElementById('acTempDisplay').textContent = this.acSettings.temperature + '°C';
    }

    setAcMode(mode) {
        this.acSettings.mode = mode;
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.remove('active');
            if (parseInt(btn.dataset.mode) === mode) {
                btn.classList.add('active');
            }
        });
    }

    setAcFan(fan) {
        this.acSettings.fanSpeed = fan;
        document.querySelectorAll('.fan-btn').forEach(btn => {
            btn.classList.remove('active');
            if (parseInt(btn.dataset.fan) === fan) {
                btn.classList.add('active');
            }
        });
    }

    async acCommand(command) {
        if (!this.currentAcDevice) return;
        
        Utils.showToast('送信中...');
        
        try {
            const result = await this.makeRequest(
                `/devices/${this.currentAcDevice.id}/commands`,
                'POST',
                {
                    command: command,
                    commandType: 'command'
                }
            );
            
            if (result.statusCode === 100) {
                Utils.showToast(command === 'turnOn' ? 'ONにしました' : 'OFFにしました');
            } else {
                Utils.showToast('エラー: ' + result.message);
            }
        } catch (error) {
            console.error('コマンドエラー:', error);
            Utils.showToast('送信に失敗しました');
        }
    }

    async applyAcSettings() {
        if (!this.currentAcDevice) return;
        
        Utils.showToast('設定を送信中...');
        
        try {
            // SwitchBot API のエアコンコマンドパラメータ
            // setAll: temperature,mode,fanSpeed,powerState
            const result = await this.makeRequest(
                `/devices/${this.currentAcDevice.id}/commands`,
                'POST',
                {
                    command: 'setAll',
                    commandType: 'command',
                    parameter: `${this.acSettings.temperature},${this.acSettings.mode},${this.acSettings.fanSpeed},on`
                }
            );
            
            if (result.statusCode === 100) {
                Utils.showToast('設定を適用しました');
                this.closeAcControl();
            } else {
                Utils.showToast('エラー: ' + result.message);
            }
        } catch (error) {
            console.error('設定エラー:', error);
            Utils.showToast('送信に失敗しました');
        }
    }

    async showFanControl(deviceId, deviceName) {
        // 扇風機の簡易コントロール（ON/OFFトグル）
        const action = confirm(`${deviceName}\n\nON/OFFを切り替えますか？\n\nOK = ON\nキャンセル = OFF`);
        
        Utils.showToast('送信中...');
        
        try {
            const result = await this.makeRequest(
                `/devices/${deviceId}/commands`,
                'POST',
                {
                    command: action ? 'turnOn' : 'turnOff',
                    commandType: 'command'
                }
            );
            
            if (result.statusCode === 100) {
                Utils.showToast(action ? 'ONにしました' : 'OFFにしました');
            } else {
                Utils.showToast('エラー: ' + result.message);
            }
        } catch (error) {
            console.error('コマンドエラー:', error);
            Utils.showToast('送信に失敗しました');
        }
    }

    async toggleLight(deviceId, deviceName) {
        const action = confirm(`${deviceName}\n\nON/OFFを切り替えますか？\n\nOK = ON\nキャンセル = OFF`);
        await this.sendCommand(deviceId, action ? 'turnOn' : 'turnOff');
        Utils.showToast(action ? 'ONにしました' : 'OFFにしました');
    }

    async toggleTV(deviceId, deviceName) {
        const action = confirm(`${deviceName}\n\nON/OFFを切り替えますか？\n\nOK = ON\nキャンセル = OFF`);
        await this.sendCommand(deviceId, action ? 'turnOn' : 'turnOff');
        Utils.showToast(action ? 'ONにしました' : 'OFFにしました');
    }

    async togglePlug(deviceId, deviceName) {
        const action = confirm(`${deviceName}\n\nON/OFFを切り替えますか？\n\nOK = ON\nキャンセル = OFF`);
        await this.sendCommand(deviceId, action ? 'turnOn' : 'turnOff');
        Utils.showToast(action ? 'ONにしました' : 'OFFにしました');
    }

    async sendCommand(deviceId, command, parameter = 'default') {
        try {
            const result = await this.makeRequest(
                `/devices/${deviceId}/commands`,
                'POST',
                {
                    command: command,
                    commandType: 'command',
                    parameter: parameter
                }
            );
            
            if (result.statusCode !== 100) {
                console.error('コマンドエラー:', result.message);
            }
            
            return result;
        } catch (error) {
            console.error('送信エラー:', error);
            throw error;
        }
    }

    showSettings() {
        document.getElementById('settingsSwitchbotToken').value = this.token;
        document.getElementById('settingsSwitchbotSecret').value = this.secret;
        document.getElementById('smartHomeSettingsModal').classList.add('show');
    }

    closeSettings() {
        document.getElementById('smartHomeSettingsModal').classList.remove('show');
    }

    updateToken() {
        const token = document.getElementById('settingsSwitchbotToken').value.trim();
        const secret = document.getElementById('settingsSwitchbotSecret').value.trim();
        
        if (!token || !secret) {
            Utils.showToast('トークンとシークレットを入力してください');
            return;
        }
        
        this.token = token;
        this.secret = secret;
        localStorage.setItem('switchbot_token', token);
        localStorage.setItem('switchbot_secret', secret);
        
        Utils.showToast('保存しました');
        this.closeSettings();
        this.loadDevices();
    }

    clearToken() {
        if (!confirm('APIトークンを削除しますか？')) return;
        
        localStorage.removeItem('switchbot_token');
        localStorage.removeItem('switchbot_secret');
        this.token = '';
        this.secret = '';
        
        Utils.showToast('削除しました');
        this.closeSettings();
        this.showSetupView();
    }
}

// Philips Hueクラス
class PhilipsHue {
    constructor() {
        this.bridgeIp = '192.168.0.62';
        this.apiKey = 'dKT4W4ky7azJD0qLVsa1YPhYRBvA9lhx2xTm5k6j';
        this.groups = {};
        this.currentGroupId = null;
        this.isConnected = false;
    }

    get baseUrl() {
        return `http://${this.bridgeIp}/api/${this.apiKey}`;
    }

    async init() {
        await this.loadGroups();
    }

    async loadGroups() {
        const loadingEl = document.getElementById('hueLoading');
        const listEl = document.getElementById('hueLightList');
        
        if (loadingEl) loadingEl.style.display = 'block';
        if (listEl) listEl.innerHTML = '';
        
        try {
            const response = await fetch(`${this.baseUrl}/groups`);
            
            if (!response.ok) {
                throw new Error('接続失敗');
            }
            
            this.groups = await response.json();
            this.isConnected = true;
            
            if (loadingEl) loadingEl.style.display = 'none';
            this.renderGroups();
            
        } catch (error) {
            console.error('Hue接続エラー:', error);
            this.isConnected = false;
            
            if (loadingEl) loadingEl.style.display = 'none';
            if (listEl) {
                listEl.innerHTML = `
                    <div class="hue-error" style="grid-column: 1 / -1;">
                        <p>😢 Hue Bridgeに接続できません</p>
                        <p style="font-size: 12px; margin-top: 8px; opacity: 0.7;">自宅WiFiに接続しているか確認してください</p>
                    </div>
                `;
            }
        }
    }

    renderGroups() {
        const listEl = document.getElementById('hueLightList');
        if (!listEl) return;
        
        const groupIds = Object.keys(this.groups);
        
        // Room と Zone のみをフィルタリング（type が 'Room' または 'Zone'）
        const roomGroups = groupIds.filter(id => {
            const type = this.groups[id].type;
            return type === 'Room' || type === 'Zone';
        });
        
        if (roomGroups.length === 0) {
            listEl.innerHTML = '<div class="no-devices">グループが見つかりません</div>';
            return;
        }
        
        let html = '';
        roomGroups.forEach(id => {
            const group = this.groups[id];
            const isOn = group.state && group.state.any_on;
            const allOn = group.state && group.state.all_on;
            const lightCount = group.lights ? group.lights.length : 0;
            
            // グループタイプに応じたアイコン
            const icon = group.type === 'Zone' ? '🏷️' : '🏠';
            
            html += `
                <div class="hue-light-card ${isOn ? 'on' : 'off'}" onclick="app.hue.showControl('${id}')">
                    <div class="hue-light-status ${allOn ? 'all-on' : ''}"></div>
                    <div class="hue-light-icon">${icon}</div>
                    <div class="hue-light-name">${group.name}</div>
                    <div class="hue-light-brightness">${isOn ? (allOn ? '全点灯' : '一部点灯') : 'OFF'}</div>
                    <div class="hue-light-count">${lightCount}台</div>
                </div>
            `;
        });
        
        listEl.innerHTML = html;
    }

    showControl(groupId) {
        this.currentGroupId = groupId;
        const group = this.groups[groupId];
        
        document.getElementById('hueControlTitle').textContent = `💡 ${group.name}`;
        
        // 明るさスライダーを現在の値に設定（グループのaction.briを使用）
        const brightness = group.action && group.action.bri ? Math.round((group.action.bri / 254) * 100) : 100;
        document.getElementById('hueBrightnessSlider').value = brightness;
        document.getElementById('hueBrightnessValue').textContent = brightness;
        
        document.getElementById('hueControlModal').classList.add('show');
    }

    closeControl() {
        document.getElementById('hueControlModal').classList.remove('show');
        this.currentGroupId = null;
    }

    updateBrightnessLabel() {
        const value = document.getElementById('hueBrightnessSlider').value;
        document.getElementById('hueBrightnessValue').textContent = value;
    }

    async setPower(on) {
        if (!this.currentGroupId) return;
        
        const group = this.groups[this.currentGroupId];
        Utils.showToast(on ? `${group.name}を点灯中...` : `${group.name}を消灯中...`);
        
        try {
            const response = await fetch(`${this.baseUrl}/groups/${this.currentGroupId}/action`, {
                method: 'PUT',
                body: JSON.stringify({ on: on })
            });
            
            if (response.ok) {
                // グループの状態を更新
                if (this.groups[this.currentGroupId].state) {
                    this.groups[this.currentGroupId].state.any_on = on;
                    this.groups[this.currentGroupId].state.all_on = on;
                }
                this.renderGroups();
                Utils.showToast(on ? '点灯しました' : '消灯しました');
            } else {
                Utils.showToast('操作に失敗しました');
            }
        } catch (error) {
            console.error('Hue操作エラー:', error);
            Utils.showToast('接続エラー');
        }
    }

    async applyBrightness() {
        if (!this.currentGroupId) return;
        
        const brightness = parseInt(document.getElementById('hueBrightnessSlider').value);
        const bri = Math.round((brightness / 100) * 254);
        
        Utils.showToast('明るさを変更中...');
        
        try {
            const response = await fetch(`${this.baseUrl}/groups/${this.currentGroupId}/action`, {
                method: 'PUT',
                body: JSON.stringify({ on: true, bri: bri })
            });
            
            if (response.ok) {
                if (this.groups[this.currentGroupId].action) {
                    this.groups[this.currentGroupId].action.bri = bri;
                }
                if (this.groups[this.currentGroupId].state) {
                    this.groups[this.currentGroupId].state.any_on = true;
                    this.groups[this.currentGroupId].state.all_on = true;
                }
                this.renderGroups();
                Utils.showToast('明るさを変更しました');
            } else {
                Utils.showToast('操作に失敗しました');
            }
        } catch (error) {
            console.error('Hue操作エラー:', error);
            Utils.showToast('接続エラー');
        }
    }

    async allLightsOn() {
        Utils.showToast('全グループ点灯中...');
        
        try {
            const groupIds = Object.keys(this.groups).filter(id => {
                const type = this.groups[id].type;
                return type === 'Room' || type === 'Zone';
            });
            
            for (const id of groupIds) {
                await fetch(`${this.baseUrl}/groups/${id}/action`, {
                    method: 'PUT',
                    body: JSON.stringify({ on: true })
                });
                if (this.groups[id].state) {
                    this.groups[id].state.any_on = true;
                    this.groups[id].state.all_on = true;
                }
            }
            
            this.renderGroups();
            Utils.showToast('全グループ点灯しました');
        } catch (error) {
            console.error('Hue操作エラー:', error);
            Utils.showToast('接続エラー');
        }
    }

    async allLightsOff() {
        Utils.showToast('全グループ消灯中...');
        
        try {
            const groupIds = Object.keys(this.groups).filter(id => {
                const type = this.groups[id].type;
                return type === 'Room' || type === 'Zone';
            });
            
            for (const id of groupIds) {
                await fetch(`${this.baseUrl}/groups/${id}/action`, {
                    method: 'PUT',
                    body: JSON.stringify({ on: false })
                });
                if (this.groups[id].state) {
                    this.groups[id].state.any_on = false;
                    this.groups[id].state.all_on = false;
                }
            }
            
            this.renderGroups();
            Utils.showToast('全グループ消灯しました');
        } catch (error) {
            console.error('Hue操作エラー:', error);
            Utils.showToast('接続エラー');
        }
    }
}

// アプリケーションクラス
class KakeiboApp {
    constructor() {
        this.budget = new BudgetManager();
        this.calculator = new Calculator();
        this.csv = new CSVExporter(this.budget);
        this.holidayCalendar = new HolidayCalendar();
        this.shopping = new ShoppingList(this.budget);
        this.smartHome = new SmartHome();
        this.hue = new PhilipsHue();
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
        // 他のページを非表示
        document.getElementById('calendarSection').style.display = 'none';
        document.getElementById('shoppingSection').style.display = 'none';
        document.getElementById('smartHomeSection').style.display = 'none';
        // 家計簿ページを表示
        document.getElementById('budgetSection').style.display = 'block';
        // フッターを表示
        document.querySelector('.footer').style.display = 'block';
        // メニュー項目を切り替え
        document.getElementById('menuCalendar').style.display = 'block';
        document.getElementById('menuBudget').style.display = 'none';
        document.getElementById('menuShopping').style.display = 'block';
        document.getElementById('menuSmartHome').style.display = 'block';
        
        const jstDate = Utils.getJSTDate();
        this.budget.currentYear = jstDate.getFullYear();
        this.budget.currentMonth = jstDate.getMonth() + 1;
        this.budget.updateDisplay();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    showCalendar() {
        // 他のページを非表示
        document.getElementById('budgetSection').style.display = 'none';
        document.getElementById('shoppingSection').style.display = 'none';
        document.getElementById('smartHomeSection').style.display = 'none';
        // カレンダーページを表示
        document.getElementById('calendarSection').style.display = 'block';
        // フッターを非表示
        document.querySelector('.footer').style.display = 'none';
        // メニュー項目を切り替え
        document.getElementById('menuCalendar').style.display = 'none';
        document.getElementById('menuBudget').style.display = 'block';
        document.getElementById('menuShopping').style.display = 'block';
        document.getElementById('menuSmartHome').style.display = 'block';
        
        const jstDate = Utils.getJSTDate();
        this.holidayCalendar.currentYear = jstDate.getFullYear();
        this.holidayCalendar.currentMonth = jstDate.getMonth() + 1;
        this.holidayCalendar.renderCalendar();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    showShopping() {
        // 他のページを非表示
        document.getElementById('budgetSection').style.display = 'none';
        document.getElementById('calendarSection').style.display = 'none';
        document.getElementById('smartHomeSection').style.display = 'none';
        // 買い物リストページを表示
        document.getElementById('shoppingSection').style.display = 'block';
        // フッターを非表示
        document.querySelector('.footer').style.display = 'none';
        // メニュー項目を切り替え
        document.getElementById('menuCalendar').style.display = 'block';
        document.getElementById('menuBudget').style.display = 'block';
        document.getElementById('menuShopping').style.display = 'none';
        document.getElementById('menuSmartHome').style.display = 'block';
        
        this.shopping.renderList();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    showSmartHome() {
        // 他のページを非表示
        document.getElementById('budgetSection').style.display = 'none';
        document.getElementById('calendarSection').style.display = 'none';
        document.getElementById('shoppingSection').style.display = 'none';
        // スマートホームページを表示
        document.getElementById('smartHomeSection').style.display = 'block';
        // フッターを非表示
        document.querySelector('.footer').style.display = 'none';
        // メニュー項目を切り替え
        document.getElementById('menuCalendar').style.display = 'block';
        document.getElementById('menuBudget').style.display = 'block';
        document.getElementById('menuShopping').style.display = 'block';
        document.getElementById('menuSmartHome').style.display = 'none';
        
        this.smartHome.init();
        this.hue.init();
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
        this.holidayCalendar.init();
        this.shopping.init();
    }
}

// グローバルインスタンス
const app = new KakeiboApp();
window.app = app;

// 初期化
app.init();
