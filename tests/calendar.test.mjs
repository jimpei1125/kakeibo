// calendar.js の予定表示ロジックのテスト（DOM/localStorage/fetchをスタブ化）
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

// ---- DOMスタブ（IDごとに同一要素を返し、innerHTMLを検査できるようにする） ----
const elements = new Map();
function makeEl(id) {
    return {
        id, value: '', textContent: '', innerHTML: '', checked: false, disabled: false,
        style: {}, dataset: {},
        classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
        querySelectorAll: () => [], querySelector: () => null, closest: () => null,
        appendChild(){}, addEventListener(){}, insertBefore(){},
    };
}
globalThis.document = {
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeEl(id));
        return elements.get(id);
    },
    querySelectorAll: () => [], querySelector: () => null,
    createElement: (t) => makeEl(t), head: makeEl('head'), body: makeEl('body'),
};
globalThis.window = globalThis;
const lsStore = {};
globalThis.localStorage = {
    getItem: (k) => (k in lsStore ? lsStore[k] : null),
    setItem: (k, v) => { lsStore[k] = String(v); },
    removeItem: (k) => { delete lsStore[k]; },
};
const fetchCalls = [];
let fetchResponse = { events: [], fetchedAt: null };
globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    return { status: 200, json: async () => fetchResponse };
};

const { HolidayCalendar } = await import('../js/calendar.js');

const cal = new HolidayCalendar();
cal.currentYear = 2026;
cal.currentMonth = 8;

console.log('【1】_gcalEventDates（日付マッピング）');
{
    check('終日1日', JSON.stringify(cal._gcalEventDates({ allDay: true, start: '2026-08-20', end: '2026-08-21' })) === '["2026-08-20"]');
    check('終日3日間（endは排他的）',
        JSON.stringify(cal._gcalEventDates({ allDay: true, start: '2026-08-20', end: '2026-08-23' })) === '["2026-08-20","2026-08-21","2026-08-22"]');
    check('月またぎの終日',
        JSON.stringify(cal._gcalEventDates({ allDay: true, start: '2026-08-31', end: '2026-09-02' })) === '["2026-08-31","2026-09-01"]');
    check('時刻あり（JSTオフセット付き）',
        JSON.stringify(cal._gcalEventDates({ allDay: false, start: '2026-08-20T10:00:00+09:00', end: '2026-08-20T11:00:00+09:00' })) === '["2026-08-20"]');
    check('時刻あり（UTC表記→JSTで翌日になるケース）',
        JSON.stringify(cal._gcalEventDates({ allDay: false, start: '2026-08-20T15:30:00Z', end: '2026-08-20T16:30:00Z' })) === '["2026-08-21"]');
    check('深夜23:30はその日のまま',
        JSON.stringify(cal._gcalEventDates({ allDay: false, start: '2026-08-20T23:30:00+09:00', end: '2026-08-21T00:30:00+09:00' })) === '["2026-08-20"]');
    check('不正なstartは空配列', cal._gcalEventDates({ allDay: false, start: 'garbage', end: '' }).length === 0);
}

console.log('\n【2】ラベル・時刻表示');
{
    check('時刻ありラベル "10:00 タイトル"',
        cal._gcalEventLabel({ allDay: false, start: '2026-08-20T10:00:00+09:00', title: '歯医者' }) === '10:00 歯医者');
    check('終日ラベルはタイトルのみ',
        cal._gcalEventLabel({ allDay: true, start: '2026-08-20', title: '旅行' }) === '旅行');
    check('詳細の時刻範囲 "10:00 - 11:30"',
        cal._gcalEventTimeRange({ allDay: false, start: '2026-08-20T10:00:00+09:00', end: '2026-08-20T11:30:00+09:00' }) === '10:00 - 11:30');
    check('終日の詳細は「終日」',
        cal._gcalEventTimeRange({ allDay: true, start: '2026-08-20', end: '2026-08-21' }) === '終日');
    check('UTC表記もJSTに変換される',
        cal._jstTimeHHMM('2026-08-20T01:00:00Z') === '10:00');
}

