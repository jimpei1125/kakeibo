// gcal-sync Worker の単体テスト（KV・fetchをスタブ化）
import worker from '../worker/gcal-sync/worker.js';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

// ---- KVスタブ ----
function makeKV() {
    const store = new Map();
    return {
        store,
        async get(k) { return store.has(k) ? store.get(k) : null; },
        async put(k, v) { store.set(k, v); },
        async delete(k) { store.delete(k); },
    };
}

// ---- fetchスタブ（呼び出し記録つき） ----
const fetchLog = [];
let fetchHandlers = [];
globalThis.fetch = async (url, options = {}) => {
    fetchLog.push({ url: String(url), options });
    for (const [pattern, handler] of fetchHandlers) {
        if (String(url).includes(pattern)) return handler(String(url), options);
    }
    throw new Error(`unstubbed fetch: ${url}`);
};
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status });

function makeEnv() {
    return { GCAL_KV: makeKV(), GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', APP_KEY: 'secret-key' };
}
const BASE = 'https://gcal-sync.example.workers.dev';
const req = (path, method = 'GET', headers = {}, body = null) =>
    new Request(`${BASE}${path}`, { method, headers, body });
const KEYED = { 'X-App-Key': 'secret-key' };

console.log('【1】認可ガード');
{
    const env = makeEnv();
    const r1 = await worker.fetch(req('/events'), env);
    check('キーなし /events → 401', r1.status === 401);
    const r2 = await worker.fetch(req('/events', 'GET', { 'X-App-Key': 'wrong' }), env);
    check('誤ったキー → 401', r2.status === 401);
    const r3 = await worker.fetch(req('/oauth/start?key=wrong'), env);
    check('oauth/start 誤ったキー → 401', r3.status === 401);
    const r4 = await worker.fetch(new Request(`${BASE}/events`, { method: 'OPTIONS' }), env);
    check('OPTIONS → 204', r4.status === 204);
    const r5 = await worker.fetch(req('/nonexistent', 'GET', KEYED), env);
    check('未知のパス → 404', r5.status === 404);
}

console.log('\n【2】OAuthフロー');
{
    const env = makeEnv();
    const r1 = await worker.fetch(req('/oauth/start?key=secret-key'), env);
    check('start → 302リダイレクト', r1.status === 302);
    const loc = r1.headers.get('Location');
    check('Google認可URLへ（offline+consent+scope）',
        loc.includes('accounts.google.com') && loc.includes('access_type=offline')
        && loc.includes('prompt=consent') && loc.includes('calendar.events'));
    const state = await env.GCAL_KV.get('oauth_state');
    check('stateがKVに保存される', !!state && loc.includes(`state=${state}`));

    // 不正state
    const bad = await worker.fetch(req(`/oauth/callback?code=c&state=WRONG`), env);
    check('state不一致 → 400', bad.status === 400);

    // 正常系: code交換 + 初回同期
    await env.GCAL_KV.put('oauth_state', state); // badで消えたので再設定
    fetchHandlers = [
        ['oauth2.googleapis.com/token', () => jsonRes({ refresh_token: 'RT', access_token: 'AT', expires_in: 3600 })],
        ['www.googleapis.com/calendar', () => jsonRes({ items: [
            { id: 'ev1', summary: '歯医者', start: { dateTime: '2026-08-20T10:00:00+09:00' }, end: { dateTime: '2026-08-20T11:00:00+09:00' } },
        ] })],
    ];
    const ok = await worker.fetch(req(`/oauth/callback?code=c&state=${state}`), env);
    check('callback → 200 HTML', ok.status === 200 && (await ok.text()).includes('連携しました'));
    const tokens = JSON.parse(await env.GCAL_KV.get('tokens'));
    check('refresh_tokenが保存される', tokens.refresh_token === 'RT');
    const cached = JSON.parse(await env.GCAL_KV.get('events'));
    check('初回同期が実行される', cached.events.length === 1 && cached.events[0].title === '歯医者');
    check('stateは使い捨て', await env.GCAL_KV.get('oauth_state') === null);

    // status / events
    const st = await (await worker.fetch(req('/status', 'GET', KEYED), env)).json();
    check('status → linked:true', st.linked === true && !!st.fetchedAt);
    const ev = await (await worker.fetch(req('/events', 'GET', KEYED), env)).json();
    check('events → キャッシュ返却', ev.events.length === 1);

    // refresh_tokenが返らないケース
    await env.GCAL_KV.put('oauth_state', 'S2');
    fetchHandlers.unshift(['oauth2.googleapis.com/token', () => jsonRes({ access_token: 'AT2', expires_in: 3600 })]);
    const noRt = await worker.fetch(req('/oauth/callback?code=c&state=S2'), env);
    check('refresh_tokenなし → 400', noRt.status === 400);
}

console.log('\n【3】トークン自動更新と同期の正規化');
{
    const env = makeEnv();
    // 期限切れトークンを仕込む
    await env.GCAL_KV.put('tokens', JSON.stringify({ refresh_token: 'RT', access_token: 'OLD', expires_at: Date.now() - 1000 }));
    let refreshCalled = 0;
    let usedToken = null;
    fetchHandlers = [
        ['oauth2.googleapis.com/token', (url, opts) => {
            refreshCalled++;
            const params = new URLSearchParams(String(opts.body));
            check('grant_type=refresh_token で更新', params.get('grant_type') === 'refresh_token' && params.get('refresh_token') === 'RT');
            return jsonRes({ access_token: 'NEW', expires_in: 3600 });
        }],
        ['www.googleapis.com/calendar', (url, opts) => {
            usedToken = opts.headers.Authorization;
            const u = new URL(url);
            if (!u.searchParams.get('pageToken')) {
                return jsonRes({ items: [
                    { id: 'a', summary: '終日イベント', start: { date: '2026-08-20' }, end: { date: '2026-08-21' } },
                    { id: 'b', status: 'cancelled', summary: 'キャンセル済み', start: { date: '2026-08-20' }, end: { date: '2026-08-21' } },
                    { id: 'c', start: { dateTime: '2026-08-21T09:00:00+09:00' }, end: { dateTime: '2026-08-21T10:00:00+09:00' }, location: '渋谷' },
                ], nextPageToken: 'P2' });
            }
            return jsonRes({ items: [
                { id: 'd', summary: '2ページ目', start: { dateTime: '2026-08-22T09:00:00+09:00' }, end: { dateTime: '2026-08-22T10:00:00+09:00' } },
            ] });
        }],
    ];
    const res = await worker.fetch(req('/sync', 'POST', KEYED), env);
    const data = await res.json();
    check('期限切れ→自動refresh実行', refreshCalled === 1);
    check('新トークンでAPIを叩く', usedToken === 'Bearer NEW');
    check('キャンセル済みを除外・2ページを結合（3件）', data.events.length === 3, `got ${data.events.length}`);
    const byId = Object.fromEntries(data.events.map(e => [e.id, e]));
    check('終日イベントの正規化', byId.a.allDay === true && byId.a.start === '2026-08-20' && byId.a.end === '2026-08-21');
    check('無題はプレースホルダ', byId.c.title === '（無題）' && byId.c.location === '渋谷');
    check('時刻ありはallDay=false', byId.c.allDay === false);
    const updated = JSON.parse(await env.GCAL_KV.get('tokens'));
    check('更新後トークンがKVに保存される', updated.access_token === 'NEW');

    // 60秒連打ガード
    let syncCount = 0;
    fetchHandlers = [
        ['oauth2.googleapis.com/token', () => jsonRes({ access_token: 'NEW', expires_in: 3600 })],
        ['www.googleapis.com/calendar', () => { syncCount++; return jsonRes({ items: [] }); }],
    ];
    await worker.fetch(req('/sync', 'POST', KEYED), env);
    check('60秒以内の再syncはGCalを叩かない', syncCount === 0);
}

console.log('\n【4】書き込み代理（proxyGcal）');
{
    const env = makeEnv();
    await env.GCAL_KV.put('tokens', JSON.stringify({ refresh_token: 'RT', access_token: 'AT', expires_at: Date.now() + 3600000 }));
    let captured = null;
    fetchHandlers = [
        ['www.googleapis.com/calendar', (url, opts) => {
            captured = { url, method: opts.method, body: opts.body };
            if (opts.method === 'DELETE') return new Response(null, { status: 404 });
            if (opts.method === 'GET' || !opts.method) return jsonRes({ items: [] }); // 書き込み後の再同期
            return jsonRes({ id: 'created-id' });
        }],
    ];
    const create = await (await worker.fetch(req('/gcal/events', 'POST', KEYED, JSON.stringify({ summary: 'x' })), env)).json();
    check('POST → idが返る', create.id === 'created-id');

    const upd = await (await worker.fetch(req('/gcal/events/abc_20260820T010000Z', 'PUT', KEYED, JSON.stringify({ summary: 'y' })), env)).json();
    check('PUT → 成功', upd.id === 'created-id');
    check('イベントIDがパスに乗る', fetchLog.some(l => l.url.includes('/events/abc_20260820T010000Z') && l.options.method === 'PUT'));

    const del = await (await worker.fetch(req('/gcal/events/abc', 'DELETE', KEYED), env)).json();
    check('DELETE 404 → ok:true（削除済み扱い）', del.ok === true);

    // 未連携
    const env2 = makeEnv();
    const notLinked = await worker.fetch(req('/gcal/events', 'POST', KEYED, '{}'), env2);
    check('未連携でのPOST → 409', notLinked.status === 409);
}

console.log('\n【5】連携解除');
{
    const env = makeEnv();
    await env.GCAL_KV.put('tokens', JSON.stringify({ refresh_token: 'RT' }));
    await env.GCAL_KV.put('events', JSON.stringify({ events: [1], fetchedAt: 'x' }));
    let revoked = false;
    fetchHandlers = [['oauth2.googleapis.com/revoke', () => { revoked = true; return new Response(null, { status: 200 }); }]];
    const res = await (await worker.fetch(req('/oauth', 'DELETE', KEYED), env)).json();
    check('解除 → ok', res.ok === true);
    check('Googleにrevoke通知', revoked);
    check('tokens/eventsがKVから消える',
        await env.GCAL_KV.get('tokens') === null && await env.GCAL_KV.get('events') === null);
    const st = await (await worker.fetch(req('/status', 'GET', KEYED), env)).json();
    check('解除後 status → linked:false', st.linked === false);
}

console.log('\n【6】バグ修正の検証（500ラップ・同期失敗時の再試行）');
{
    // (a) トークン更新失敗（未捕捉例外だったケース）→ CORSヘッダ付きのJSON 500が返る
    const env = makeEnv();
    await env.GCAL_KV.put('tokens', JSON.stringify({ refresh_token: 'RT', access_token: 'OLD', expires_at: Date.now() - 1000 }));
    fetchHandlers = [
        ['oauth2.googleapis.com/token', () => jsonRes({ error: 'temporarily_unavailable' })],
    ];
    const res = await worker.fetch(req('/sync', 'POST', KEYED), env);
    check('例外がJSON 500になる', res.status === 500);
    check('CORSヘッダが付く（アプリからエラー内容が読める）', res.headers.get('Access-Control-Allow-Origin') === '*');
    const body = await res.json();
    check('エラーメッセージが入る', String(body.error).includes('トークン更新失敗'));

    // (b) 同期失敗時はlast_syncを記録しない → 60秒待たず即再試行できる
    check('失敗時はlast_sync未記録', await env.GCAL_KV.get('last_sync') === null);
    let synced = false;
    fetchHandlers = [
        ['oauth2.googleapis.com/token', () => jsonRes({ access_token: 'NEW', expires_in: 3600 })],
        ['www.googleapis.com/calendar', () => { synced = true; return jsonRes({ items: [] }); }],
    ];
    const retry = await worker.fetch(req('/sync', 'POST', KEYED), env);
    check('直後の再試行が通る', retry.status === 200 && synced);
    check('成功したらlast_syncが記録される', await env.GCAL_KV.get('last_sync') !== null);
}

console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
process.exit(fail === 0 ? 0 : 1);
