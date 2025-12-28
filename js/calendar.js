/**
 * カレンダーモジュール
 * 休日カレンダー、ユーザー管理、メモ機能、Googleカレンダー連携を提供
 */

import { db, collection, addDoc, deleteDoc, query, where, getDocs, orderBy, onSnapshot } from './firebase-config.js';
import { Utils } from './utils.js';

// ============================================================
// 定数定義
// ============================================================

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const CALENDAR_CELLS = 42;

const USER_COLORS = [
    { name: '赤', value: '#FF5733', emoji: '🔴' },
    { name: 'オレンジ', value: '#FF8C42', emoji: '🟠' },
    { name: '黄', value: '#FFC300', emoji: '🟡' },
    { name: '緑', value: '#38EF7D', emoji: '🟢' },
    { name: '青', value: '#4FACFE', emoji: '🔵' },
    { name: '紫', value: '#9B59B6', emoji: '🟣' },
    { name: 'ピンク', value: '#FF69B4', emoji: '💗' },
    { name: '茶', value: '#8B4513', emoji: '🟤' }
];

const GCAL_CONFIG = {
    clientId: '120845540864-apujs76kfni95rndqsueaupi48ccfetd.apps.googleusercontent.com',
    scopes: 'https://www.googleapis.com/auth/calendar.events'
};

// ============================================================
// 休日カレンダークラス
// ============================================================

export class HolidayCalendar {
    constructor() {
        const now = new Date();
        this.currentYear = now.getFullYear();
        this.currentMonth = now.getMonth() + 1;
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
        
        this.gcalConnected = false;
        this.gcalTokenClient = null;
        this.gcalAccessToken = null;
        this.colors = USER_COLORS;
    }

    // ==================== 初期化 ====================

    async init() {
        await Promise.all([this.loadUsers(), this.loadHolidays(), this.loadMemos()]);
        this.renderCalendar();
        this.initGoogleCalendar();
    }

    // ==================== Googleカレンダー連携 ====================

    initGoogleCalendar() {
        this._loadScript('https://accounts.google.com/gsi/client', () => this.setupGoogleAuth());
        this._loadScript('https://apis.google.com/js/api.js', () => {
            gapi.load('client', () => gapi.client.init({}).then(() => gapi.client.load('calendar', 'v3')));
        });
        this._restoreSavedToken();
    }

    _loadScript(src, onload) {
        const script = Object.assign(document.createElement('script'), { src, async: true, defer: true, onload });
        document.head.appendChild(script);
    }

    _restoreSavedToken() {
        const savedToken = localStorage.getItem('gcal_access_token');
        const savedExpiry = localStorage.getItem('gcal_token_expiry');
        if (savedToken && savedExpiry && Date.now() < parseInt(savedExpiry)) {
            this.gcalAccessToken = savedToken;
            this.gcalConnected = true;
            this.updateGcalStatus();
        }
    }

    setupGoogleAuth() {
        this.gcalTokenClient = google.accounts.oauth2.initTokenClient({
            client_id: GCAL_CONFIG.clientId,
            scope: GCAL_CONFIG.scopes,
            callback: (res) => {
                if (res.access_token) {
                    this.gcalAccessToken = res.access_token;
                    this.gcalConnected = true;
                    localStorage.setItem('gcal_access_token', res.access_token);
                    localStorage.setItem('gcal_token_expiry', Date.now() + (res.expires_in * 1000));
                    this.updateGcalStatus();
                    Utils.showToast('Googleカレンダーと連携しました');
                }
            },
            error_callback: () => Utils.showToast('認証に失敗しました')
        });
        this.updateGcalStatus();
    }

    toggleGoogleCalendar() {
        if (this.gcalConnected) {
            this.gcalAccessToken = null;
            this.gcalConnected = false;
            localStorage.removeItem('gcal_access_token');
            localStorage.removeItem('gcal_token_expiry');
            this.updateGcalStatus();
            Utils.showToast('Googleカレンダーの連携を解除しました');
        } else if (this.gcalTokenClient) {
            this.gcalTokenClient.requestAccessToken();
        } else {
            Utils.showToast('認証の準備中です');
        }
    }