console.log('\n【3】_buildGcalEventMap（メモ由来の除外）');
{
    cal.memos = [
        { id: 'm1', gcalEventId: 'memo-ev-1' },
        { id: 'm2', gcalEventId: 'recur-base' },
    ];
    cal.gcalEvents = [
        { id: 'plain-1', title: '通常予定', start: '2026-08-20T10:00:00+09:00', end: '2026-08-20T11:00:00+09:00', allDay: false, location: '' },
        { id: 'memo-ev-1', title: 'メモ由来', start: '2026-08-20T09:00:00+09:00', end: '2026-08-20T10:00:00+09:00', allDay: false, location: '' },
        { id: 'recur-base_20260821T010000Z', title: '繰り返し（メモ由来）', start: '2026-08-21T10:00:00+09:00', end: '2026-08-21T11:00:00+09:00', allDay: false, location: '' },
        { id: 'trip', title: '旅行', start: '2026-08-20', end: '2026-08-22', allDay: true, location: '' },
    ];
    const map = cal._buildGcalEventMap();
    check('通常予定と終日予定は表示対象', map['2026-08-20']?.length === 2, `got ${map['2026-08-20']?.length}`);
    check('メモ由来（ID一致）は除外', !map['2026-08-20']?.some(e => e.id === 'memo-ev-1'));
    check('繰り返しインスタンス（元ID一致）も除外', !map['2026-08-21'] || !map['2026-08-21'].some(e => e.id.startsWith('recur-base')));
    check('終日予定は2日目にも展開', map['2026-08-21']?.some(e => e.id === 'trip'));
    check('3日目（end排他）には出ない', !map['2026-08-22']);
}

console.log('\n【4】renderCalendar（マス表示）');
{
    cal.users = []; cal.holidays = [];
    cal.renderCalendar();
    const html = elements.get('holidayCalendar').innerHTML;
    check('予定チップが描画される', html.includes('calendar-gcal-event'));
    check('時刻つきラベル', html.includes('10:00 通常予定'));
    check('終日タイトル', html.includes('旅行'));
    check('メモ由来は描画されない', !html.includes('メモ由来'));

    // 3件以上 → +n
    cal.gcalEvents = [1,2,3,4].map(i => ({
        id: `e${i}`, title: `予定${i}`, start: `2026-08-25T1${i}:00:00+09:00`, end: `2026-08-25T1${i}:30:00+09:00`, allDay: false, location: '',
    }));
    cal.memos = [];
    cal.renderCalendar();
    const html2 = elements.get('holidayCalendar').innerHTML;
    check('個別表示は2件まで', html2.includes('予定1') && html2.includes('予定2') && !html2.includes('予定3'));
    check('超過分は+n表示', html2.includes('+2'));
}

console.log('\n【5】showDateDetail（詳細モーダル）');
{
    cal.gcalEvents = [
        { id: 'x', title: '歯医者', start: '2026-08-20T10:00:00+09:00', end: '2026-08-20T11:00:00+09:00', allDay: false, location: '渋谷デンタル' },
    ];
    cal.showDateDetail('2026-08-20');
    const html = elements.get('dateDetailHolidays').innerHTML;
    check('予定セクションが出る', html.includes('予定（Googleカレンダー）'));
    check('時刻範囲とタイトル', html.includes('10:00 - 11:00') && html.includes('歯医者'));
    check('場所も表示される', html.includes('渋谷デンタル'));

    cal.gcalEvents = [];
    cal.showDateDetail('2026-08-20');
    check('予定なしの日はセクション自体が出ない', !elements.get('dateDetailHolidays').innerHTML.includes('予定（Googleカレンダー）'));
}

