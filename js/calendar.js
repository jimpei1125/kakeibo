/**
 * カレンダーモジュール
 * 休日カレンダー、ユーザー管理、メモ機能、Googleカレンダー連携を提供
 */

import { db, doc, setDoc, updateDoc, collection, addDoc, deleteDoc, query, where, getDocs, orderBy, onSnapshot } from './firebase-config.js';
import { Utils } from './utils.js';
import { Icons } from './icons.js';
import { Dialog } from './dialog.js';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const CALENDAR_CELLS = 42;
const SWIPE_THRESHOLD = 50;

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

/**
 * Googleカレンダー同期Worker（gcal-sync）のURL
 * OAuth・トークン管理・予定キャッシュはすべてWorker側が担うため、
 * ブラウザでのGoogle認証は発生しない（worker/gcal-sync/ 参照）
 */
const GCAL_WORKER_URL = 'https://gcal-sync.zinnpei11251818.workers.dev';

/** カレンダーのマスに個別表示する予定の最大件数（超過分は +n 表示） */
const GCAL_MAX_EVENTS_PER_CELL = 2;

/**
 * 年月日を YYYY-MM-DD 形式の文字列に変換
 * @param {number} year
 * @param {number} month - 1-12
 * @param {number} day
 * @returns {string}
 */
