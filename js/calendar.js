import { db, collection, addDoc, deleteDoc, query, where, getDocs, orderBy, onSnapshot } from './firebase-config.js';
import { Utils } from './utils.js';

// 休日カレンダークラス
export class HolidayCalendar {
    constructor() {
        this.currentYear = new Date().getFullYear();
        this.currentMonth = new Date().getMonth() + 1;
        this.editYear = this.currentYear;
        this.editMonth = this.currentMonth;
        this.users = [];
        this.holidays = [];
        this.memos = [];
        this.selectedUser = null;
        this.editingUserId = null;
        this.selectedColor = null;
        this.tempHolidays = [];
        this.selectedMemoType = 'task';
        this.selectedDateForMemo = null;
        this.memoListVisible = false;
        
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

        // 通知の許可を確認
        this.initNotifications();
    }

    async initNotifications() {
        if ('Notification' in window && 'serviceWorker' in navigator) {
            if (Notification.permission === 'default') {
                // 後で許可を求める
            }
            this.checkScheduledNotifications();
        }
    }

    async requestNotificationPermission() {
        if ('Notification' in window) {
            const permission = await Notification.requestPermission();
            return permission === 'granted';
        }
        return false;
    }

    checkScheduledNotifications() {
        // 1分ごとに通知をチェック
        setInterval(() => {
            this.triggerDueNotifications();
        }, 60000);
        // 初回チェック
        this.triggerDueNotifications();
    }

    triggerDueNotifications() {
        const now = new Date();
        const currentTime = now.getHours().toString().padStart(2, '0') + ':' + 
                          now.getMinutes().toString().padStart(2, '0');
        const currentDate = now.getFullYear() + '-' + 
                          String(now.getMonth() + 1).padStart(2, '0') + '-' +
                          String(now.getDate()).padStart(2, '0');

        this.memos.forEach(memo => {
            if (memo.notification && memo.notificationTime && memo.date === currentDate) {
                if (memo.notificationTime === currentTime && !memo.notified) {
                    this.showNotification(memo);
                    this.markAsNotified(memo.id);
                }
            }
        });
    }

    async showNotification(memo) {
        if ('Notification' in window && Notification.permission === 'granted') {
            const icon = memo.type === 'task' ? '📌' : '🗓️';
            const title = memo.type === 'task' ? 'タスクのリマインド' : '予定のリマインド';
            
            new Notification(title, {
                body: `${icon} ${memo.content}`,
                icon: '/favicon.ico',
                tag: memo.id
            });
        }
    }

    async markAsNotified(memoId) {
        try {
            const { updateDoc, doc } = await import('./firebase-config.js');
            await updateDoc(doc(db, 'calendarMemos', memoId), {
                notified: true
            });
        } catch (error) {
            console.error('通知済みマーク失敗:', error);
        }
    }