console.log('\n【6】Worker連携（アプリ側）');
{
    cal.gcalAppKey = 'k';
    fetchResponse = { events: [{ id: 'n1', title: '新規', start: '2026-08-20T10:00:00+09:00', end: '2026-08-20T10:30:00+09:00', allDay: false, location: '' }], fetchedAt: 'now' };
    await cal.loadGcalEvents();
    check('GET /events で取得', fetchCalls.at(-1).url.endsWith('/events') && cal.gcalEvents.length === 1);
    check('X-App-Keyヘッダ付与', fetchCalls.at(-1).options.headers['X-App-Key'] === 'k');
    check('localStorageにキャッシュ', JSON.parse(lsStore['gcal_events_cache']).length === 1);

    await cal.loadGcalEvents(true);
    check('force時は POST /sync', fetchCalls.at(-1).url.endsWith('/sync') && fetchCalls.at(-1).options.method === 'POST');

    // メモ書き込みがWorker経由になっている
    cal.gcalConnected = true;
    fetchResponse = { id: 'new-ev' };
    const id = await cal.createGoogleCalendarEvent({ type: 'schedule', content: 'テスト', date: '2026-08-20', startTime: '10:00', endTime: '11:00' });
    check('メモ作成 → Worker /gcal/events', id === 'new-ev' && fetchCalls.at(-1).url.includes('/gcal/events'));
    check('Google APIを直接叩いていない', !fetchCalls.some(c => c.url.includes('googleapis.com')));

    fetchResponse = { ok: true };
    const deleted = await cal.deleteGoogleCalendarEvent('abc');
    check('メモ削除 → Worker DELETE', deleted === true && fetchCalls.at(-1).options.method === 'DELETE');

    // 未設定時は何もしない
    cal.gcalAppKey = '';
    const before = fetchCalls.length;
    await cal.loadGcalEvents();
    check('アプリキー未設定なら通信しない', fetchCalls.length === before);
}

console.log('\n【7】バグ修正の検証');
{
    // (a) 日付詳細モーダルのタイトル曜日がタイムゾーンに依存しない
    //     2026-08-20は木曜。旧実装(new Date('YYYY-MM-DD'))は負オフセットTZで前日(水)にずれていた
    cal.gcalEvents = [];
    cal.memos = [];
    cal.showDateDetail('2026-08-20');
    const title = elements.get('dateDetailTitle').innerHTML;
    check(`詳細タイトルの曜日が(木) [TZ=${process.env.TZ || 'system'}]`, title.includes('8/20') && title.includes('(木)'), `got: ${title}`);

    // (b) メモ一覧の曜日も同様
    cal.memos = [{ id: 'w1', type: 'task', date: '2026-08-20', content: '曜日テスト', taskTime: '09:00' }];
    cal.memoListVisible = true;
    cal.renderMemoList();
    const list = elements.get('memoList').innerHTML;
    check('メモ一覧の日付ヘッダーが(木)', list.includes('08/20') && list.includes('(木)'), `got header part`);
    cal.memos = []; cal.memoListVisible = false;

    // (c) 誤ったアプリキー → トースト表示＋キーをクリアして入力欄を再表示できる状態に戻す
    lsStore['gcal_app_key'] = 'wrong-key';
    cal.gcalAppKey = 'wrong-key';
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ status: 401, json: async () => ({ error: 'unauthorized' }) });
    const toasts = [];
    const toastEl = document.getElementById('toast'); // Utils.showToastが参照（要素を生成させる）
    Object.defineProperty(toastEl, 'textContent', {
        get() { return this._tc || ''; },
        set(v) { this._tc = v; toasts.push(v); },
        configurable: true,
    });
    cal.initGcalSync();
    await new Promise(r => setTimeout(r, 10)); // catchチェーンの完了を待つ
    check('401でアプリキーがクリアされる', cal.gcalAppKey === '' && !('gcal_app_key' in lsStore));
    check('エラートーストが表示される', toasts.some(t => t.includes('アプリキーが正しくありません')));
    globalThis.fetch = origFetch;

    // (d) ネットワーク障害(401以外)ではキーを保持する
    lsStore['gcal_app_key'] = 'valid-key';
    cal.gcalAppKey = 'valid-key';
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    cal.initGcalSync();
    await new Promise(r => setTimeout(r, 10));
    check('一時的な障害ではキーを保持', cal.gcalAppKey === 'valid-key' && lsStore['gcal_app_key'] === 'valid-key');
    globalThis.fetch = origFetch;
}

