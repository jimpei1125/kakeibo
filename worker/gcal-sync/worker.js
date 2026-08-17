/**
 * Googleカレンダー同期Worker
 * - /oauth/*      : 認可コードフロー（refresh_tokenをKVに保存。一度だけ）
 * - /events       : KVにキャッシュ済みの予定を返す（アプリのカレンダー表示用）
 * - /sync         : 手動同期（引っ張って更新から呼ぶ。60秒の連打ガードつき）
 * - /gcal/events* : メモ→Googleカレンダーの登録・更新・削除の代理実行
 * - scheduled()   : Cron（毎時）で予定をKVへキャッシュ
 *
 * 必要なバインディング/シークレット（docs/gcal-sync-design.md §6参照）:
 *   KV:      GCAL_KV
 *   Secret:  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / APP_KEY
 */

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const GCAL_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const SYNC_RANGE_PAST_DAYS = 31;   // 同期範囲: 31日前から
const SYNC_RANGE_FUTURE_DAYS = 93; // 93日後まで
const MANUAL_SYNC_INTERVAL_MS = 60 * 1000; // 手動同期の最短間隔

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-App-Key',
};

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }
        const url = new URL(request.url);
        const path = url.pathname;

        // OAuth系（startはクエリ、callbackはstateで認可を担保）
        if (path === '/oauth/start') return oauthStart(url, env);
        if (path === '/oauth/callback') return oauthCallback(url, env);

        // 以降はすべてAPP_KEY必須
        if (request.headers.get('X-App-Key') !== env.APP_KEY) {
            return json({ error: 'unauthorized' }, 401);
        }

        if (path === '/status' && request.method === 'GET') return status(env);
        if (path === '/events' && request.method === 'GET') return events(env);
        if (path === '/sync' && request.method === 'POST') return manualSync(env);
        if (path === '/oauth' && request.method === 'DELETE') return unlink(env);
        if (path === '/gcal/events' && request.method === 'POST') {
            return proxyGcal(env, 'POST', '', await request.text());
        }
        const eventMatch = path.match(/^\/gcal\/events\/([^/]+)$/);
        if (eventMatch && (request.method === 'PUT' || request.method === 'DELETE')) {
            const body = request.method === 'PUT' ? await request.text() : null;
            return proxyGcal(env, request.method, `/${eventMatch[1]}`, body);
        }

        return json({ error: 'not found' }, 404);
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(syncEvents(env).catch(err => console.error('定期同期エラー:', err)));
    },
};

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

// ---------- OAuth ----------

async function oauthStart(url, env) {
    if (url.searchParams.get('key') !== env.APP_KEY) {
        return new Response('unauthorized', { status: 401 });
    }
    const state = crypto.randomUUID();
    await env.GCAL_KV.put('oauth_state', state, { expirationTtl: 600 });

    const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: `${url.origin}/oauth/callback`,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline', // refresh_tokenをもらうために必須
        prompt: 'consent',      // 再連携時にもrefresh_tokenを確実に再発行させる
        state,
    });
    return Response.redirect(`${GOOGLE_AUTH}?${params}`, 302);
}

async function oauthCallback(url, env) {
    const savedState = await env.GCAL_KV.get('oauth_state');
    if (!savedState || url.searchParams.get('state') !== savedState) {
        return new Response('不正なリクエストです（stateが一致しません）', { status: 400 });
    }
    await env.GCAL_KV.delete('oauth_state');

    const code = url.searchParams.get('code');
    if (!code) return new Response('認可がキャンセルされました。タブを閉じてやり直してください。', { status: 400 });

    const res = await fetch(GOOGLE_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: `${url.origin}/oauth/callback`,
            grant_type: 'authorization_code',
        }),
    });
    const data = await res.json();
    if (!data.refresh_token) {
        return new Response(`連携に失敗しました: ${data.error || 'refresh_tokenが取得できませんでした'}`, { status: 400 });
    }

    await env.GCAL_KV.put('tokens', JSON.stringify({
        refresh_token: data.refresh_token,
        access_token: data.access_token,
        expires_at: Date.now() + data.expires_in * 1000,
    }));

    await syncEvents(env).catch(err => console.error('初回同期エラー:', err));

    return new Response(
        '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#18181b;color:#e4e4e7;display:grid;place-items:center;height:100vh;margin:0">'
        + '<div style="text-align:center"><p style="font-size:2rem">✅</p><p>Googleカレンダーと連携しました。<br>このタブを閉じて、アプリに戻ってください。</p></div>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
}