    updateGcalStatus() {
        const statusText = document.getElementById('gcalStatusText');
        const linkBtn = document.getElementById('gcalLinkBtn');
        if (!statusText || !linkBtn) return;
        
        statusText.textContent = this.gcalConnected ? 'Googleカレンダー: 連携中 ✓' : 'Googleカレンダー: 未連携';
        statusText.style.color = this.gcalConnected ? '#38EF7D' : 'rgba(255,255,255,0.6)';
        linkBtn.textContent = this.gcalConnected ? '🔓 解除' : '🔗 連携';
        linkBtn.classList.toggle('connected', this.gcalConnected);
    }

    async createGoogleCalendarEvent(memo) {
        if (!this.gcalConnected || !this.gcalAccessToken) return null;
        try {
            const isSchedule = memo.type === 'schedule';
            const event = {
                summary: isSchedule ? memo.content : `📌 ${memo.content}`,
                description: isSchedule ? '家計簿アプリから登録' : 'タスク - 家計簿アプリから登録',
                start: { dateTime: `${memo.date}T${memo.startTime || memo.taskTime || '09:00'}:00`, timeZone: 'Asia/Tokyo' },
                end: { dateTime: `${memo.date}T${memo.endTime || memo.taskTime || '10:00'}:00`, timeZone: 'Asia/Tokyo' },
                reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: isSchedule ? 60 : 0 }] }
            };
            const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.gcalAccessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(event)
            });
            if (res.ok) return (await res.json()).id;
            if (res.status === 401) this._handleTokenExpired();
            return null;
        } catch (e) { console.error('Googleカレンダー連携エラー:', e); return null; }
    }

    _handleTokenExpired() {
        this.gcalConnected = false;
        this.gcalAccessToken = null;
        localStorage.removeItem('gcal_access_token');
        localStorage.removeItem('gcal_token_expiry');
        this.updateGcalStatus();
        Utils.showToast('Googleカレンダーの認証が切れました');
    }

    async deleteGoogleCalendarEvent(eventId) {
        if (!this.gcalConnected || !this.gcalAccessToken || !eventId) return false;
        try {
            const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
                method: 'DELETE', headers: { 'Authorization': `Bearer ${this.gcalAccessToken}` }
            });
            return res.ok || res.status === 204;
        } catch (e) { console.error('Googleカレンダー削除エラー:', e); return false; }
    }

    // ==================== データ読み込み ====================

    async loadUsers() {
        onSnapshot(query(collection(db, 'holidayUsers'), orderBy('order', 'asc')), (snap) => {
            this.users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            this.updateUsersList();
            this.renderCalendar();
        });
    }

    async loadHolidays() {
        onSnapshot(collection(db, 'holidays'), (snap) => {
            this.holidays = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            this.renderCalendar();
        });
    }

    async loadMemos() {
        onSnapshot(collection(db, 'calendarMemos'), (snap) => {
            this.memos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            this.renderCalendar();
            if (this.memoListVisible) this.renderMemoList();
        });
    }

    updateUsersList() {
        const el = document.getElementById('usersList');
        if (!el) return;
        el.innerHTML = this.users.length === 0
            ? '<span class="no-users">ユーザーが登録されていません</span>'
            : this.users.map(u => `<div class="user-tag"><div class="user-color-dot" style="background-color:${u.color}"></div><span>${u.name}</span></div>`).join('');
    }

    // ==================== 月切り替え ====================

    changeMonth(delta) {
        this._adjustMonth('current', delta);
        this.renderCalendar();
        if (this.memoListVisible) this.renderMemoList();
    }

    changeEditMonth(delta) {
        this._adjustMonth('edit', delta);
        this.renderEditCalendar();
    }

    _adjustMonth(type, delta) {
        const y = type === 'edit' ? 'editYear' : 'currentYear';
        const m = type === 'edit' ? 'editMonth' : 'currentMonth';
        this[m] += delta;
        if (this[m] > 12) { this[m] = 1; this[y]++; }
        else if (this[m] < 1) { this[m] = 12; this[y]--; }
    }

    // ==================== カレンダー描画 ====================

    renderCalendar() {
        const monthEl = document.getElementById('calendarCurrentMonth');
        const calEl = document.getElementById('holidayCalendar');
        if (!monthEl || !calEl) return;
        
        monthEl.textContent = `${this.currentYear}年${this.currentMonth}月`;
        const firstDay = new Date(this.currentYear, this.currentMonth - 1, 1);
        const daysInMonth = new Date(this.currentYear, this.currentMonth, 0).getDate();
        const startDow = firstDay.getDay();
        const todayStr = Utils.formatDateString(new Date());
        const prevDays = new Date(this.currentYear, this.currentMonth - 1, 0).getDate();

        let html = WEEKDAYS.map(d => `<div class="calendar-weekday">${d}</div>`).join('');
        
        for (let i = startDow - 1; i >= 0; i--) {
            html += `<div class="calendar-date-cell other-month"><div class="calendar-date-number">${prevDays - i}</div></div>`;
        }

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${this.currentYear}-${String(this.currentMonth).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
            const isToday = dateStr === todayStr;
            const dayH = this.holidays.filter(h => h.date === dateStr);
            const dayM = this.memos.filter(m => m.date === dateStr);
            
            html += `<div class="calendar-date-cell${isToday ? ' today' : ''}${dayM.length ? ' has-memo' : ''}" onclick="app.holidayCalendar.showDateDetail('${dateStr}')">`;
            html += `<div class="calendar-date-number">${day}</div><div class="calendar-holiday-users">`;
            
            if (dayM.length) {
                const tc = dayM.filter(m => m.type === 'task').length;
                const sc = dayM.filter(m => m.type === 'schedule').length;
                html += '<div class="calendar-memo-indicator">';
                if (tc) html += `<span class="memo-badge task">📌${tc}</span>`;
                if (sc) html += `<span class="memo-badge schedule">🗓️${sc}</span>`;
                html += '</div>';
            }
            
            dayH.slice(0, 3).forEach(h => {
                const u = this.users.find(x => x.id === h.userId);
                if (u) html += `<div class="calendar-holiday-user"><div class="calendar-holiday-dot" style="background-color:${u.color}"></div><span class="calendar-holiday-name">${u.name}</span></div>`;
            });
            if (dayH.length > 3) html += `<div class="calendar-more-users">+${dayH.length - 3}</div>`;
            html += '</div></div>';
        }

        const remain = CALENDAR_CELLS - (startDow + daysInMonth);
        for (let i = 1; i <= remain; i++) {
            html += `<div class="calendar-date-cell other-month"><div class="calendar-date-number">${i}</div></div>`;
        }
        calEl.innerHTML = html;
    }

    // ==================== メモ機能 ====================

    showMemoForm(dateStr = null) {
        this.selectedDateForMemo = dateStr;
        this.selectedMemoType = 'task';
        document.getElementById('memoDate').value = dateStr || Utils.getTodayString();
        document.getElementById('memoContent').value = '';
        document.getElementById('memoStartTime').value = '';
        document.getElementById('memoEndTime').value = '';
        document.getElementById('memoTaskTime').value = '09:00';
        document.getElementById('memoNotification').checked = true;
        Utils.setVisible('memoTimeSection', false);
        Utils.setVisible('memoTaskTimeSection', true);
        document.querySelectorAll('.memo-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'task'));
        this.updateNotificationNote();
        Utils.showModal('memoFormModal');
    }

    showMemoFormForDate() { const d = this.selectedDateForMemo; this.closeDateDetail(); this.showMemoForm(d); }
    closeMemoForm() { Utils.closeModal('memoFormModal'); }

    selectMemoType(type) {
        this.selectedMemoType = type;
        document.querySelectorAll('.memo-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
        Utils.setVisible('memoTimeSection', type === 'schedule');
        Utils.setVisible('memoTaskTimeSection', type === 'task');
        this.updateNotificationNote();
    }

    updateNotificationNote() {
        const n = document.getElementById('gcalNotificationNote');
        if (n) n.textContent = this.selectedMemoType === 'schedule' ? '※ 予定の1時間前に通知' : '※ 設定時刻に通知';
    }

    getTodayStr() { return Utils.formatDateString(new Date()); }

    async saveMemo() {
        const date = document.getElementById('memoDate')?.value;
        const content = document.getElementById('memoContent')?.value.trim();
        const notification = document.getElementById('memoNotification')?.checked;
        if (!date) return Utils.showToast('日付を選択してください');
        if (!content) return Utils.showToast('内容を入力してください');

        const memoData = { type: this.selectedMemoType, date, content, notification, createdAt: new Date().toISOString() };
        if (this.selectedMemoType === 'schedule') {
            memoData.startTime = document.getElementById('memoStartTime')?.value;
            memoData.endTime = document.getElementById('memoEndTime')?.value;
            if (!memoData.startTime) return Utils.showToast('開始時刻を入力してください');
        } else {
            memoData.taskTime = document.getElementById('memoTaskTime')?.value;
            if (notification && !memoData.taskTime) return Utils.showToast('通知時刻を入力してください');
        }

        try {
            if (notification && this.gcalConnected) {
                const gcalId = await this.createGoogleCalendarEvent(memoData);
                if (gcalId) { memoData.gcalEventId = gcalId; Utils.showToast('Googleカレンダーにも登録しました'); }
            }
            await addDoc(collection(db, 'calendarMemos'), memoData);
            if (!memoData.gcalEventId && notification) Utils.showToast('メモを保存しました（Googleカレンダー未連携）');
            else if (!notification) Utils.showToast('メモを保存しました');
            this.closeMemoForm();
        } catch (e) { console.error('メモ保存エラー:', e); Utils.showToast('保存に失敗しました'); }
    }

    toggleMemoList() {
        this.memoListVisible = !this.memoListVisible;
        Utils.setVisible('memoListContainer', this.memoListVisible);
        if (this.memoListVisible) this.renderMemoList();
    }

    renderMemoList() {
        const c = document.getElementById('memoList');
        if (!c) return;
        const monthStr = `${this.currentYear}-${String(this.currentMonth).padStart(2,'0')}`;
        const memos = this.memos.filter(m => m.date?.startsWith(monthStr)).sort((a,b) => a.date !== b.date ? b.date.localeCompare(a.date) : (a.type === 'task' ? -1 : 1));
        
        if (!memos.length) { c.innerHTML = '<div class="no-memos">この月のメモはありません</div>'; return; }
        let html = '', curDate = '';
        memos.forEach(m => {
            if (m.date !== curDate) {
                curDate = m.date;
                html += `<div class="memo-date-header">${m.date.substring(5).replace('-','/')} (${WEEKDAYS[new Date(m.date).getDay()]})</div>`;
            }
            const icon = m.type === 'task' ? '📌' : '🗓️';
            const time = m.type === 'schedule' && m.startTime ? `<span class="memo-time">${m.startTime}${m.endTime ? ' - '+m.endTime : ''}</span>` : m.taskTime ? `<span class="memo-time">🔔 ${m.taskTime}</span>` : '';
            html += `<div class="memo-item ${m.type}"><div class="memo-item-content"><span class="memo-icon">${icon}</span><div class="memo-details"><span class="memo-text">${m.content}</span>${time}</div>${m.gcalEventId ? '<span class="memo-gcal-icon">📅</span>' : ''}</div><button class="memo-delete-btn" onclick="app.holidayCalendar.deleteMemo('${m.id}')">❌</button></div>`;
        });
        c.innerHTML = html;
    }

    async deleteMemo(memoId) {
        try {
            const memo = this.memos.find(m => m.id === memoId);
            if (memo?.gcalEventId && await this.deleteGoogleCalendarEvent(memo.gcalEventId)) Utils.showToast('Googleカレンダーからも削除しました');
            const { doc } = await import('./firebase-config.js');
            await deleteDoc(doc(db, 'calendarMemos', memoId));
            if (!memo?.gcalEventId) Utils.showToast('メモを削除しました');
        } catch (e) { console.error('メモ削除エラー:', e); Utils.showToast('削除に失敗しました'); }
    }

    // ==================== 日付詳細モーダル ====================

    showDateDetail(dateStr) {
        this.selectedDateForMemo = dateStr;
        const d = new Date(dateStr);
        document.getElementById('dateDetailTitle').textContent = `📅 ${d.getMonth()+1}/${d.getDate()} (${WEEKDAYS[d.getDay()]})`;
        
        const holidays = this.holidays.filter(h => h.date === dateStr);
        let hHtml = holidays.length ? '<div class="detail-section-title">🏖️ 休日</div>' + holidays.map(h => {
            const u = this.users.find(x => x.id === h.userId);
            return u ? `<div class="detail-holiday-user"><div class="user-color-dot" style="background-color:${u.color}"></div><span>${u.name}</span></div>` : '';
        }).join('') : '';
        document.getElementById('dateDetailHolidays').innerHTML = hHtml;

        const memos = this.memos.filter(m => m.date === dateStr).sort((a,b) => a.type === 'task' ? -1 : 1);
        let mHtml = memos.length ? '<div class="detail-section-title">📝 メモ</div>' : '<div class="no-memos">メモはありません</div>';
        memos.forEach(m => {
            const icon = m.type === 'task' ? '📌' : '🗓️';
            const time = m.type === 'schedule' && m.startTime ? `<div class="detail-memo-time">${m.startTime}${m.endTime ? ' - '+m.endTime : ''}</div>` : m.taskTime ? `<div class="detail-memo-time">🔔 ${m.taskTime}</div>` : '';
            mHtml += `<div class="detail-memo-item ${m.type}"><div class="detail-memo-main"><span class="memo-icon">${icon}</span><span class="detail-memo-content">${m.content}${m.gcalEventId ? ' 📅' : ''}</span></div>${time}<button class="memo-delete-btn small" onclick="app.holidayCalendar.deleteMemoFromDetail('${m.id}')">❌</button></div>`;
        });
        document.getElementById('dateDetailMemos').innerHTML = mHtml;
        Utils.showModal('dateDetailModal');
    }

    closeDateDetail() { Utils.closeModal('dateDetailModal'); }
    async deleteMemoFromDetail(id) { await this.deleteMemo(id); if (this.selectedDateForMemo) this.showDateDetail(this.selectedDateForMemo); }

    // ==================== ユーザー管理 ====================

    showUserManagement() { this.renderUserList(); Utils.showModal('userModal'); }
    closeUserModal() { Utils.closeModal('userModal'); }

    renderUserList() {
        const el = document.getElementById('userListModal');
        if (!el) return;
        el.innerHTML = this.users.length === 0
            ? '<p style="text-align:center;color:rgba(255,255,255,0.5);">ユーザーが登録されていません</p>'
            : this.users.map(u => `<div class="user-item" onclick="app.holidayCalendar.editUser('${u.id}')"><div class="user-color-dot" style="background-color:${u.color}"></div><span>${u.name}</span></div>`).join('');
    }

    showUserForm(userId = null) {
        this.editingUserId = userId;
        const user = userId ? this.users.find(u => u.id === userId) : null;
        document.getElementById('userFormTitle').textContent = userId ? '✏️ ユーザー編集' : '✨ ユーザー新規登録';
        document.getElementById('userName').value = user?.name || '';
        this.selectedColor = user?.color || null;
        document.getElementById('deleteUserBtn').style.display = userId ? 'block' : 'none';
        this.renderColorPalette();
        Utils.closeModal('userModal');
        Utils.showModal('userFormModal');
    }

    editUser(userId) { this.showUserForm(userId); }
    closeUserForm() { Utils.closeModal('userFormModal'); Utils.showModal('userModal'); }

    renderColorPalette() {
        const el = document.getElementById('colorPalette');
        if (!el) return;
        const usedColors = this.users.filter(u => u.id !== this.editingUserId).map(u => u.color);
        el.innerHTML = this.colors.map(c => {
            const used = usedColors.includes(c.value), sel = this.selectedColor === c.value;
            return `<div class="color-option${used ? ' disabled' : ''}${sel ? ' selected' : ''}" style="background-color:${c.value}" onclick="app.holidayCalendar.selectColor('${c.value}',${used})">${sel ? '✓' : c.emoji}</div>`;
        }).join('');
    }

    selectColor(val, used) { if (!used) { this.selectedColor = val; this.renderColorPalette(); } }

    async saveUser() {
        const name = document.getElementById('userName')?.value.trim();
        if (!name) return Utils.showToast('名前を入力してください');
        if (!this.selectedColor) return Utils.showToast('色を選択してください');
        try {
            if (this.editingUserId) {
                const { updateDoc, doc } = await import('./firebase-config.js');
                await updateDoc(doc(db, 'holidayUsers', this.editingUserId), { name, color: this.selectedColor });
                Utils.showToast('更新しました');
            } else {
                await addDoc(collection(db, 'holidayUsers'), { name, color: this.selectedColor, order: this.users.length, createdAt: new Date().toISOString() });
                Utils.showToast('登録しました');
            }
            Utils.closeModal('userFormModal'); Utils.showModal('userModal');
        } catch (e) { console.error('ユーザー保存エラー:', e); Utils.showToast('保存に失敗しました'); }
    }

    async deleteUser() {
        if (!this.editingUserId || !confirm('このユーザーを削除しますか？')) return;
        try {
            const { doc } = await import('./firebase-config.js');
            await deleteDoc(doc(db, 'holidayUsers', this.editingUserId));
            const snap = await getDocs(query(collection(db, 'holidays'), where('userId', '==', this.editingUserId)));
            await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
            Utils.showToast('削除しました');
            Utils.closeModal('userFormModal'); Utils.showModal('userModal');
        } catch (e) { console.error('ユーザー削除エラー:', e); Utils.showToast('削除に失敗しました'); }
    }

    // ==================== 休日編集 ====================

    showHolidayUserSelect() { this.renderHolidayUserSelect(); Utils.showModal('holidayUserSelectModal'); }
    closeHolidayUserSelect() { Utils.closeModal('holidayUserSelectModal'); }

    renderHolidayUserSelect() {
        const el = document.getElementById('holidayUserSelectList');
        if (!el) return;
        el.innerHTML = this.users.length === 0
            ? '<p style="text-align:center;color:rgba(255,255,255,0.5);">先にユーザーを登録してください</p>'
            : this.users.map(u => `<button class="holiday-user-btn" onclick="app.holidayCalendar.selectHolidayUser('${u.id}')" style="border-left:4px solid ${u.color}"><span class="user-emoji">👤</span> ${u.name}</button>`).join('');
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
        this.tempHolidays = this.holidays.filter(h => h.userId === this.selectedUser.id).map(h => h.date);
        document.getElementById('holidayEditTitle').textContent = `📅 ${this.selectedUser.name}さんの休日編集`;
        this.renderEditCalendar();
        Utils.showModal('holidayEditModal');
    }

    renderEditCalendar() {
        document.getElementById('editCalendarMonth').textContent = `${this.editYear}年${this.editMonth}月`;
        const daysInMonth = new Date(this.editYear, this.editMonth, 0).getDate();
        const startDow = new Date(this.editYear, this.editMonth - 1, 1).getDay();
        
        let html = WEEKDAYS.map(d => `<div class="edit-calendar-weekday">${d}</div>`).join('');
        for (let i = 0; i < startDow; i++) html += '<div class="edit-calendar-cell empty"></div>';
        
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${this.editYear}-${String(this.editMonth).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
            const sel = this.tempHolidays.includes(dateStr);
            html += `<div class="edit-calendar-cell${sel ? ' selected' : ''}" onclick="app.holidayCalendar.toggleHoliday('${dateStr}')">${day}</div>`;
        }
        document.getElementById('editCalendar').innerHTML = html;
    }

    toggleHoliday(dateStr) {
        const idx = this.tempHolidays.indexOf(dateStr);
        if (idx > -1) this.tempHolidays.splice(idx, 1);
        else this.tempHolidays.push(dateStr);
        this.renderEditCalendar();
    }

    async saveHolidays() {
        if (!this.selectedUser) return;
        try {
            const snap = await getDocs(query(collection(db, 'holidays'), where('userId', '==', this.selectedUser.id)));
            await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
            await Promise.all(this.tempHolidays.map(date => addDoc(collection(db, 'holidays'), { userId: this.selectedUser.id, date, createdAt: new Date().toISOString() })));
            Utils.showToast('休日を保存しました');
            Utils.closeModal('holidayEditModal');
        } catch (e) { console.error('休日保存エラー:', e); alert('保存に失敗しました'); }
    }

    cancelHolidayEdit() { Utils.closeModal('holidayEditModal'); }
}