console.log('\n【8】showToastのタイマー競合修正');
{
    const { Utils } = await import('../js/utils.js');
    // classListの操作を記録できるトースト要素を用意
    const log = [];
    const toastEl = document.getElementById('toast');
    toastEl.classList = {
        add: (c) => log.push(`add:${c}`),
        remove: (c) => log.push(`remove:${c}`),
        toggle: () => {},
        contains: () => false,
    };
    // setTimeout/clearTimeoutを同期的に検査できるよう差し替え
    const timers = new Map();
    let timerId = 0;
    const origSet = globalThis.setTimeout, origClear = globalThis.clearTimeout;
    globalThis.setTimeout = (fn) => { timers.set(++timerId, fn); return timerId; };
    globalThis.clearTimeout = (id) => { timers.delete(id); };

    Utils.showToast('1つ目');
    Utils.showToast('2つ目'); // 旧実装だと1つ目のタイマーが残り、2つ目を早期に消していた
    check('古いタイマーはキャンセルされ、残タイマーは1本だけ', timers.size === 1, `got ${timers.size}`);
    for (const fn of timers.values()) fn();
    check('発火するremoveは1回だけ', log.filter(l => l === 'remove:show').length === 1);

    globalThis.setTimeout = origSet;
    globalThis.clearTimeout = origClear;
}

console.log('\n【9】メモ削除: Googleカレンダー側の削除失敗時に孤児化させない');
{
    const { deleteLog } = await import('./stubs/firebase-config.mjs');
    const { Dialog } = await import('../js/dialog.js');
    const origFetch = globalThis.fetch;
    cal.gcalAppKey = 'k';
    cal.memos = [
        { id: 'm-gcal', gcalEventId: 'ev1', type: 'schedule', date: '2026-09-10', content: 'GCal連携メモ' },
        { id: 'm-plain', type: 'task', date: '2026-09-10', content: '通常メモ' },
    ];

    // (a) 連携中・Worker側の削除が失敗 → メモは削除しない
    cal.gcalConnected = true;
    globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: false }) });
    deleteLog.length = 0;
    const r1 = await cal.deleteMemo('m-gcal');
    check('GCal削除失敗時はfalseを返す', r1 === false);
    check('GCal削除失敗時はFirestoreのメモを削除しない', deleteLog.length === 0);

    // (b) 連携中・Worker側の削除が成功 → メモも削除
    globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true }) });
    const r2 = await cal.deleteMemo('m-gcal');
    check('GCal削除成功時はメモも削除される', r2 === true && deleteLog.includes('calendarMemos/m-gcal'));

    // (c) 未連携でGCal連携メモ → 確認ダイアログ。キャンセルなら削除しない
    cal.gcalConnected = false;
    const origConfirm = Dialog.confirm;
    let asked = 0;
    Dialog.confirm = async () => { asked++; return false; };
    deleteLog.length = 0;
    const r3 = await cal.deleteMemo('m-gcal');
    check('未連携時は確認ダイアログが出る', asked === 1);
    check('キャンセルなら削除しない', r3 === false && deleteLog.length === 0);
    Dialog.confirm = async () => { asked++; return true; };
    const r4 = await cal.deleteMemo('m-gcal');
    check('「メモだけ削除」を選べば削除される', r4 === true && deleteLog.includes('calendarMemos/m-gcal'));
    Dialog.confirm = origConfirm;

    // (d) GCal連携のないメモは従来どおり即削除
    deleteLog.length = 0;
    const r5 = await cal.deleteMemo('m-plain');
    check('通常メモは確認なしで削除', r5 === true && deleteLog.includes('calendarMemos/m-plain'));

    globalThis.fetch = origFetch;
}

console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
process.exit(fail === 0 ? 0 : 1);