async function unlink(env) {
    const tokens = JSON.parse(await env.GCAL_KV.get('tokens') || 'null');
    if (tokens?.refresh_token) {
        await fetch(`${GOOGLE_REVOKE}?token=${encodeURIComponent(tokens.refresh_token)}`, { method: 'POST' })
            .catch(() => {}); // revoke失敗してもローカル削除は続行
    }
    await env.GCAL_KV.delete('tokens');
    await env.GCAL_KV.delete('events');
    return json({ ok: true });
}

// ---------- トークン管理 ----------

/** 有効なaccess_tokenを返す（期限60秒前で自動更新）。未連携ならnull */
async function getAccessToken(env) {
    const tokens = JSON.parse(await env.GCAL_KV.get('tokens') || 'null');
    if (!tokens) return null;
    if (Date.now() < tokens.expires_at - 60 * 1000) return tokens.access_token;

    const res = await fetch(GOOGLE_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            refresh_token: tokens.refresh_token,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            grant_type: 'refresh_token',
        }),
    });
    const data = await res.json();
    if (!data.access_token) {
        // ユーザーがGoogle側で連携を取り消した等 → 未連携状態に戻す
        if (data.error === 'invalid_grant') await env.GCAL_KV.delete('tokens');
        throw new Error(`トークン更新失敗: ${data.error || 'unknown'}`);
    }
    tokens.access_token = data.access_token;
    tokens.expires_at = Date.now() + data.expires_in * 1000;
    await env.GCAL_KV.put('tokens', JSON.stringify(tokens));
    return tokens.access_token;
}

// ---------- 予定の同期・取得 ----------

async function syncEvents(env) {
    const token = await getAccessToken(env);
    if (!token) return; // 未連携なら何もしない

    const now = Date.now();
    const timeMin = new Date(now - SYNC_RANGE_PAST_DAYS * 86400000).toISOString();
    const timeMax = new Date(now + SYNC_RANGE_FUTURE_DAYS * 86400000).toISOString();

    const events = [];
    let pageToken = '';
    do {
        const params = new URLSearchParams({
            timeMin, timeMax,
            singleEvents: 'true', // 繰り返し予定を個別インスタンスに展開
            orderBy: 'startTime',
            maxResults: '250',
        });
        if (pageToken) params.set('pageToken', pageToken);

        const res = await fetch(`${GCAL_API}?${params}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`予定取得失敗: ${res.status}`);
        const data = await res.json();

        for (const item of data.items || []) {
            if (item.status === 'cancelled') continue;
            events.push({
                id: item.id,
                title: item.summary || '（無題）',
                start: item.start?.date || item.start?.dateTime || '',
                end: item.end?.date || item.end?.dateTime || '',
                allDay: !!item.start?.date,
                location: item.location || '',
            });
        }
        pageToken = data.nextPageToken || '';
    } while (pageToken);

    await env.GCAL_KV.put('events', JSON.stringify({ events, fetchedAt: new Date().toISOString() }));
}

async function status(env) {
    const tokens = await env.GCAL_KV.get('tokens');
    const cached = JSON.parse(await env.GCAL_KV.get('events') || 'null');
    return json({ linked: !!tokens, fetchedAt: cached?.fetchedAt || null });
}

async function events(env) {
    const cached = JSON.parse(await env.GCAL_KV.get('events') || 'null');
    return json(cached || { events: [], fetchedAt: null });
}

async function manualSync(env) {
    // 家族が同時に引っ張って更新してもAPIを叩きすぎないようガード
    const last = parseInt(await env.GCAL_KV.get('last_sync') || '0');
    if (Date.now() - last >= MANUAL_SYNC_INTERVAL_MS) {
        await env.GCAL_KV.put('last_sync', String(Date.now()));
        await syncEvents(env);
    }
    return events(env);
}

// ---------- メモ登録の代理実行 ----------

/** アプリのメモ→GCalイベント操作を、保存済みトークンで代理実行する */
async function proxyGcal(env, method, pathSuffix, body) {
    const token = await getAccessToken(env);
    if (!token) return json({ error: 'not linked' }, 409);

    const res = await fetch(`${GCAL_API}${pathSuffix}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body || undefined,
    });
    if (method === 'DELETE') {
        return json({ ok: res.ok || res.status === 404 }); // 404=すでに削除済みは成功扱い
    }
    const data = await res.json();
    if (!res.ok) return json({ error: data.error?.message || `HTTP ${res.status}` }, res.status);

    // 書き込み後はキャッシュも追従させる（次のCronを待たない）
    await syncEvents(env).catch(() => {});
    return json({ id: data.id });
}
