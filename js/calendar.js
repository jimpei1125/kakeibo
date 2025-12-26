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
        this.selectedUser = null;
        this.editingUserId = null;
        this.selectedColor = null;
        this.tempHolidays = [];
        
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

            html += '<div class="calendar-date-cell' + (isToday ? ' today' : '') + '">';
            html += '<div class="calendar-date-number">' + day + '</div>';
            html += '<div class="calendar-holiday-users">';
            
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
            
            if (dayHolidays.length > 3) {
                html += '<div class="calendar-more-users">+' + (dayHolidays.length - 3) + '</div>';
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