function toDateStr(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * FirestoreのスナップショットをID付きオブジェクト配列に変換
 * @param {Object} snap - QuerySnapshot
 * @returns {Array<Object>}
 */
function docsToList(snap) {
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// 日本の祝日を計算（固定祝日・ハッピーマンデー・春分/秋分・国民の休日・振替休日に対応）
const _holidayCache = {};
function getJapaneseHolidays(year) {
    if (_holidayCache[year]) return _holidayCache[year];

    const pad = (n) => String(n).padStart(2, '0');
    const toStr = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    const parse = (ds) => { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d); };
    const holidays = {};
    const add = (month, day, name) => { holidays[toStr(new Date(year, month - 1, day))] = name; };
    // 指定月の第n月曜日（ハッピーマンデー用）
    const nthMonday = (month, n) => {
        const firstDow = new Date(year, month - 1, 1).getDay();
        return 1 + ((1 - firstDow + 7) % 7) + (n - 1) * 7;
    };

    add(1, 1, '元日');
    add(1, nthMonday(1, 2), '成人の日');
    add(2, 11, '建国記念の日');
    if (year >= 2020) add(2, 23, '天皇誕生日');
    add(3, Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4)), '春分の日');
    add(4, 29, '昭和の日');
    add(5, 3, '憲法記念日');
    add(5, 4, 'みどりの日');
    add(5, 5, 'こどもの日');
    add(7, nthMonday(7, 3), '海の日');
    if (year >= 2016) add(8, 11, '山の日');
    add(9, nthMonday(9, 3), '敬老の日');
    add(9, Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4)), '秋分の日');
    add(10, nthMonday(10, 2), 'スポーツの日');
    add(11, 3, '文化の日');
    add(11, 23, '勤労感謝の日');

    const base = { ...holidays };

    // 国民の休日：前日と翌日がともに祝日の平日（例：敬老の日と秋分の日に挟まれた日）
    Object.keys(base).forEach(ds => {
        const mid = parse(ds); mid.setDate(mid.getDate() + 1);
        const next = parse(ds); next.setDate(next.getDate() + 2);
        if (base[toStr(next)] && !base[toStr(mid)] && mid.getDay() !== 0) {
            holidays[toStr(mid)] = '国民の休日';
        }
    });

    // 振替休日：日曜と重なった祝日の後、最初の平日
    Object.keys(base).forEach(ds => {
        const dt = parse(ds);
        if (dt.getDay() === 0) {
            const sub = new Date(dt);
            do { sub.setDate(sub.getDate() + 1); } while (holidays[toStr(sub)]);
            holidays[toStr(sub)] = '振替休日';
        }
    });

    _holidayCache[year] = holidays;
    return holidays;
}

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
        this.editingMemoId = null;
        this.memoFilter = 'all';
        this.draggedMemo = null;
        
        // スワイプ用
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.touchStartTime = 0;
        this.isSwiping = false;
        
        // Pull to Refresh用
        this.pullStartY = 0;
        this.isPulling = false;
        this.pullDistance = 0;
        
        this.gcalConnected = false;
        /** @type {string} Worker連携用のアプリキー（合言葉） */
        this.gcalAppKey = localStorage.getItem('gcal_app_key') || '';
        /** @type {Array<{id: string, title: string, start: string, end: string, allDay: boolean, location: string}>} 同期済みの予定 */
        this.gcalEvents = [];
        try {
            // 前回取得分のキャッシュで即描画（オフライン時もここまでは出る）
            this.gcalEvents = JSON.parse(localStorage.getItem('gcal_events_cache')) || [];
        } catch { /* キャッシュ破損時は空のまま */ }
        this.colors = USER_COLORS;
    }

    async init() {
        await Promise.all([this.loadUsers(), this.loadHolidays(), this.loadMemos()]);
        this.renderCalendar();
        this.initGcalSync();
        this.initSwipeNavigation();
        this.initPullToRefresh();
    }

    // ==================== スワイプナビゲーション ====================

    initSwipeNavigation() {
        const calendarSection = document.getElementById('calendarSection');
        if (!calendarSection) return;
        calendarSection.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: true });
        calendarSection.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
        calendarSection.addEventListener('touchend', (e) => this.handleTouchEnd(e), { passive: true });
    }

    handleTouchStart(e) {
        this.touchStartX = e.touches[0].clientX;
        this.touchStartY = e.touches[0].clientY;
        this.touchStartTime = Date.now();
        this.isSwiping = false;
    }

    handleTouchMove(e) {
        if (!this.touchStartX) return;
        const diffX = e.touches[0].clientX - this.touchStartX;
        const diffY = e.touches[0].clientY - this.touchStartY;
        if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 10) {
            this.isSwiping = true;
            if (Math.abs(diffX) > 30) e.preventDefault();
        }
    }

    handleTouchEnd(e) {
        if (!this.isSwiping) { this.resetTouchState(); return; }
        const diffX = e.changedTouches[0].clientX - this.touchStartX;
        const timeDiff = Date.now() - this.touchStartTime;
        const velocity = Math.abs(diffX) / timeDiff;
        if (Math.abs(diffX) > SWIPE_THRESHOLD || velocity > 0.3) {
            this.animateMonthChange(diffX > 0 ? -1 : 1);
        }
        this.resetTouchState();
    }

    resetTouchState() {
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.touchStartTime = 0;
        this.isSwiping = false;
    }

    animateMonthChange(delta) {
        const calendar = document.getElementById('holidayCalendar');
        if (!calendar) return;
        const direction = delta > 0 ? 'slide-left' : 'slide-right';
        calendar.classList.add(direction);
        setTimeout(() => {
            this.changeMonth(delta);
            calendar.classList.remove(direction);
            calendar.classList.add(direction === 'slide-left' ? 'slide-in-right' : 'slide-in-left');
            setTimeout(() => calendar.classList.remove('slide-in-right', 'slide-in-left'), 300);
        }, 150);
    }

    // ==================== Pull to Refresh ====================

    initPullToRefresh() {
        const calendarSection = document.getElementById('calendarSection');
        if (!calendarSection) return;
        
        const indicator = document.createElement('div');
        indicator.id = 'pullToRefreshIndicator';
        indicator.className = 'pull-to-refresh-indicator mb-2.5 flex items-center justify-center gap-2.5 overflow-hidden rounded-xl bg-indigo-500/10';
        indicator.innerHTML = `<span class="pull-icon text-xl">${Icons.svg('arrow-down')}</span><span class="pull-text text-sm font-semibold text-zinc-300">引っ張って更新</span>`;
        calendarSection.insertBefore(indicator, calendarSection.firstChild);

        calendarSection.addEventListener('touchstart', (e) => this.handlePullStart(e), { passive: true });
        calendarSection.addEventListener('touchmove', (e) => this.handlePullMove(e), { passive: false });
        calendarSection.addEventListener('touchend', (e) => this.handlePullEnd(e), { passive: true });
    }

    handlePullStart(e) {
        if (window.scrollY === 0) {
            this.pullStartY = e.touches[0].clientY;
            this.isPulling = true;
        }
    }

    handlePullMove(e) {
        if (!this.isPulling || window.scrollY > 0) return;
        this.pullDistance = Math.max(0, (e.touches[0].clientY - this.pullStartY) * 0.5);
        if (this.pullDistance > 0) {
            e.preventDefault();
            const indicator = document.getElementById('pullToRefreshIndicator');
            if (indicator) {
                indicator.style.height = `${Math.min(this.pullDistance, 80)}px`;
                indicator.style.opacity = Math.min(this.pullDistance / 60, 1);
                indicator.classList.toggle('ready', this.pullDistance > 60);
                indicator.querySelector('.pull-text').textContent = this.pullDistance > 60 ? '離して更新' : '引っ張って更新';
            }
        }
    }

    async handlePullEnd(e) {
        if (!this.isPulling) return;
        const indicator = document.getElementById('pullToRefreshIndicator');
        if (this.pullDistance > 60) {
            if (indicator) {
                indicator.classList.add('refreshing');
                indicator.querySelector('.pull-text').textContent = '更新中...';
                indicator.querySelector('.pull-icon').innerHTML = Icons.svg('refresh');
            }
            await this.refreshData();
            Utils.showToast('更新しました');
        }
        if (indicator) {
            indicator.style.height = '0';
            indicator.style.opacity = '0';
            indicator.classList.remove('ready', 'refreshing');
            indicator.querySelector('.pull-text').textContent = '引っ張って更新';
            indicator.querySelector('.pull-icon').innerHTML = Icons.svg('arrow-down');
        }
        this.isPulling = false;
        this.pullDistance = 0;
        this.pullStartY = 0;
    }

    async refreshData() {
        const [memosSnap, holidaysSnap, usersSnap] = await Promise.all([
            getDocs(collection(db, 'calendarMemos')),
            getDocs(collection(db, 'holidays')),
            getDocs(query(collection(db, 'holidayUsers'), orderBy('order', 'asc'))),
            this.loadGcalEvents(true) // Googleカレンダーの予定も再同期（エラーは内部処理済み）
        ]);
        this.memos = docsToList(memosSnap);
        this.holidays = docsToList(holidaysSnap);
        this.users = docsToList(usersSnap);
        this.renderCalendar();
        if (this.memoListVisible) this.renderMemoList();
    }

    // ==================== Googleカレンダー連携（Worker経由） ====================

    /**
     * Worker連携の初期化（連携状態の確認と予定の取得）
     * ブラウザでのGoogle認証は行わない
     */
    initGcalSync() {
        // 旧方式（ブラウザ内トークン）の残骸を掃除
        localStorage.removeItem('gcal_access_token');
        localStorage.removeItem('gcal_token_expiry');

        this.updateGcalStatus();
        if (!this.gcalAppKey) return;

        this._gcalRequest('/status')
            .then(data => {
                this.gcalConnected = !!data.linked;
                this.updateGcalStatus();
            })
            .catch(e => console.error('連携状態確認エラー:', e));
        this.loadGcalEvents();
    }

    /**
     * 同期Workerへのリクエスト
     * @private
     * @param {string} path - エンドポイント（例: '/events'）
     * @param {string} [method]
     * @param {Object|null} [body]
     * @returns {Promise<Object>}
     */
    async _gcalRequest(path, method = 'GET', body = null) {
        const options = {
            method,
            headers: { 'X-App-Key': this.gcalAppKey, 'Content-Type': 'application/json' },
        };
        if (body) options.body = JSON.stringify(body);
        const res = await fetch(`${GCAL_WORKER_URL}${path}`, options);
        if (res.status === 401) throw new Error('アプリキーが正しくありません');
        return res.json();
    }

    /**
     * 予定をWorkerから取得して描画
     * @param {boolean} [force] - trueでWorkerにGoogleカレンダーの再同期を要求（引っ張って更新用）
     */
    async loadGcalEvents(force = false) {
        if (!this.gcalAppKey) return;
        try {
            const data = force
                ? await this._gcalRequest('/sync', 'POST')
                : await this._gcalRequest('/events');
            this.gcalEvents = data.events || [];
            try {
                localStorage.setItem('gcal_events_cache', JSON.stringify(this.gcalEvents));
            } catch { /* 容量超過等は無視（次回オンライン取得で復旧） */ }
            this.renderCalendar();
        } catch (e) { console.error('予定取得エラー:', e); }
    }

    /**
     * アプリキーを保存して連携を初期化
     */
    saveGcalAppKey() {
        const input = document.getElementById('gcalAppKeyInput');
        const key = input?.value.trim();
        if (!key) return Utils.showToast('アプリキーを入力してください');

        this.gcalAppKey = key;
        localStorage.setItem('gcal_app_key', key);
        Utils.showToast('アプリキーを保存しました');
        this.initGcalSync();
    }

    /**
     * 連携/解除ボタン（連携＝Worker経由のGoogle認可を新規タブで開く。一度だけ）
     */
    toggleGoogleCalendar() {
        if (!this.gcalAppKey) return;
        if (this.gcalConnected) {
            this._unlinkGcal();
        } else {
            window.open(
                `${GCAL_WORKER_URL}/oauth/start?key=${encodeURIComponent(this.gcalAppKey)}`,
                '_blank', 'noopener,noreferrer'
            );
            // 別タブでの認可完了をポーリングで検知する（完了したら自動で連携中表示になる）
            this._pollGcalStatus(24);
        }
    }

    /**
     * 認可完了を5秒間隔で確認（最大attempts回＝約2分）
     * @private
     */
    _pollGcalStatus(attempts) {
        if (this._gcalPollTimer) clearTimeout(this._gcalPollTimer);
        if (attempts <= 0 || this.gcalConnected) return;

        this._gcalPollTimer = setTimeout(async () => {
            try {
                const data = await this._gcalRequest('/status');
                if (data.linked) {
                    this.gcalConnected = true;
                    this.updateGcalStatus();
                    Utils.showToast('Googleカレンダーと連携しました');
                    this.loadGcalEvents();
                    return;
                }
            } catch { /* 一時的な失敗は次の試行へ */ }
            this._pollGcalStatus(attempts - 1);
        }, 5000);
    }

    /**
     * 連携解除（Worker側のトークンを破棄。家族全員に影響するため確認をはさむ）
     * @private
     */
    async _unlinkGcal() {
        const confirmed = await Dialog.confirm(
            'Googleカレンダーの連携を解除しますか？\n（家族全員の端末で予定表示が無効になります）',
            { okLabel: '解除', danger: true }
        );
        if (!confirmed) return;

        try {
            await this._gcalRequest('/oauth', 'DELETE');
            this.gcalConnected = false;
            this.gcalEvents = [];
            localStorage.removeItem('gcal_events_cache');
            this.updateGcalStatus();
            this.renderCalendar();
            Utils.showToast('Googleカレンダーの連携を解除しました');
        } catch (e) {
            console.error('連携解除エラー:', e);
            Utils.showToast('解除に失敗しました');
        }
    }

    updateGcalStatus() {
        const statusText = document.getElementById('gcalStatusText');
        const linkBtn = document.getElementById('gcalLinkBtn');
        if (!statusText || !linkBtn) return;

        // アプリキー未設定の間は入力欄を出し、連携ボタンは隠す
        Utils.setVisible('gcalKeySetup', !this.gcalAppKey);
        if (!this.gcalAppKey) {
            statusText.textContent = 'Googleカレンダー: アプリキー未設定';
            statusText.style.color = '';
            linkBtn.style.display = 'none';
            return;
        }

        linkBtn.style.display = '';
        statusText.textContent = this.gcalConnected ? 'Googleカレンダー: 連携中（家族で共有）✓' : 'Googleカレンダー: 未連携';
        statusText.style.color = this.gcalConnected ? '#34d399' : '';
        linkBtn.innerHTML = this.gcalConnected ? `${Icons.svg('x')} 解除` : `${Icons.svg('link')} 連携`;
        linkBtn.classList.toggle('connected', this.gcalConnected);
    }

    _buildGcalEvent(memo) {
        const isSchedule = memo.type === 'schedule';
        return {
            summary: isSchedule ? memo.content : `📌 ${memo.content}`,
            description: isSchedule ? '家計簿アプリから登録' : 'タスク - 家計簿アプリから登録',
            start: { dateTime: `${memo.date}T${memo.startTime || memo.taskTime || '09:00'}:00`, timeZone: 'Asia/Tokyo' },
            end: { dateTime: `${memo.date}T${memo.endTime || memo.taskTime || '10:00'}:00`, timeZone: 'Asia/Tokyo' },
            reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: isSchedule ? 60 : 0 }] }
        };
    }

    async createGoogleCalendarEvent(memo) {
        if (!this.gcalConnected || !this.gcalAppKey) return null;
        try {
            const data = await this._gcalRequest('/gcal/events', 'POST', this._buildGcalEvent(memo));
            return data.id || null;
        } catch (e) { console.error('Googleカレンダー連携エラー:', e); return null; }
    }

    async updateGoogleCalendarEvent(eventId, memo) {
        if (!this.gcalConnected || !this.gcalAppKey || !eventId) return false;
        try {
            const data = await this._gcalRequest(
                `/gcal/events/${encodeURIComponent(eventId)}`, 'PUT', this._buildGcalEvent(memo));
            return !data.error;
        } catch (e) { console.error('Googleカレンダー更新エラー:', e); return false; }
    }

    async deleteGoogleCalendarEvent(eventId) {
        if (!this.gcalConnected || !this.gcalAppKey || !eventId) return false;
        try {
            const data = await this._gcalRequest(`/gcal/events/${encodeURIComponent(eventId)}`, 'DELETE');
            return !!data.ok;
        } catch (e) { console.error('Googleカレンダー削除エラー:', e); return false; }
    }

    // ==================== 予定の日付マッピング・表示 ====================

    /**
     * 日付（YYYY-MM-DD）→予定配列のマップを構築
     * アプリのメモ由来の予定（gcalEventIdが一致）は除外する（メモバッジと二重表示になるため）
     * @private
     * @returns {Object<string, Array>}
     */
    _buildGcalEventMap() {
        const map = {};
        if (!this.gcalEvents.length) return map;

        const memoEventIds = new Set(this.memos.map(m => m.gcalEventId).filter(Boolean));

        for (const ev of this.gcalEvents) {
            // 繰り返し予定のインスタンスIDは「元ID_タイムスタンプ」形式のため、元IDでも照合する
            if (memoEventIds.has(ev.id) || memoEventIds.has(String(ev.id).split('_')[0])) continue;
            for (const dateStr of this._gcalEventDates(ev)) {
                (map[dateStr] ||= []).push(ev);
            }
        }
        return map;
    }

    /**
     * 予定が表示される日付の一覧
     * 終日は start〜end（endは排他的）を展開、時刻ありは開始時刻のJST日付1日のみ
     * @private
     * @param {Object} ev
     * @returns {string[]}
     */
    _gcalEventDates(ev) {
        if (!/^\d{4}-\d{2}-\d{2}/.test(ev.start || '')) return [];

        if (ev.allDay) {
            const dates = [];
            const [y, m, d] = ev.start.split('-').map(Number);
            const cursor = new Date(Date.UTC(y, m - 1, d));
            // 安全弁: 異常に長い期間でも62日で打ち切る
            for (let i = 0; i < 62; i++) {
                const ds = toDateStr(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate());
                if (ev.end && ds >= ev.end) break; // YYYY-MM-DD同士は辞書順比較でよい
                dates.push(ds);
                cursor.setUTCDate(cursor.getUTCDate() + 1);
            }
            return dates.length ? dates : [ev.start];
        }

        const t = new Date(ev.start);
        if (Number.isNaN(t.getTime())) return [];
        const jst = new Date(t.getTime() + 9 * 60 * 60 * 1000);
        return [toDateStr(jst.getUTCFullYear(), jst.getUTCMonth() + 1, jst.getUTCDate())];
    }

    /**
     * RFC3339時刻をJSTの HH:MM に整形（不正な値は空文字）
     * @private
     */
    _jstTimeHHMM(iso) {
        const t = new Date(iso);
        if (Number.isNaN(t.getTime())) return '';
        const jst = new Date(t.getTime() + 9 * 60 * 60 * 1000);
        return `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
    }

    /**
     * マス表示用の予定ラベル（時刻あり: "HH:MM タイトル"）
     * @private
     */
    _gcalEventLabel(ev) {
        if (ev.allDay) return ev.title;
        const time = this._jstTimeHHMM(ev.start);
        return time ? `${time} ${ev.title}` : ev.title;
    }

    /**
     * 詳細モーダル用の時刻表示（"10:00 - 11:00" / 終日）
     * @private
     */
    _gcalEventTimeRange(ev) {
        if (ev.allDay) return '終日';
        const start = this._jstTimeHHMM(ev.start);
        const end = this._jstTimeHHMM(ev.end);
        return end ? `${start} - ${end}` : start;
    }

    // ==================== データ読み込み ====================

    async loadUsers() {
        onSnapshot(query(collection(db, 'holidayUsers'), orderBy('order', 'asc')), (snap) => {
            this.users = docsToList(snap);
            this.updateUsersList();
            this.renderCalendar();
        });
    }

    async loadHolidays() {
        onSnapshot(collection(db, 'holidays'), (snap) => {
            this.holidays = docsToList(snap);
            this.renderCalendar();
            this._dedupeHolidays();
        });
    }

    /**
     * 同一ユーザー×同一日付で重複しているドキュメントを1件に整理する。
     * 旧実装（保存のたびにランダムIDでaddDoc）で作られた重複データの自動修復用。
     * 重複が無ければ何もしないため、通常時のコストは配列走査のみ。
     */
    async _dedupeHolidays() {
        // 実行中、または権限不足などで一度失敗した場合は再試行しない（スナップショット毎の空振りを防ぐ）
        if (this._dedupingHolidays || this._dedupeHolidaysFailed) return;

        // userId+date ごとにドキュメントをまとめ、2件以上あるものだけ対象にする
        const groups = {};
        this.holidays.forEach(h => {
            if (!h.userId || !h.date) return;
            (groups[`${h.userId}_${h.date}`] ||= []).push(h);
        });

        const removals = [];
        Object.entries(groups).forEach(([canonicalId, docs]) => {
            if (docs.length < 2) return;
            // 残す1件は全端末で同じ結果になるよう決める（固定IDがあればそれ、無ければID最小）
            const keep = docs.find(h => h.id === canonicalId)
                || [...docs].sort((a, b) => a.id.localeCompare(b.id))[0];
            docs.forEach(h => { if (h.id !== keep.id) removals.push(h.id); });
        });
        if (removals.length === 0) return;

        this._dedupingHolidays = true;
        try {
            await Promise.all(removals.map(id => deleteDoc(doc(db, 'holidays', id))));
            Utils.showToast(`休日データの重複を整理しました（${removals.length}件）`);
        } catch (e) {
            console.error('休日重複整理エラー:', e);
            this._dedupeHolidaysFailed = true;
        } finally {
            this._dedupingHolidays = false;
        }
    }

    async loadMemos() {
        onSnapshot(collection(db, 'calendarMemos'), (snap) => {
            this.memos = docsToList(snap);
            this.renderCalendar();
            if (this.memoListVisible) this.renderMemoList();
        });
    }

    updateUsersList() {
        const el = document.getElementById('usersList');
        if (!el) return;
        el.innerHTML = this.users.length === 0
            ? '<span class="no-users text-sm text-zinc-500">ユーザーが登録されていません</span>'
            : this.users.map(u => `<div class="user-tag inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-xs font-semibold text-zinc-300 ring-1 ring-inset ring-white/10"><div class="user-color-dot h-2.5 w-2.5 shrink-0 rounded-full" style="background-color:${u.color}"></div><span>${Utils.escapeHtml(u.name)}</span></div>`).join('');
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
        const shifted = Utils.shiftMonth(this[y], this[m], delta);
        this[y] = shifted.year;
        this[m] = shifted.month;
    }

    // ==================== カレンダー描画 ====================

    renderCalendar() {
        const monthEl = document.getElementById('calendarCurrentMonth');
        const calEl = document.getElementById('holidayCalendar');
        if (!monthEl || !calEl) return;
        
        monthEl.textContent = `${this.currentYear}年${this.currentMonth}月`;
        const daysInMonth = new Date(this.currentYear, this.currentMonth, 0).getDate();
        const startDow = new Date(this.currentYear, this.currentMonth - 1, 1).getDay();
        const todayStr = Utils.formatDateString(new Date());
        const prevDays = new Date(this.currentYear, this.currentMonth - 1, 0).getDate();

        const numberClass = 'calendar-date-number mb-0.5 text-[10px] font-bold leading-none text-white sm:text-[11px]';
        const otherMonthCell = (n) => `<div class="calendar-date-cell other-month min-h-[25px] rounded-md bg-white/5 p-0.5 opacity-30 sm:min-h-[30px]"><div class="${numberClass}">${n}</div></div>`;

        const gcalMap = this._buildGcalEventMap();

        let html = WEEKDAYS.map(d => `<div class="calendar-weekday py-1.5 text-center text-[9px] font-bold text-zinc-500 sm:text-[10px]">${d}</div>`).join('');

        for (let i = startDow - 1; i >= 0; i--) html += otherMonthCell(prevDays - i);

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = toDateStr(this.currentYear, this.currentMonth, day);
            const isToday = dateStr === todayStr;
            const dayH = this.holidays.filter(h => h.date === dateStr);
            const dayM = this.memos.filter(m => m.date === dateStr);
            const dayE = gcalMap[dateStr] || [];

            let cellClass = 'calendar-date-cell flex min-h-[85px] cursor-pointer flex-col rounded-md p-0.5 transition sm:min-h-[95px]';
            cellClass += isToday ? ' today bg-indigo-500/15 ring-2 ring-inset ring-indigo-500' : ' bg-white/5 hover:bg-white/10';
            if (dayM.length) cellClass += ' has-memo';

            html += `<div class="${cellClass}" data-date="${dateStr}" onclick="app.holidayCalendar.showDateDetail('${dateStr}')" ondragover="app.holidayCalendar.handleDragOver(event)" ondragleave="app.holidayCalendar.handleDragLeave(event)" ondrop="app.holidayCalendar.handleDrop(event, '${dateStr}')">`;
            html += `<div class="${numberClass}">${day}</div><div class="calendar-holiday-users flex flex-col gap-px">`;

            if (dayM.length) {
                const tc = dayM.filter(m => m.type === 'task').length;
                const sc = dayM.filter(m => m.type === 'schedule').length;
                html += '<div class="calendar-memo-indicator mb-px flex flex-wrap gap-px">';
                if (tc) html += `<span class="memo-badge task rounded-sm bg-black/40 px-0.5 text-[5px] leading-snug text-rose-300 sm:text-[6px]">${Icons.svg('pin')}${tc}</span>`;
                if (sc) html += `<span class="memo-badge schedule rounded-sm bg-black/40 px-0.5 text-[5px] leading-snug text-sky-300 sm:text-[6px]">${Icons.svg('calendar')}${sc}</span>`;
                html += '</div>';
            }

            // Googleカレンダーの予定チップ（休日行と同じ極小スタイル・スカイ系で区別）
            dayE.slice(0, GCAL_MAX_EVENTS_PER_CELL).forEach(ev => {
                html += `<div class="calendar-gcal-event flex items-center rounded-sm bg-sky-500/15 px-0.5 text-[6px] leading-tight text-sky-300 sm:text-[7px]"><span class="truncate">${Utils.escapeHtml(this._gcalEventLabel(ev))}</span></div>`;
            });
            if (dayE.length > GCAL_MAX_EVENTS_PER_CELL) {
                html += `<div class="calendar-more-events text-center text-[8px] text-sky-300/70">+${dayE.length - GCAL_MAX_EVENTS_PER_CELL}</div>`;
            }

            dayH.slice(0, 3).forEach(h => {
                const u = this.users.find(x => x.id === h.userId);
                if (u) html += `<div class="calendar-holiday-user flex items-center gap-0.5 rounded-sm bg-black/30 px-0.5 text-[6px] leading-tight sm:text-[7px]"><div class="calendar-holiday-dot h-1 w-1 shrink-0 rounded-full sm:h-[5px] sm:w-[5px]" style="background-color:${u.color}"></div><span class="calendar-holiday-name truncate">${Utils.escapeHtml(u.name)}</span></div>`;
            });
            if (dayH.length > 3) html += `<div class="calendar-more-users mt-px text-center text-[8px] text-zinc-400">+${dayH.length - 3}</div>`;
            html += '</div></div>';
        }

        const remain = CALENDAR_CELLS - (startDow + daysInMonth);
        for (let i = 1; i <= remain; i++) html += otherMonthCell(i);
        calEl.innerHTML = html;
    }

    // ==================== ドラッグ&ドロップ ====================

    handleDragStart(e, memoId) {
        this.draggedMemo = this.memos.find(m => m.id === memoId);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', memoId);
        e.target.classList.add('dragging');
    }

    handleDragEnd(e) {
        e.target.classList.remove('dragging');
        this.draggedMemo = null;
        document.querySelectorAll('.calendar-date-cell.drag-over').forEach(el => el.classList.remove('drag-over'));
    }

    handleDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const cell = e.target.closest('.calendar-date-cell');
        if (cell && !cell.classList.contains('other-month')) cell.classList.add('drag-over');
    }

    handleDragLeave(e) {
        const cell = e.target.closest('.calendar-date-cell');
        if (cell) cell.classList.remove('drag-over');
    }

    async handleDrop(e, newDate) {
        e.preventDefault();
        const cell = e.target.closest('.calendar-date-cell');
        if (cell) cell.classList.remove('drag-over');
        if (!this.draggedMemo || this.draggedMemo.date === newDate) return;

        try {
            await updateDoc(doc(db, 'calendarMemos', this.draggedMemo.id), { date: newDate, updatedAt: new Date().toISOString() });
            if (this.draggedMemo.gcalEventId && this.gcalConnected) {
                await this.updateGoogleCalendarEvent(this.draggedMemo.gcalEventId, { ...this.draggedMemo, date: newDate });
            }
            Utils.showToast(`メモを ${newDate.substring(5).replace('-', '/')} に移動しました`);
        } catch (err) {
            console.error('メモ移動エラー:', err);
            Utils.showToast('移動に失敗しました');
        }
        this.draggedMemo = null;
    }

    // ==================== メモ機能 ====================

    showMemoForm(dateStr = null, memoId = null) {
        this.selectedDateForMemo = dateStr;
        this.editingMemoId = memoId;
        const memo = memoId ? this.memos.find(m => m.id === memoId) : null;
        
        const formTitle = document.querySelector('#memoFormModal .modal-header h2');
        if (formTitle) formTitle.innerHTML = memo ? `${Icons.svg('pencil')} メモ編集` : `${Icons.svg('pencil')} メモ記入`;
        
        const deleteBtn = document.getElementById('memoDeleteBtn');
        if (deleteBtn) deleteBtn.style.display = memo ? 'block' : 'none';
        
        this.selectedMemoType = memo?.type || 'task';
        document.getElementById('memoDate').value = memo?.date || dateStr || Utils.getTodayString();
        document.getElementById('memoContent').value = memo?.content || '';
        document.getElementById('memoStartTime').value = memo?.startTime || '';
        document.getElementById('memoEndTime').value = memo?.endTime || '';
        document.getElementById('memoTaskTime').value = memo?.taskTime || '09:00';
        document.getElementById('memoNotification').checked = memo?.notification ?? true;
        
        Utils.setVisible('memoTimeSection', this.selectedMemoType === 'schedule');
        Utils.setVisible('memoTaskTimeSection', this.selectedMemoType === 'task');
        document.querySelectorAll('.memo-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === this.selectedMemoType));
        this.updateNotificationNote();
        Utils.showModal('memoFormModal');
    }

    showMemoFormForDate() { const d = this.selectedDateForMemo; this.closeDateDetail(); this.showMemoForm(d); }
    closeMemoForm() { Utils.closeModal('memoFormModal'); this.editingMemoId = null; }

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

    async saveMemo() {
        const date = document.getElementById('memoDate')?.value;
        const content = document.getElementById('memoContent')?.value.trim();
        const notification = document.getElementById('memoNotification')?.checked;
        if (!date) return Utils.showToast('日付を選択してください');
        if (!content) return Utils.showToast('内容を入力してください');

        const memoData = { type: this.selectedMemoType, date, content, notification, updatedAt: new Date().toISOString() };
        if (this.selectedMemoType === 'schedule') {
            memoData.startTime = document.getElementById('memoStartTime')?.value;
            memoData.endTime = document.getElementById('memoEndTime')?.value;
            if (!memoData.startTime) return Utils.showToast('開始時刻を入力してください');
        } else {
            memoData.taskTime = document.getElementById('memoTaskTime')?.value;
            if (notification && !memoData.taskTime) return Utils.showToast('通知時刻を入力してください');
        }

        try {
            if (this.editingMemoId) {
                const existingMemo = this.memos.find(m => m.id === this.editingMemoId);
                await updateDoc(doc(db, 'calendarMemos', this.editingMemoId), memoData);
                if (existingMemo?.gcalEventId && this.gcalConnected) {
                    await this.updateGoogleCalendarEvent(existingMemo.gcalEventId, memoData);
                    Utils.showToast('メモを更新しました（Googleカレンダーも更新）');
                } else {
                    Utils.showToast('メモを更新しました');
                }
            } else {
                memoData.createdAt = new Date().toISOString();
                if (notification && this.gcalConnected) {
                    const gcalId = await this.createGoogleCalendarEvent(memoData);
                    if (gcalId) { memoData.gcalEventId = gcalId; Utils.showToast('Googleカレンダーにも登録しました'); }
                }
                await addDoc(collection(db, 'calendarMemos'), memoData);
                if (!memoData.gcalEventId && notification) Utils.showToast('メモを保存しました（Googleカレンダー未連携）');
                else if (!notification) Utils.showToast('メモを保存しました');
            }
            this.closeMemoForm();
        } catch (e) { console.error('メモ保存エラー:', e); Utils.showToast('保存に失敗しました'); }
    }

    editMemo(memoId) { this.closeDateDetail(); this.showMemoForm(null, memoId); }
    editMemoFromList(memoId) { this.showMemoForm(null, memoId); }

    // ==================== メモ一覧（フィルター付き） ====================

    toggleMemoList() {
        this.memoListVisible = !this.memoListVisible;
        Utils.setVisible('memoListContainer', this.memoListVisible);
        if (this.memoListVisible) this.renderMemoList();
    }

    setMemoFilter(filter) {
        this.memoFilter = filter;
        document.querySelectorAll('.memo-filter-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === filter));
        this.renderMemoList();
    }

    renderMemoList() {
        const c = document.getElementById('memoList');
        if (!c) return;
        
        const monthStr = Utils.getMonthKey(this.currentYear, this.currentMonth);
        let memos = this.memos.filter(m => m.date?.startsWith(monthStr));
        if (this.memoFilter !== 'all') memos = memos.filter(m => m.type === this.memoFilter);
        memos = memos.sort((a,b) => a.date !== b.date ? a.date.localeCompare(b.date) : (a.type === 'task' ? -1 : 1));
        
        const filterBtnClass = 'memo-filter-btn flex-1 rounded-lg bg-white/10 px-3 py-2 text-xs font-semibold text-zinc-400 transition hover:bg-white/15';
        let html = `<div class="memo-filter-section mb-3 flex gap-2 rounded-xl bg-white/5 p-2 ring-1 ring-inset ring-white/5">
            <button class="${filterBtnClass}${this.memoFilter === 'all' ? ' active' : ''}" data-filter="all" onclick="app.holidayCalendar.setMemoFilter('all')">すべて</button>
            <button class="${filterBtnClass}${this.memoFilter === 'task' ? ' active' : ''}" data-filter="task" onclick="app.holidayCalendar.setMemoFilter('task')">${Icons.svg('pin')} タスク</button>
            <button class="${filterBtnClass}${this.memoFilter === 'schedule' ? ' active' : ''}" data-filter="schedule" onclick="app.holidayCalendar.setMemoFilter('schedule')">${Icons.svg('calendar')} 予定</button>
        </div>`;

        if (!memos.length) { c.innerHTML = html + '<div class="no-memos p-5 text-center text-sm text-zinc-500">この月のメモはありません</div>'; return; }

        let curDate = '';
        const todayStr = Utils.formatDateString(new Date());
        memos.forEach(m => {
            if (m.date !== curDate) {
                curDate = m.date;
                const isToday = m.date === todayStr;
                const headerClass = isToday
                    ? ' today rounded-md border-l-2 border-l-indigo-400 bg-indigo-500/15 pl-3'
                    : '';
                html += `<div class="memo-date-header mt-2.5 border-b border-white/10 pb-1 pt-2 text-sm font-bold text-indigo-300 first:mt-0${headerClass}">${isToday ? `${Icons.svg('pin')} 今日 - ` : ''}${m.date.substring(5).replace('-','/')} (${WEEKDAYS[new Date(m.date).getDay()]})</div>`;
            }
            const icon = m.type === 'task' ? Icons.svg('pin') : Icons.svg('calendar');
            const timeText = this._memoTimeText(m);
            const time = timeText ? `<span class="memo-time text-[11px] text-zinc-400">${timeText}</span>` : '';
            html += `<div class="memo-item ${m.type} mb-2 flex cursor-grab items-center justify-between gap-2 rounded-lg border-l-[3px] ${m.type === 'task' ? 'border-amber-400' : 'border-sky-400'} bg-white/5 p-3 ring-1 ring-inset ring-white/10" draggable="true" ondragstart="app.holidayCalendar.handleDragStart(event, '${m.id}')" ondragend="app.holidayCalendar.handleDragEnd(event)">
                <div class="memo-item-content group flex min-w-0 flex-1 cursor-pointer items-center gap-2" onclick="app.holidayCalendar.editMemoFromList('${m.id}')">
                    <span class="memo-icon shrink-0 text-sm">${icon}</span>
                    <div class="memo-details flex min-w-0 flex-col"><span class="memo-text truncate text-[13px] text-zinc-100">${Utils.escapeHtml(m.content)}</span>${time}</div>
                    ${m.gcalEventId ? `<span class="memo-gcal-icon ml-1 text-xs">${Icons.svg('calendar-days')}</span>` : ''}
                    <span class="memo-edit-hint ml-auto pl-2 text-xs opacity-0 transition group-hover:opacity-70">${Icons.svg('pencil')}</span>
                </div>
                <button class="memo-delete-btn shrink-0 p-1 text-sm opacity-60 transition hover:opacity-100" onclick="event.stopPropagation(); app.holidayCalendar.deleteMemo('${m.id}')">${Icons.svg('x')}</button>
            </div>`;
        });
        c.innerHTML = html;
    }

    /**
     * メモの時刻表示テキストを生成（予定は開始-終了、タスクは通知時刻）
     * @private
     * @param {Object} memo
     * @returns {string} 表示テキスト（時刻情報がなければ空文字）
     */
    _memoTimeText(memo) {
        if (memo.type === 'schedule' && memo.startTime) {
            return `${memo.startTime}${memo.endTime ? ' - ' + memo.endTime : ''}`;
        }
        return memo.taskTime ? `${Icons.svg('bell')} ${memo.taskTime}` : '';
    }

    async deleteMemo(memoId) {
        try {
            const memo = this.memos.find(m => m.id === memoId);
            if (memo?.gcalEventId && await this.deleteGoogleCalendarEvent(memo.gcalEventId)) Utils.showToast('Googleカレンダーからも削除しました');
            await deleteDoc(doc(db, 'calendarMemos', memoId));
            if (!memo?.gcalEventId) Utils.showToast('メモを削除しました');
        } catch (e) { console.error('メモ削除エラー:', e); Utils.showToast('削除に失敗しました'); }
    }

    async deleteMemoFromForm() {
        if (!this.editingMemoId) return;
        const confirmed = await Dialog.confirm('このメモを削除しますか？', { okLabel: '削除', danger: true });
        if (!confirmed) return;
        await this.deleteMemo(this.editingMemoId);
        this.closeMemoForm();
    }

    // ==================== 日付詳細モーダル ====================

    showDateDetail(dateStr) {
        this.selectedDateForMemo = dateStr;
        const d = new Date(dateStr);
        document.getElementById('dateDetailTitle').innerHTML = `${Icons.svg('calendar')} ${d.getMonth()+1}/${d.getDate()} (${WEEKDAYS[d.getDay()]})`;
        
        const sectionTitleClass = 'detail-section-title mb-2.5 border-b border-white/10 pb-2 text-sm font-bold text-indigo-300';
        const holidays = this.holidays.filter(h => h.date === dateStr);
        let hHtml = holidays.length ? `<div class="${sectionTitleClass}">${Icons.svg('sun')} 休日</div>` + holidays.map(h => {
            const u = this.users.find(x => x.id === h.userId);
            return u ? `<div class="detail-holiday-user mb-2 flex items-center gap-2.5 rounded-lg bg-white/5 p-2.5 text-sm text-zinc-100 ring-1 ring-inset ring-white/10"><div class="user-color-dot h-3 w-3 shrink-0 rounded-full" style="background-color:${u.color}"></div><span>${Utils.escapeHtml(u.name)}</span></div>` : '';
        }).join('') : '';

        // Googleカレンダーの予定（メモ由来は_buildGcalEventMapで除外済み）
        const dayEvents = this._buildGcalEventMap()[dateStr] || [];
        let eHtml = '';
        if (dayEvents.length) {
            eHtml = `<div class="${sectionTitleClass}">${Icons.svg('calendar-days')} 予定（Googleカレンダー）</div>` + dayEvents.map(ev => {
                const location = ev.location
                    ? `<div class="detail-gcal-location ml-6 mt-0.5 text-xs text-zinc-500">${Icons.svg('pin')} ${Utils.escapeHtml(ev.location)}</div>`
                    : '';
                return `<div class="detail-gcal-event mb-2 rounded-lg border-l-[3px] border-sky-400 bg-white/5 p-3 ring-1 ring-inset ring-white/10">
                    <div class="flex items-center gap-2">
                        <span class="shrink-0 text-xs font-semibold text-sky-300">${Utils.escapeHtml(this._gcalEventTimeRange(ev))}</span>
                        <span class="break-words text-sm text-zinc-100">${Utils.escapeHtml(ev.title)}</span>
                    </div>${location}
                </div>`;
            }).join('');
        }
        document.getElementById('dateDetailHolidays').innerHTML = hHtml + eHtml;

        const memos = this.memos.filter(m => m.date === dateStr).sort((a,b) => a.type === 'task' ? -1 : 1);
        let mHtml = memos.length ? `<div class="${sectionTitleClass}">${Icons.svg('file-text')} メモ</div>` : '<div class="no-memos p-5 text-center text-sm text-zinc-500">メモはありません</div>';
        memos.forEach(m => {
            const icon = m.type === 'task' ? Icons.svg('pin') : Icons.svg('calendar');
            const timeText = this._memoTimeText(m);
            const time = timeText ? `<div class="detail-memo-time ml-6 mt-1 text-xs text-zinc-400">${timeText}</div>` : '';
            mHtml += `<div class="detail-memo-item ${m.type} relative mb-2 flex cursor-grab flex-col rounded-lg border-l-[3px] ${m.type === 'task' ? 'border-amber-400' : 'border-sky-400'} bg-white/5 p-3 ring-1 ring-inset ring-white/10" draggable="true" ondragstart="app.holidayCalendar.handleDragStart(event, '${m.id}')" ondragend="app.holidayCalendar.handleDragEnd(event)">
                <div class="detail-memo-main group flex flex-1 cursor-pointer items-center gap-2 pr-7" onclick="app.holidayCalendar.editMemo('${m.id}')">
                    <span class="memo-icon shrink-0 text-sm">${icon}</span>
                    <span class="detail-memo-content break-words text-sm text-zinc-100">${Utils.escapeHtml(m.content)}${m.gcalEventId ? ` ${Icons.svg('calendar-days')}` : ''}</span>
                    <span class="memo-edit-hint ml-auto pl-2 text-xs opacity-0 transition group-hover:opacity-70">${Icons.svg('pencil')}</span>
                </div>${time}
                <button class="memo-delete-btn small absolute right-2 top-2 p-0.5 text-xs opacity-60 transition hover:opacity-100" onclick="event.stopPropagation(); app.holidayCalendar.deleteMemoFromDetail('${m.id}')">${Icons.svg('x')}</button>
            </div>`;
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
            ? '<p class="py-4 text-center text-sm text-zinc-500">ユーザーが登録されていません</p>'
            : this.users.map(u => `<div class="user-item flex cursor-pointer items-center gap-2.5 rounded-xl bg-white/5 p-3.5 text-sm font-semibold text-zinc-100 ring-1 ring-inset ring-white/10 transition hover:bg-white/10" onclick="app.holidayCalendar.editUser('${u.id}')"><div class="user-color-dot h-3 w-3 shrink-0 rounded-full" style="background-color:${u.color}"></div><span>${Utils.escapeHtml(u.name)}</span></div>`).join('');
    }

    showUserForm(userId = null) {
        this.editingUserId = userId;
        const user = userId ? this.users.find(u => u.id === userId) : null;
        document.getElementById('userFormTitle').innerHTML = userId ? `${Icons.svg('pencil')} ユーザー編集` : `${Icons.svg('user-plus')} ユーザー新規登録`;
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
            let cls = 'color-option flex aspect-square items-center justify-center rounded-xl text-xl transition';
            cls += used ? ' disabled cursor-not-allowed opacity-30' : ' cursor-pointer hover:scale-105';
            if (sel) cls += ' selected ring-2 ring-white shadow-[0_0_20px_rgba(255,255,255,0.4)]';
            return `<div class="${cls}" style="background-color:${c.value}" onclick="app.holidayCalendar.selectColor('${c.value}',${used})">${sel ? '✓' : c.emoji}</div>`;
        }).join('');
    }

    selectColor(val, used) { if (!used) { this.selectedColor = val; this.renderColorPalette(); } }

    async saveUser() {
        const name = document.getElementById('userName')?.value.trim();
        if (!name) return Utils.showToast('名前を入力してください');
        if (!this.selectedColor) return Utils.showToast('色を選択してください');
        try {
            if (this.editingUserId) {
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
        if (!this.editingUserId) return;
        const confirmed = await Dialog.confirm('このユーザーを削除しますか？', { okLabel: '削除', danger: true });
        if (!confirmed) return;
        try {
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
            ? '<p class="py-4 text-center text-sm text-zinc-500">先にユーザーを登録してください</p>'
            : this.users.map(u => `<button class="holiday-user-btn flex w-full items-center gap-2.5 rounded-xl bg-white/5 p-3.5 text-sm font-bold text-zinc-100 ring-1 ring-inset ring-white/10 transition hover:bg-white/10" onclick="app.holidayCalendar.selectHolidayUser('${u.id}')" style="border-left:4px solid ${u.color}"><span class="user-emoji">${Icons.svg('user')}</span> ${Utils.escapeHtml(u.name)}</button>`).join('');
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
        // 重複データが残っていても選択状態は1日1件として扱う
        this.tempHolidays = [...new Set(this.holidays.filter(h => h.userId === this.selectedUser.id).map(h => h.date))];
        document.getElementById('holidayEditTitle').innerHTML = `${Icons.svg('calendar-days')} ${Utils.escapeHtml(this.selectedUser.name)}さんの休日編集`;
        this.renderEditCalendar();
        Utils.showModal('holidayEditModal');
    }

    renderEditCalendar() {
        document.getElementById('editCalendarMonth').textContent = `${this.editYear}年${this.editMonth}月`;
        const daysInMonth = new Date(this.editYear, this.editMonth, 0).getDate();
        const startDow = new Date(this.editYear, this.editMonth - 1, 1).getDay();
        const jpHolidays = getJapaneseHolidays(this.editYear);

        let html = WEEKDAYS.map((d, i) => {
            const color = i === 0 ? 'text-rose-400' : i === 6 ? 'text-sky-400' : 'text-zinc-500';
            return `<div class="edit-calendar-weekday p-1.5 text-center text-[11px] font-bold ${color} sm:text-xs">${d}</div>`;
        }).join('');
        for (let i = 0; i < startDow; i++) html += '<div class="edit-calendar-cell empty"></div>';

        const cellBase = 'edit-calendar-cell relative flex aspect-square min-h-[35px] cursor-pointer items-center justify-center rounded-md p-0.5 text-xs font-bold transition sm:min-h-[40px] sm:text-[13px]';
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = toDateStr(this.editYear, this.editMonth, day);
            const dow = new Date(this.editYear, this.editMonth - 1, day).getDay();
            const holidayName = jpHolidays[dateStr];
            const sel = this.tempHolidays.includes(dateStr);
            let cls;
            if (sel) {
                cls = `${cellBase} selected bg-indigo-500 text-white shadow-lg shadow-indigo-500/30`;
            } else {
                const textColor = (dow === 0 || holidayName) ? 'text-rose-300' : dow === 6 ? 'text-sky-300' : 'text-zinc-100';
                cls = `${cellBase} bg-white/5 ${textColor} hover:scale-105 hover:bg-white/15`;
            }
            const title = holidayName ? ` title="${holidayName}"` : '';
            const dot = holidayName ? '<span class="absolute right-1 top-1 h-1 w-1 rounded-full bg-rose-400"></span>' : '';
            html += `<div class="${cls}"${title} onclick="app.holidayCalendar.toggleHoliday('${dateStr}')">${dot}${day}</div>`;
        }
        document.getElementById('editCalendar').innerHTML = html;
    }

    toggleHoliday(dateStr) {
        const idx = this.tempHolidays.indexOf(dateStr);
        if (idx > -1) this.tempHolidays.splice(idx, 1);
        else this.tempHolidays.push(dateStr);
        this.renderEditCalendar();
    }

    // 表示中の月の土日・祝日をまとめて選択／解除する
    toggleWeekendHolidays() {
        const daysInMonth = new Date(this.editYear, this.editMonth, 0).getDate();
        const jpHolidays = getJapaneseHolidays(this.editYear);
        const targets = [];
        for (let day = 1; day <= daysInMonth; day++) {
            const dow = new Date(this.editYear, this.editMonth - 1, day).getDay();
            const dateStr = toDateStr(this.editYear, this.editMonth, day);
            if (dow === 0 || dow === 6 || jpHolidays[dateStr]) targets.push(dateStr);
        }
        if (!targets.length) return;

        const allSelected = targets.every(d => this.tempHolidays.includes(d));
        if (allSelected) {
            this.tempHolidays = this.tempHolidays.filter(d => !targets.includes(d));
            Utils.showToast(`土日祝の選択を解除しました（${targets.length}日）`);
        } else {
            targets.forEach(d => { if (!this.tempHolidays.includes(d)) this.tempHolidays.push(d); });
            Utils.showToast(`土日祝を休日に設定しました（${targets.length}日）`);
        }
        this.renderEditCalendar();
    }

    /**
     * 休日ドキュメントの固定ID（ユーザー×日付で一意）
     * ランダムIDのaddDocだと同じ日付が何度でも追加できてしまうため、
     * 「1ユーザー1日1件」をID自体で保証する。
     */
    _holidayDocId(userId, date) { return `${userId}_${date}`; }

    async saveHolidays() {
        if (!this.selectedUser) return;
        // 保存中の再入を防ぐ（保存ボタンの連打で二重登録されないように）
        if (this._savingHolidays) return;
        this._savingHolidays = true;
        const saveBtn = document.getElementById('holidaySaveBtn');
        if (saveBtn) saveBtn.disabled = true;

        try {
            const userId = this.selectedUser.id;
            const snap = await getDocs(query(collection(db, 'holidays'), where('userId', '==', userId)));
            const desired = [...new Set(this.tempHolidays)];
            const desiredSet = new Set(desired);

            // 既存ドキュメントのcreatedAtを引き継ぐ（保存のたびに作成日時が変わらないように）
            const createdAtByDate = {};
            snap.docs.forEach(d => {
                const { date, createdAt } = d.data();
                if (date && createdAt && !createdAtByDate[date]) createdAtByDate[date] = createdAt;
            });

            // 解除された日付と、旧ランダムID（＝重複の原因）のドキュメントを削除する。
            // 固定IDのドキュメントはこのあとsetDocで上書きするため残す。
            const deletions = snap.docs
                .filter(d => {
                    const { date } = d.data();
                    return !desiredSet.has(date) || d.id !== this._holidayDocId(userId, date);
                })
                .map(d => deleteDoc(d.ref));

            // 固定IDで書き込むため、同じ保存を何度実行しても件数は増えない（冪等）
            const now = new Date().toISOString();
            const writes = desired.map(date => setDoc(
                doc(db, 'holidays', this._holidayDocId(userId, date)),
                { userId, date, createdAt: createdAtByDate[date] || now }
            ));

            await Promise.all([...deletions, ...writes]);
            Utils.showToast('休日を保存しました');
            Utils.closeModal('holidayEditModal');
        } catch (e) {
            console.error('休日保存エラー:', e);
            Utils.showToast('保存に失敗しました', 'error');
        } finally {
            this._savingHolidays = false;
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    cancelHolidayEdit() { Utils.closeModal('holidayEditModal'); }
}
