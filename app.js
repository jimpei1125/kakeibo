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

// Google Calendar認証クラス
class GoogleCalendarAuth {
    constructor() {
        this.clientId = '805926802884-n1clrn2a0el5pkbkdfn2bf2btje2vnge.apps.googleusercontent.com.apps.googleusercontent.com'; // ← ここにクライアントIDを入力
        this.apiKey = null; // Web版OAuth 2.0ではAPIキーは不要
        this.discoveryDocs = ['https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest'];
        this.scopes = 'https://www.googleapis.com/auth/calendar.events';
        this.tokenClient = null;
        this.accessToken = null;
        this.isSignedIn = false;
    }

    async init() {
        try {
            // Google Identity Services (GIS) の初期化
            await this.loadGoogleAPIs();
            
            // トークンクライアントの初期化
            this.tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: this.clientId,
                scope: this.scopes,
                callback: (response) => {
                    if (response.error !== undefined) {
                        console.error('認証エラー:', response);
                        Utils.showToast('認証に失敗しました');
                        return;
                    }
                    
                    this.accessToken = response.access_token;
                    this.isSignedIn = true;
                    this.saveTokenToFirestore(response);
                    this.updateSyncStatus(true);
                    Utils.showToast('Googleカレンダーと連携しました');
                }
            });

