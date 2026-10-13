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

console.log('\n【7】レシート読み取り（/receipt）');
{
    const IMG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    const receiptReq = (body = IMG, headers = {}) =>
        req('/receipt', 'POST', { ...KEYED, 'Content-Type': 'text/plain', 'X-Image-Type': 'image/jpeg', ...headers }, body);
    const claudeRes = (obj, extra = {}) => jsonRes({
        model: 'claude-opus-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(obj) }],
        usage: { input_tokens: 4000, output_tokens: 300 },
        ...extra,
    });
    const SAMPLE = {
        isReceipt: true, store: 'イオン 幕張店', date: '2026-10-12', total: 3280.4, paymentMethod: 'cash', category: '食費',
        items: [{ name: '牛乳', amount: 238 }, { name: '', amount: 1 }, { name: '値引', amount: -50 }], note: null,
    };
    const countKeys = (env) => [...env.GCAL_KV.store.keys()].filter(k => k.startsWith('receipt_count_'));
    const keyedEnv = (extra = {}) => ({ ...makeEnv(), ANTHROPIC_API_KEY: 'sk-test', ...extra });

    // (a) 未設定・認可
    check('ANTHROPIC_API_KEY未設定 → 503', (await worker.fetch(receiptReq(), makeEnv())).status === 503);
    const env = keyedEnv();
    const noKey = await worker.fetch(req('/receipt', 'POST', { 'X-Image-Type': 'image/jpeg' }, IMG), env);
    check('アプリキーなし → 401', noKey.status === 401);

    // (b) 入力検証（APIを呼ばず、回数にも数えない）
    fetchLog.length = 0;
    check('未対応の形式 → 400', (await worker.fetch(receiptReq(IMG, { 'X-Image-Type': 'image/heic' }), env)).status === 400);
    check('空の本文 → 400', (await worker.fetch(receiptReq(''), env)).status === 400);
    check('base64以外の文字（JSON注入）→ 400', (await worker.fetch(receiptReq('abc"},{"x":"y'), env)).status === 400);
    check('10MB超 → 413', (await worker.fetch(receiptReq('A'.repeat(10 * 1024 * 1024 + 4)), env)).status === 413);
    check('検証で弾いたときはAPIを呼ばず回数も増えない', fetchLog.length === 0 && countKeys(env).length === 0);

    // (c) 正常系: 送る内容と返す内容
    fetchHandlers = [['api.anthropic.com/v1/messages', () => claudeRes(SAMPLE)]];
    const cats = encodeURIComponent(JSON.stringify(['食費', '日用品', '', 3]));
    const ok = await worker.fetch(receiptReq(IMG, { 'X-Categories': cats }), env);
    const okBody = await ok.json();
    check('読み取り成功 → 200', ok.status === 200);
    check('結果を正規化して返す（金額は整数・空の品目は除外・値引きはマイナス）',
        okBody.receipt.store === 'イオン 幕張店' && okBody.receipt.total === 3280
        && okBody.receipt.items.length === 2 && okBody.receipt.items[1].amount === -50
        && okBody.receipt.paymentMethod === 'cash' && okBody.receipt.date === '2026-10-12');
    const call = fetchLog.find(f => f.url.includes('api.anthropic.com'));
    const sent = JSON.parse(call.options.body);
    check('APIキー・バージョンをヘッダーで送る',
        call.options.headers['x-api-key'] === 'sk-test' && call.options.headers['anthropic-version'] === '2023-06-01');
    check('安全分類器の誤判定に備えたフォールバックを有効化',
        call.options.headers['anthropic-beta'] === 'server-side-fallback-2026-07-01' && sent.fallbacks === 'default');
    check('既定モデルは claude-opus-5-5', sent.model === 'claude-opus-5-5');
    check('構造化出力（json_schema）と effort low',
        sent.output_config.format.type === 'json_schema' && sent.output_config.effort === 'low'
        && sent.output_config.format.schema.additionalProperties === false);
    check('thinkingの無効化・予算指定は送らない（Opus 5.5では400になる）', !('thinking' in sent));
    const imgBlock = sent.messages[0].content[0];
    check('画像はbase64のまま、テキストより前に入る',
        imgBlock.type === 'image' && imgBlock.source.type === 'base64'
        && imgBlock.source.data === IMG && imgBlock.source.media_type === 'image/jpeg');
    const userText = sent.messages[0].content[1].text;
    check('カテゴリー候補（不正な要素は除外）と今日の日付を伝える',
        userText.split('\n').includes('カテゴリー候補: 食費、日用品')
        && /今日の日付: \d{4}-\d{2}-\d{2}/.test(userText));
    check('読み取り回数が記録される', countKeys(env).length === 1 && env.GCAL_KV.store.get(countKeys(env)[0]) === '1');

    // (d) モデルの差し替え・カテゴリーヘッダー破損
    fetchLog.length = 0;
    const envHaiku = keyedEnv({ RECEIPT_MODEL: 'claude-haiku-5-5' });
    const r2 = await worker.fetch(receiptReq(IMG, { 'X-Categories': '%E0%A4%A' }), envHaiku);
    const sent2 = JSON.parse(fetchLog.find(f => f.url.includes('api.anthropic.com')).options.body);
    check('RECEIPT_MODEL でモデルを差し替えられる', sent2.model === 'claude-haiku-5-5');
    check('壊れたカテゴリーヘッダーは無視して読み取りは続ける',
        r2.status === 200 && sent2.messages[0].content[1].text.includes('カテゴリー候補: なし'));

    // (e) 1日の上限
    const envLimit = keyedEnv({ RECEIPT_DAILY_LIMIT: '2' });
    await worker.fetch(receiptReq(), envLimit);
    await worker.fetch(receiptReq(), envLimit);
    fetchLog.length = 0;
    const over = await worker.fetch(receiptReq(), envLimit);
    check('上限を超えたら429でAPIを呼ばない', over.status === 429 && fetchLog.length === 0);
    check('上限のメッセージに回数を含む', (await over.json()).error.includes('2回'));

    // (f) エラーの扱い
    const statusOf = async (handler) => {
        fetchHandlers = [['api.anthropic.com/v1/messages', handler]];
        const r = await worker.fetch(receiptReq(), keyedEnv());
        return { status: r.status, body: await r.json() };
    };
    check('refusal → 422', (await statusOf(() => claudeRes({}, { stop_reason: 'refusal' }))).status === 422);
    check('max_tokens → 422', (await statusOf(() => claudeRes(SAMPLE, { stop_reason: 'max_tokens' }))).status === 422);
    const busy = await statusOf(() => jsonRes({ type: 'error', error: { type: 'overloaded_error', message: 'x' } }, 529));
    check('APIが混雑（529）→ 502・混雑の案内', busy.status === 502 && busy.body.error.includes('混み合って'));
    const badKey = await statusOf(() => jsonRes({ type: 'error', error: { type: 'authentication_error', message: 'x' } }, 401));
    check('APIキー誤り（401）はアプリキー誤りと区別して502', badKey.status === 502 && badKey.body.error.includes('Claude APIのキー'));
    const noCredit = await statusOf(() => jsonRes({ type: 'error', error: { type: 'invalid_request_error',
        message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }, 400));
    check('クレジット切れ（400）はその旨を案内', noCredit.status === 502 && noCredit.body.error.includes('クレジット'));
    const otherBad = await statusOf(() => jsonRes({ type: 'error', error: { type: 'invalid_request_error', message: 'image too large' } }, 400));
    check('その他の400は状態コード付きの汎用メッセージ', otherBad.body.error.includes('（400）'));
    // フォールバック指定が拒否されたら、指定なしで1回だけ再試行
    fetchLog.length = 0;
    let calls = 0;
    const retried = await statusOf(() => (++calls === 1
        ? jsonRes({ type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: not supported for this model' } }, 400)
        : claudeRes(SAMPLE)));
    const apiCalls = fetchLog.filter(f => f.url.includes('api.anthropic.com'));
    const second = apiCalls[1] && JSON.parse(apiCalls[1].options.body);
    check('fallbacks拒否 → 指定なしで再試行して成功', retried.status === 200 && apiCalls.length === 2
        && !('fallbacks' in second) && !apiCalls[1].options.headers['anthropic-beta']);
    const garbage = await statusOf(() => jsonRes({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }));
    check('JSONでない出力 → 502', garbage.status === 502);
    const timeout = await statusOf(() => { throw new DOMException('timeout', 'TimeoutError'); });
    check('通信失敗・タイムアウト → 504', timeout.status === 504);

    // (g) 想定外の値の正規化
    const odd = await statusOf(() => claudeRes({
        isReceipt: false, store: '  ', date: '10/12', total: 'abc', paymentMethod: 'bitcoin', category: null, items: 'x', note: '',
    }));
    check('想定外の値は安全な既定値に寄せる',
        odd.status === 200 && odd.body.receipt.isReceipt === false && odd.body.receipt.store === null
        && odd.body.receipt.date === null && odd.body.receipt.total === null
        && odd.body.receipt.paymentMethod === 'unknown' && Array.isArray(odd.body.receipt.items)
        && odd.body.receipt.items.length === 0 && odd.body.receipt.note === null);

    // (h) CORS: 画像用の独自ヘッダーを許可
    const pre = await worker.fetch(new Request(`${BASE}/receipt`, { method: 'OPTIONS' }), keyedEnv());
    const allow = pre.headers.get('Access-Control-Allow-Headers') || '';
    check('プリフライトで X-Image-Type / X-Categories を許可', allow.includes('X-Image-Type') && allow.includes('X-Categories'));
}

console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
process.exit(fail === 0 ? 0 : 1);