    async init() {
        await this.loadUsers();
        await this.loadHolidays();
        await this.loadMemos();
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

    async loadMemos() {
        const memosCol = collection(db, 'calendarMemos');
        
        onSnapshot(memosCol, (snapshot) => {
            this.memos = [];
            snapshot.forEach(doc => {
                this.memos.push({
                    id: doc.id,
                    ...doc.data()
                });
            });
            this.renderCalendar();
            if (this.memoListVisible) {
                this.renderMemoList();
            }
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
        if (this.memoListVisible) {
            this.renderMemoList();
        }
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
        
        ['日', '月', '火', '水', '木', '金', '土'].forEach(day => {
            html += '<div class="calendar-weekday">' + day + '</div>';
        });

        const prevMonthDays = new Date(this.currentYear, this.currentMonth - 1, 0).getDate();
        for (let i = startDayOfWeek - 1; i >= 0; i--) {
            html += '<div class="calendar-date-cell other-month">';
            html += '<div class="calendar-date-number">' + (prevMonthDays - i) + '</div>';
            html += '</div>';
        }

        const today = new Date();
        const todayStr = today.getFullYear() + '-' + 
                       String(today.getMonth() + 1).padStart(2, '0') + '-' +
                       String(today.getDate()).padStart(2, '0');

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = this.currentYear + '-' + 
                          String(this.currentMonth).padStart(2, '0') + '-' +
                          String(day).padStart(2, '0');
            
            const isToday = dateStr === todayStr;
            const dayHolidays = this.holidays.filter(h => h.date === dateStr);
            const dayMemos = this.memos.filter(m => m.date === dateStr);
            const hasMemos = dayMemos.length > 0;

            html += `<div class="calendar-date-cell${isToday ? ' today' : ''}${hasMemos ? ' has-memo' : ''}" onclick="app.holidayCalendar.showDateDetail('${dateStr}')">`;
            html += '<div class="calendar-date-number">' + day + '</div>';
            html += '<div class="calendar-holiday-users">';
            
            // メモインジケーター
            if (hasMemos) {
                const taskCount = dayMemos.filter(m => m.type === 'task').length;
                const scheduleCount = dayMemos.filter(m => m.type === 'schedule').length;
                html += '<div class="calendar-memo-indicator">';
                if (taskCount > 0) html += `<span class="memo-badge task">📌${taskCount}</span>`;
                if (scheduleCount > 0) html += `<span class="memo-badge schedule">🗓️${scheduleCount}</span>`;
                html += '</div>';
            }
            
            const displayUsers = dayHolidays.slice(0, 2);
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
            
            if (dayHolidays.length > 2) {
                html += '<div class="calendar-more-users">+' + (dayHolidays.length - 2) + '</div>';
            }
            
            html += '</div></div>';
        }

        const remainingDays = 42 - (startDayOfWeek + daysInMonth);
        for (let i = 1; i <= remainingDays; i++) {
            html += '<div class="calendar-date-cell other-month">';
            html += '<div class="calendar-date-number">' + i + '</div>';
            html += '</div>';
        }

        document.getElementById('holidayCalendar').innerHTML = html;
    }

    // ========== メモ機能 ==========

    showMemoForm(dateStr = null) {
        this.selectedDateForMemo = dateStr;
        this.selectedMemoType = 'task';
        
        // フォームをリセット
        document.getElementById('memoDate').value = dateStr || this.getTodayStr();
        document.getElementById('memoContent').value = '';
        document.getElementById('memoStartTime').value = '';
        document.getElementById('memoEndTime').value = '';
        document.getElementById('memoNotification').checked = false;
        document.getElementById('memoNotificationTime').value = '';
        document.getElementById('notificationTimeInput').style.display = 'none';
        document.getElementById('memoTimeSection').style.display = 'none';
        
        // タイプボタンをリセット
        document.querySelectorAll('.memo-type-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.type === 'task') btn.classList.add('active');
        });
        
        document.getElementById('memoFormModal').classList.add('show');
    }

    showMemoFormForDate() {
        const dateStr = this.selectedDateForMemo;
        this.closeDateDetail();
        this.showMemoForm(dateStr);
    }

    closeMemoForm() {
        document.getElementById('memoFormModal').classList.remove('show');
    }

    selectMemoType(type) {
        this.selectedMemoType = type;
        document.querySelectorAll('.memo-type-btn').forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.type === type) btn.classList.add('active');
        });
        
        // 予定の場合は時刻入力を表示
        const timeSection = document.getElementById('memoTimeSection');
        timeSection.style.display = type === 'schedule' ? 'block' : 'none';
    }

    toggleNotificationTime() {
        const checkbox = document.getElementById('memoNotification');
        const timeInput = document.getElementById('notificationTimeInput');
        timeInput.style.display = checkbox.checked ? 'block' : 'none';
        
        if (checkbox.checked && Notification.permission === 'default') {
            this.requestNotificationPermission();
        }
    }

    getTodayStr() {
        const today = new Date();
        return today.getFullYear() + '-' + 
               String(today.getMonth() + 1).padStart(2, '0') + '-' +
               String(today.getDate()).padStart(2, '0');
    }

    async saveMemo() {
        const date = document.getElementById('memoDate').value;
        const content = document.getElementById('memoContent').value.trim();
        const notification = document.getElementById('memoNotification').checked;
        const notificationTime = document.getElementById('memoNotificationTime').value;
        
        if (!date) {
            Utils.showToast('日付を選択してください');
            return;
        }
        
        if (!content) {
            Utils.showToast('内容を入力してください');
            return;
        }

        const memoData = {
            type: this.selectedMemoType,
            date: date,
            content: content,
            notification: notification,
            notificationTime: notification ? notificationTime : null,
            notified: false,
            createdAt: new Date().toISOString()
        };

        if (this.selectedMemoType === 'schedule') {
            memoData.startTime = document.getElementById('memoStartTime').value;
            memoData.endTime = document.getElementById('memoEndTime').value;
        }

        try {
            await addDoc(collection(db, 'calendarMemos'), memoData);
            Utils.showToast('メモを保存しました');
            this.closeMemoForm();
        } catch (error) {
            console.error('メモ保存エラー:', error);
            Utils.showToast('保存に失敗しました');
        }
    }

    toggleMemoList() {
        this.memoListVisible = !this.memoListVisible;
        const container = document.getElementById('memoListContainer');
        
        if (this.memoListVisible) {
            container.style.display = 'block';
            this.renderMemoList();
        } else {
            container.style.display = 'none';
        }
    }

    renderMemoList() {
        const container = document.getElementById('memoList');
        
        // 現在の月のメモをフィルタ
        const monthStr = this.currentYear + '-' + String(this.currentMonth).padStart(2, '0');
        const monthMemos = this.memos.filter(m => m.date && m.date.startsWith(monthStr));
        
        if (monthMemos.length === 0) {
            container.innerHTML = '<div class="no-memos">この月のメモはありません</div>';
            return;
        }

        // 日付降順、同日はタスクを上にソート
        monthMemos.sort((a, b) => {
            if (a.date !== b.date) {
                return b.date.localeCompare(a.date);
            }
            // 同日の場合、タスクを先に
            if (a.type === 'task' && b.type !== 'task') return -1;
            if (a.type !== 'task' && b.type === 'task') return 1;
            return 0;
        });

        let html = '';
        let currentDate = '';

        monthMemos.forEach(memo => {
            if (memo.date !== currentDate) {
                currentDate = memo.date;
                const dateObj = new Date(memo.date);
                const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
                const dayName = dayNames[dateObj.getDay()];
                html += `<div class="memo-date-header">${memo.date.substring(5).replace('-', '/')} (${dayName})</div>`;
            }

            const icon = memo.type === 'task' ? '📌' : '🗓️';
            const typeClass = memo.type === 'task' ? 'task' : 'schedule';
            let timeStr = '';
            
            if (memo.type === 'schedule' && memo.startTime) {
                timeStr = `<span class="memo-time">${memo.startTime}${memo.endTime ? ' - ' + memo.endTime : ''}</span>`;
            }

            const notificationIcon = memo.notification ? '🔔' : '';

            html += `
                <div class="memo-item ${typeClass}">
                    <div class="memo-item-content">
                        <span class="memo-icon">${icon}</span>
                        <div class="memo-details">
                            <span class="memo-text">${memo.content}</span>
                            ${timeStr}
                        </div>
                        ${notificationIcon ? `<span class="memo-notification-icon">${notificationIcon}</span>` : ''}
                    </div>
                    <button class="memo-delete-btn" onclick="app.holidayCalendar.deleteMemo('${memo.id}')">❌</button>
                </div>
            `;
        });

        container.innerHTML = html;
    }

    async deleteMemo(memoId) {
        try {
            const { doc } = await import('./firebase-config.js');
            await deleteDoc(doc(db, 'calendarMemos', memoId));
            Utils.showToast('メモを削除しました');
        } catch (error) {
            console.error('メモ削除エラー:', error);
            Utils.showToast('削除に失敗しました');
        }
    }

    // ========== 日付詳細モーダル ==========

    showDateDetail(dateStr) {
        this.selectedDateForMemo = dateStr;
        
        const dateObj = new Date(dateStr);
        const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
        const dayName = dayNames[dateObj.getDay()];
        const displayDate = `${dateObj.getMonth() + 1}/${dateObj.getDate()} (${dayName})`;
        
        document.getElementById('dateDetailTitle').textContent = `📅 ${displayDate}`;
        
        // 休日ユーザー表示
        const dayHolidays = this.holidays.filter(h => h.date === dateStr);
        const holidaysHtml = dayHolidays.length > 0 ? 
            '<div class="detail-section-title">🏖️ 休日</div>' +
            dayHolidays.map(h => {
                const user = this.users.find(u => u.id === h.userId);
                return user ? `
                    <div class="detail-holiday-user">
                        <div class="user-color-dot" style="background-color: ${user.color}"></div>
                        <span>${user.name}</span>
                    </div>
                ` : '';
            }).join('') : '';
        
        document.getElementById('dateDetailHolidays').innerHTML = holidaysHtml;
        
        // メモ表示
        const dayMemos = this.memos.filter(m => m.date === dateStr);
        
        // タスクを先に、予定を後に
        dayMemos.sort((a, b) => {
            if (a.type === 'task' && b.type !== 'task') return -1;
            if (a.type !== 'task' && b.type === 'task') return 1;
            return 0;
        });

        let memosHtml = '';
        if (dayMemos.length > 0) {
            memosHtml = '<div class="detail-section-title">📝 メモ</div>';
            dayMemos.forEach(memo => {
                const icon = memo.type === 'task' ? '📌' : '🗓️';
                let timeStr = '';
                if (memo.type === 'schedule' && memo.startTime) {
                    timeStr = `<div class="detail-memo-time">${memo.startTime}${memo.endTime ? ' - ' + memo.endTime : ''}</div>`;
                }
                const notificationIcon = memo.notification ? ' 🔔' : '';
                
                memosHtml += `
                    <div class="detail-memo-item ${memo.type}">
                        <div class="detail-memo-main">
                            <span class="memo-icon">${icon}</span>
                            <span class="detail-memo-content">${memo.content}${notificationIcon}</span>
                        </div>
                        ${timeStr}
                        <button class="memo-delete-btn small" onclick="app.holidayCalendar.deleteMemoFromDetail('${memo.id}')">❌</button>
                    </div>
                `;
            });
        } else {
            memosHtml = '<div class="no-memos">メモはありません</div>';
        }
        
        document.getElementById('dateDetailMemos').innerHTML = memosHtml;
        document.getElementById('dateDetailModal').classList.add('show');
    }

    closeDateDetail() {
        document.getElementById('dateDetailModal').classList.remove('show');
    }

    async deleteMemoFromDetail(memoId) {
        await this.deleteMemo(memoId);
        // モーダルを再描画
        if (this.selectedDateForMemo) {
            this.showDateDetail(this.selectedDateForMemo);
        }
    }

    // ========== ユーザー管理 ==========

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
            const user = this.users.find(u => u.id === userId);
            document.getElementById('userFormTitle').textContent = '✏️ ユーザー編集';
            document.getElementById('userName').value = user.name;
            this.selectedColor = user.color;
            document.getElementById('deleteUserBtn').style.display = 'block';
        } else {
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

    selectColor(colorValue, isUsed) {
        if (isUsed) return;
        this.selectedColor = colorValue;
        this.renderColorPalette();
    }

    async saveUser() {
        const name = document.getElementById('userName').value.trim();
        
        if (!name) {
            Utils.showToast('名前を入力してください');
            return;
        }
        
        if (!this.selectedColor) {
            Utils.showToast('色を選択してください');
            return;
        }
        
        try {
            if (this.editingUserId) {
                const { updateDoc, doc } = await import('./firebase-config.js');
                await updateDoc(doc(db, 'holidayUsers', this.editingUserId), {
                    name: name,
                    color: this.selectedColor
                });
                Utils.showToast('更新しました');
            } else {
                await addDoc(collection(db, 'holidayUsers'), {
                    name: name,
                    color: this.selectedColor,
                    order: this.users.length,
                    createdAt: new Date().toISOString()
                });
                Utils.showToast('登録しました');
            }
            
            document.getElementById('userFormModal').classList.remove('show');
            document.getElementById('userModal').classList.add('show');
        } catch (error) {
            console.error('ユーザー保存エラー:', error);
            Utils.showToast('保存に失敗しました');
        }
    }

    async deleteUser() {
        if (!this.editingUserId) return;
        if (!confirm('このユーザーを削除しますか？関連する休日データも削除されます。')) return;
        
        try {
            const { doc } = await import('./firebase-config.js');
            await deleteDoc(doc(db, 'holidayUsers', this.editingUserId));
            
            const holidaysQuery = query(
                collection(db, 'holidays'),
                where('userId', '==', this.editingUserId)
            );
            const snapshot = await getDocs(holidaysQuery);
            const deletePromises = snapshot.docs.map(d => deleteDoc(d.ref));
            await Promise.all(deletePromises);
            
            Utils.showToast('削除しました');
            document.getElementById('userFormModal').classList.remove('show');
            document.getElementById('userModal').classList.add('show');
        } catch (error) {
            console.error('ユーザー削除エラー:', error);
            Utils.showToast('削除に失敗しました');
        }
    }

    // ========== 休日編集 ==========

    showHolidayUserSelect() {
        this.renderHolidayUserSelect();
        document.getElementById('holidayUserSelectModal').classList.add('show');
    }

    closeHolidayUserSelect() {
        document.getElementById('holidayUserSelectModal').classList.remove('show');
    }

    renderHolidayUserSelect() {
        const list = document.getElementById('holidayUserSelectList');
        
        if (this.users.length === 0) {
            list.innerHTML = '<p style="text-align: center; color: rgba(255,255,255,0.5);">先にユーザーを登録してください</p>';
            return;
        }
        
        let html = '';
        this.users.forEach(user => {
            html += `
                <button class="holiday-user-btn" onclick="app.holidayCalendar.selectHolidayUser('${user.id}')" style="border-left: 4px solid ${user.color}">
                    <span class="user-emoji">👤</span> ${user.name}
                </button>
            `;
        });
        
        list.innerHTML = html;
    }

    selectHolidayUser(userId) {
        this.selectedUser = this.users.find(u => u.id === userId);
        this.closeHolidayUserSelect();
        this.showHolidayEdit();
    }

    showHolidayEdit() {
        if (!this.selectedUser) return;
        
        this.editYear = this.currentYear;
        this.editMonth = this.currentMonth;
        
        const userHolidays = this.holidays.filter(h => h.userId === this.selectedUser.id);
        this.tempHolidays = userHolidays.map(h => h.date);
        
        document.getElementById('holidayEditTitle').textContent = 
            `📅 ${this.selectedUser.name}さんの休日編集`;
        
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
        
        ['日', '月', '火', '水', '木', '金', '土'].forEach(day => {
            html += '<div class="edit-calendar-weekday">' + day + '</div>';
        });

        for (let i = 0; i < startDayOfWeek; i++) {
            html += '<div class="edit-calendar-cell empty"></div>';
        }

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = this.editYear + '-' + 
                          String(this.editMonth).padStart(2, '0') + '-' +
                          String(day).padStart(2, '0');
            const isSelected = this.tempHolidays.includes(dateStr);
            
            html += `
                <div class="edit-calendar-cell ${isSelected ? 'selected' : ''}" 
                     onclick="app.holidayCalendar.toggleHoliday('${dateStr}')">
                    ${day}
                </div>
            `;
        }

        document.getElementById('editCalendar').innerHTML = html;
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

    async saveHolidays() {
        if (!this.selectedUser) return;
        
        try {
            const existingQuery = query(
                collection(db, 'holidays'),
                where('userId', '==', this.selectedUser.id)
            );
            const snapshot = await getDocs(existingQuery);
            const deletePromises = snapshot.docs.map(doc => deleteDoc(doc.ref));
            await Promise.all(deletePromises);
            
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