            // Firestoreから保存されたトークンを読み込み
            await this.loadTokenFromFirestore();
        } catch (error) {
            console.error('Google API初期化エラー:', error);
        }
    }

    async loadGoogleAPIs() {
        return new Promise((resolve) => {
            const checkGapi = setInterval(() => {
                if (window.gapi && window.google) {
                    clearInterval(checkGapi);
                    gapi.load('client', () => {
                        gapi.client.init({
                            discoveryDocs: this.discoveryDocs,
                        }).then(() => {
                            resolve();
                        });
                    });
                }
            }, 100);
        });
    }

    async signIn() {
        if (!this.tokenClient) {
            Utils.showToast('初期化中です...');
            return;
        }
        
        // トークン取得リクエスト
        this.tokenClient.requestAccessToken({ prompt: 'consent' });
    }

    async signOut() {
        if (this.accessToken) {
            google.accounts.oauth2.revoke(this.accessToken, () => {
                console.log('トークンを取り消しました');
            });
        }
        
        this.accessToken = null;
        this.isSignedIn = false;
        
        // Firestoreから削除
        await this.removeTokenFromFirestore();
        
        this.updateSyncStatus(false);
        Utils.showToast('Googleカレンダーとの連携を解除しました');
    }

    async saveTokenToFirestore(tokenResponse) {
        try {
            const user = auth.currentUser;
            if (!user) {
                console.log('ユーザーが未ログイン');
                return;
            }

            const userRef = doc(db, 'users', user.uid);
            await setDoc(userRef, {
                googleAuth: {
                    accessToken: tokenResponse.access_token,
                    expiresAt: Date.now() + (tokenResponse.expires_in * 1000),
                    scope: tokenResponse.scope,
                    tokenType: tokenResponse.token_type,
                    connectedAt: new Date().toISOString()
                }
            }, { merge: true });
        } catch (error) {
            console.error('トークン保存エラー:', error);
        }
    }

    async loadTokenFromFirestore() {
        try {
            const user = auth.currentUser;
            if (!user) return;

            const userRef = doc(db, 'users', user.uid);
            const userSnap = await getDoc(userRef);

            if (userSnap.exists() && userSnap.data().googleAuth) {
                const authData = userSnap.data().googleAuth;
                
                // トークンの有効期限チェック
                if (authData.expiresAt > Date.now()) {
                    this.accessToken = authData.accessToken;
                    this.isSignedIn = true;
                    this.updateSyncStatus(true);
                } else {
                    // トークンが期限切れ
                    await this.removeTokenFromFirestore();
                }
            }
        } catch (error) {
            console.error('トークン読み込みエラー:', error);
        }
    }

    async removeTokenFromFirestore() {
        try {
            const user = auth.currentUser;
            if (!user) return;

            const userRef = doc(db, 'users', user.uid);
            await setDoc(userRef, {
                googleAuth: deleteField()
            }, { merge: true });
        } catch (error) {
            console.error('トークン削除エラー:', error);
        }
    }

    updateSyncStatus(connected) {
        const syncCard = document.getElementById('syncStatusCard');
        const syncTitle = document.getElementById('syncTitle');
        const syncDescription = document.getElementById('syncDescription');
        const syncBtn = document.getElementById('syncBtn');

        if (connected) {
            syncCard.classList.add('connected');
            syncTitle.textContent = 'Googleカレンダー連携中';
            syncDescription.textContent = '予定は自動的にGoogleカレンダーに同期されます';
            syncBtn.textContent = '連携解除';
            syncBtn.classList.add('connected');
        } else {
            syncCard.classList.remove('connected');
            syncTitle.textContent = 'Googleカレンダー連携';
            syncDescription.textContent = '連携すると自動でGoogleカレンダーに同期されます';
            syncBtn.textContent = '連携する';
            syncBtn.classList.remove('connected');
        }
    }

    async createCalendarEvent(event, dateStr) {
        if (!this.isSignedIn || !this.accessToken) {
            console.log('Google Calendar未連携');
            return null;
        }

        try {
            const [year, month, day] = dateStr.split('-');
            const startDateTime = event.startTime 
                ? `${dateStr}T${event.startTime}:00`
                : `${dateStr}T00:00:00`;
            const endDateTime = event.endTime 
                ? `${dateStr}T${event.endTime}:00`
                : `${dateStr}T01:00:00`;

            const calendarEvent = {
                summary: event.title,
                description: event.description || '',
                start: {
                    dateTime: startDateTime,
                    timeZone: 'Asia/Tokyo'
                },
                end: {
                    dateTime: endDateTime,
                    timeZone: 'Asia/Tokyo'
                }
            };

            const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(calendarEvent)
            });

            if (!response.ok) {
                throw new Error('Calendar API error: ' + response.statusText);
            }

            const data = await response.json();
            console.log('Googleカレンダーにイベント作成:', data.id);
            return data.id;
        } catch (error) {
            console.error('カレンダーイベント作成エラー:', error);
            Utils.showToast('Googleカレンダーへの同期に失敗しました');
            return null;
        }
    }

    async updateCalendarEvent(googleEventId, event, dateStr) {
        if (!this.isSignedIn || !this.accessToken || !googleEventId) {
            return null;
        }

        try {
            const [year, month, day] = dateStr.split('-');
            const startDateTime = event.startTime 
                ? `${dateStr}T${event.startTime}:00`
                : `${dateStr}T00:00:00`;
            const endDateTime = event.endTime 
                ? `${dateStr}T${event.endTime}:00`
                : `${dateStr}T01:00:00`;

            const calendarEvent = {
                summary: event.title,
                description: event.description || '',
                start: {
                    dateTime: startDateTime,
                    timeZone: 'Asia/Tokyo'
                },
                end: {
                    dateTime: endDateTime,
                    timeZone: 'Asia/Tokyo'
                }
            };

            const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${googleEventId}`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(calendarEvent)
            });

            if (!response.ok) {
                throw new Error('Calendar API error: ' + response.statusText);
            }

            console.log('Googleカレンダーのイベントを更新');
            return googleEventId;
        } catch (error) {
            console.error('カレンダーイベント更新エラー:', error);
            return null;
        }
    }

    async deleteCalendarEvent(googleEventId) {
        if (!this.isSignedIn || !this.accessToken || !googleEventId) {
            return;
        }

        try {
            const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${googleEventId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            });

            if (!response.ok) {
                throw new Error('Calendar API error: ' + response.statusText);
            }

            console.log('Googleカレンダーからイベントを削除');
        } catch (error) {
            console.error('カレンダーイベント削除エラー:', error);
        }
    }
}

// カレンダー管理クラス
class CalendarManager {
    constructor(googleAuth) {
        this.googleAuth = googleAuth;
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

    toggleGoogleSync() {
        if (this.googleAuth.isSignedIn) {
            // 連携解除
            if (confirm('Googleカレンダーとの連携を解除しますか？')) {
                this.googleAuth.signOut();
            }
        } else {
            // 連携開始
            this.googleAuth.signIn();
        }
    }

    renderCalendar() {
        const monthDisplay = document.getElementById('calendarMonthDisplay');
        const grid = document.getElementById('calendarGrid');
        
        if (!monthDisplay || !grid) {
            console.error('❌ Calendar elements not found!');
            return;
        }
        
        monthDisplay.textContent = this.currentYear + '年 ' + this.currentMonth + '月';

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

    showEventModal(dateStr, startHour = null) {
        this.isEditMode = false;
        this.selectedDate = dateStr;
        this.selectedEventId = null;
        
        // タイムスロットモーダルを閉じる
        this.closeTimeslotModal();
        
        // 時間指定がある場合は自動入力
        if (startHour !== null) {
            const endHour = startHour + 1;
            const startTime = String(startHour).padStart(2, '0') + ':00';
            const endTime = String(endHour).padStart(2, '0') + ':00';
            
            document.getElementById('eventModalTitle').textContent = '📅 スケジュール作成';
            document.getElementById('eventTitle').value = '';
            document.getElementById('eventDate').value = dateStr;
            document.getElementById('eventStartTime').value = startTime;
            document.getElementById('eventEndTime').value = endTime;
            document.getElementById('eventDescription').value = '';
            document.getElementById('deleteEventBtn').style.display = 'none';
            
            document.getElementById('eventModal').classList.add('show');
        } else {
            // 時間指定がない場合はタイムスロット選択画面へ
            this.showTimeslotModal(dateStr);
        }
    }

    showTimeslotModal(dateStr) {
        this.selectedDate = dateStr;
        
        // 日付をフォーマット
        const date = new Date(dateStr);
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const day = date.getDate();
        
        document.getElementById('timeslotModalTitle').textContent = 
            year + '年' + month + '月' + day + '日';
        
        // タイムスロットを生成
        let html = '';
        const events = this.data.events[dateStr] || [];
        
        for (let hour = 0; hour < 24; hour++) {
            const startTime = String(hour).padStart(2, '0') + ':00';
            const endTime = String(hour + 1).padStart(2, '0') + ':00';
            
            // この時間帯にイベントがあるか確認
            const eventsInSlot = events.filter(event => {
                if (!event.startTime) return false;
                const eventHour = parseInt(event.startTime.split(':')[0]);
                return eventHour === hour;
            });
            
            const isOccupied = eventsInSlot.length > 0;
            
            html += '<div class="timeslot' + (isOccupied ? ' occupied' : '') + '" ';
            
            if (isOccupied) {
                // 既存イベントをクリックして編集
                html += 'onclick="app.calendar.editEvent(\'' + dateStr + '\', \'' + eventsInSlot[0].id + '\')">';
                html += '<div class="timeslot-time">' + startTime + ' - ' + endTime + '</div>';
                html += '<div class="timeslot-event">' + eventsInSlot[0].title + '</div>';
            } else {
                // 空きスロットをクリックして新規作成
                html += 'onclick="app.calendar.showEventModal(\'' + dateStr + '\', ' + hour + ')">';
                html += '<div class="timeslot-time">' + startTime + ' - ' + endTime + '</div>';
                html += '<div class="timeslot-event">空き</div>';
            }
            
            html += '</div>';
        }
        
        document.getElementById('timeslotGrid').innerHTML = html;
        document.getElementById('timeslotModal').classList.add('show');
    }

    closeTimeslotModal() {
        document.getElementById('timeslotModal').classList.remove('show');
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
        
        // タイムスロットモーダルを閉じる
        this.closeTimeslotModal();
        
        document.getElementById('eventModal').classList.add('show');
    }

    closeEventModal() {
        document.getElementById('eventModal').classList.remove('show');
        // スケジュール作成画面を閉じたらタイムスロットモーダルに戻る
        if (this.selectedDate) {
            this.showTimeslotModal(this.selectedDate);
        }
    }

    async saveEvent() {
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
            const existingEvent = this.data.events[date][eventIndex];
            
            this.data.events[date][eventIndex] = {
                id: this.selectedEventId,
                title,
                startTime,
                endTime,
                description,
                googleEventId: existingEvent.googleEventId, // 既存のGoogleイベントIDを保持
                updatedAt: new Date().toISOString()
            };
            
            // Googleカレンダーを更新
            if (existingEvent.googleEventId) {
                await this.googleAuth.updateCalendarEvent(existingEvent.googleEventId, {
                    title,
                    startTime,
                    endTime,
                    description
                }, date);
            }
            
            Utils.showToast('スケジュールを更新しました');
        } else {
            // 新規作成
            const eventId = 'event_' + Date.now();
            
            // Googleカレンダーにイベント作成
            const googleEventId = await this.googleAuth.createCalendarEvent({
                title,
                startTime,
                endTime,
                description
            }, date);
            
            this.data.events[date].push({
                id: eventId,
                title,
                startTime,
                endTime,
                description,
                googleEventId: googleEventId, // GoogleイベントIDを保存
                createdAt: new Date().toISOString()
            });
            
            Utils.showToast('スケジュールを作成しました');
        }

        this.saveToFirestore();
        
        // モーダルを閉じる
        document.getElementById('eventModal').classList.remove('show');
        
        // カレンダーを更新
        this.renderCalendar();
        
        // タイムスロットモーダルを表示
        this.showTimeslotModal(this.selectedDate);
    }

    async deleteEvent() {
        if (!confirm('このスケジュールを削除しますか？')) return;

        const date = this.selectedDate;
        const event = this.data.events[date].find(e => e.id === this.selectedEventId);
        
        // Googleカレンダーから削除
        if (event && event.googleEventId) {
            await this.googleAuth.deleteCalendarEvent(event.googleEventId);
        }
        
        this.data.events[date] = this.data.events[date].filter(e => e.id !== this.selectedEventId);
        
        if (this.data.events[date].length === 0) {
            delete this.data.events[date];
        }

        this.saveToFirestore();
        
        // モーダルを閉じる
        document.getElementById('eventModal').classList.remove('show');
        
        // カレンダーを更新
        this.renderCalendar();
        
        Utils.showToast('スケジュールを削除しました');
        
        // タイムスロットモーダルを表示
        this.showTimeslotModal(this.selectedDate);
    }

}

// Google認証クラス
class GoogleAuthManager {
    constructor() {
        this.CLIENT_ID = 'YOUR_CLIENT_ID_HERE.apps.googleusercontent.com'; // ★ここにクライアントIDを入れる
        this.SCOPES = 'https://www.googleapis.com/auth/calendar.events';
        this.tokenClient = null;
        this.accessToken = null;
        this.userInfo = null;
    }

    init() {
        // Google Identity Services の初期化
        if (typeof google !== 'undefined') {
            this.tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: this.CLIENT_ID,
                scope: this.SCOPES,
                callback: (response) => {
                    if (response.error) {
                        console.error('認証エラー:', response);
                        Utils.showToast('認証に失敗しました');
                        return;
                    }
                    this.accessToken = response.access_token;
                    this.saveTokenToFirestore(response);
                    this.getUserInfo();
                    Utils.showToast('Googleカレンダーと連携しました');
                }
            });
        }

        // 保存済みのトークンを読み込む
        this.loadTokenFromFirestore();
    }

    showAuthModal() {
        this.updateAuthUI();
        document.getElementById('authModal').classList.add('show');
    }

    closeAuthModal() {
        document.getElementById('authModal').classList.remove('show');
    }

    handleAuth() {
        if (!this.tokenClient) {
            alert('Google認証の準備ができていません。ページを再読み込みしてください。');
            return;
        }

        // トークンリクエスト
        this.tokenClient.requestAccessToken();
    }

    async getUserInfo() {
        if (!this.accessToken) return;

        try {
            const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            });

            if (response.ok) {
                this.userInfo = await response.json();
                this.updateAuthUI();
            }
        } catch (error) {
            console.error('ユーザー情報取得エラー:', error);
        }
    }

    updateAuthUI() {
        const authButton = document.getElementById('authButton');
        const disconnectButton = document.getElementById('disconnectButton');
        const authUserInfo = document.getElementById('authUserInfo');
        const authStatus = document.getElementById('authStatus');

        if (this.accessToken && this.userInfo) {
            // 接続済み
            authButton.style.display = 'none';
            disconnectButton.style.display = 'block';
            authUserInfo.style.display = 'flex';
            authStatus.style.display = 'none';

            // ユーザー情報を表示
            document.getElementById('userName').textContent = this.userInfo.name;
            document.getElementById('userEmail').textContent = this.userInfo.email;
            
            const avatar = document.getElementById('userAvatar');
            if (this.userInfo.picture) {
                avatar.innerHTML = `<img src="${this.userInfo.picture}" alt="${this.userInfo.name}">`;
            } else {
                avatar.textContent = this.userInfo.name.charAt(0);
            }
        } else {
            // 未接続
            authButton.style.display = 'block';
            disconnectButton.style.display = 'none';
            authUserInfo.style.display = 'none';
            authStatus.style.display = 'block';
        }
    }

    disconnect() {
        if (!confirm('Googleカレンダーとの連携を解除しますか？')) return;

        this.accessToken = null;
        this.userInfo = null;
        
        // Firestoreから削除
        this.deleteTokenFromFirestore();
        
        this.updateAuthUI();
        Utils.showToast('連携を解除しました');
    }

    async saveTokenToFirestore(tokenResponse) {
        try {
            const docRef = doc(db, 'googleAuth', 'tokens');
            await setDoc(docRef, {
                accessToken: tokenResponse.access_token,
                expiresAt: Date.now() + (tokenResponse.expires_in * 1000),
                updatedAt: new Date().toISOString()
            });
        } catch (error) {
            console.error('トークン保存エラー:', error);
        }
    }

    async loadTokenFromFirestore() {
        try {
            const docRef = doc(db, 'googleAuth', 'tokens');
            onSnapshot(docRef, (docSnap) => {
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    
                    // トークンの有効期限チェック
                    if (data.expiresAt > Date.now()) {
                        this.accessToken = data.accessToken;
                        this.getUserInfo();
                    } else {
                        // 期限切れ
                        this.deleteTokenFromFirestore();
                    }
                }
            });
        } catch (error) {
            console.error('トークン読み込みエラー:', error);
        }
    }

    async deleteTokenFromFirestore() {
        try {
            const docRef = doc(db, 'googleAuth', 'tokens');
            await setDoc(docRef, {});
        } catch (error) {
            console.error('トークン削除エラー:', error);
        }
    }

    // カレンダーにイベントを作成
    async createCalendarEvent(event) {
        if (!this.accessToken) {
            console.log('Google未連携のためスキップ');
            return null;
        }

        try {
            const calendarEvent = {
                summary: event.title,
                description: event.description || '',
                start: {
                    dateTime: event.date + 'T' + (event.startTime || '00:00') + ':00',
                    timeZone: 'Asia/Tokyo'
                },
                end: {
                    dateTime: event.date + 'T' + (event.endTime || '23:59') + ':00',
                    timeZone: 'Asia/Tokyo'
                }
            };

            const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(calendarEvent)
            });

            if (response.ok) {
                const data = await response.json();
                console.log('Googleカレンダーにイベント作成:', data.id);
                return data.id;
            } else {
                throw new Error('イベント作成失敗');
            }
        } catch (error) {
            console.error('Googleカレンダー同期エラー:', error);
            return null;
        }
    }

    // カレンダーのイベントを更新
    async updateCalendarEvent(googleEventId, event) {
        if (!this.accessToken || !googleEventId) return;

        try {
            const calendarEvent = {
                summary: event.title,
                description: event.description || '',
                start: {
                    dateTime: event.date + 'T' + (event.startTime || '00:00') + ':00',
                    timeZone: 'Asia/Tokyo'
                },
                end: {
                    dateTime: event.date + 'T' + (event.endTime || '23:59') + ':00',
                    timeZone: 'Asia/Tokyo'
                }
            };

            const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${googleEventId}`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(calendarEvent)
            });

            if (response.ok) {
                console.log('Googleカレンダーのイベント更新:', googleEventId);
            }
        } catch (error) {
            console.error('Googleカレンダー更新エラー:', error);
        }
    }

    // カレンダーのイベントを削除
    async deleteCalendarEvent(googleEventId) {
        if (!this.accessToken || !googleEventId) return;

        try {
            const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${googleEventId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            });

            if (response.ok) {
                console.log('Googleカレンダーのイベント削除:', googleEventId);
            }
        } catch (error) {
            console.error('Googleカレンダー削除エラー:', error);
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
        this.googleAuth = new GoogleCalendarAuth();
        this.budget = new BudgetManager();
        this.calculator = new Calculator();
        this.csv = new CSVExporter(this.budget);
        this.calendar = new CalendarManager(this.googleAuth);
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
        const budgetSection = document.getElementById('budgetSection');
        const calendarSection = document.getElementById('calendarSection');
        
        if (!calendarSection) {
            console.error('❌ calendarSection not found!');
            return;
        }
        
        budgetSection.style.display = 'none';
        calendarSection.style.display = 'block';
        
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
        
        // Google認証の初期化
        setTimeout(() => {
            this.googleAuth.init();
        }, 1000);
    }
}

// グローバルインスタンス
const app = new KakeiboApp();
window.app = app;

// 初期化
app.init();
