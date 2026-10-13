/**
 * Googleカレンダー同期Worker
 * - /oauth/*      : 認可コードフロー（refresh_tokenをKVに保存。一度だけ）
 * - /events       : KVにキャッシュ済みの予定を返す（アプリのカレンダー表示用）
 * - /sync         : 手動同期（引っ張って更新から呼ぶ。60秒の連打ガードつき）
 * - /gcal/events* : メモ→Googleカレンダーの登録・更新・削除の代理実行
 * - /receipt      : レシート画像をClaude APIで読み取る（家計簿のレシート読み取り）
 * - scheduled()   : Cron（毎時）で予定をKVへキャッシュ
 *
 * 必要なバインディング/シークレット（docs/gcal-sync-design.md §6、docs/receipt-reader.md 参照）:
 *   KV:      GCAL_KV
 *   Secret:  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / APP_KEY
 *            ANTHROPIC_API_KEY（レシート読み取りを使う場合のみ）
 *   変数(任意): RECEIPT_DAILY_LIMIT（1日の読み取り上限。既定50回）
 *              RECEIPT_MODEL（読み取りに使うモデル。既定 claude-opus-5-5）
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
    'Access-Control-Allow-Headers': 'Content-Type,X-App-Key,X-Image-Type,X-Categories',
};

export default {
    async fetch(request, env) {
        try {
            return await route(request, env);
        } catch (err) {
            // 未捕捉例外をそのまま投げるとCORSヘッダなしの500になり、
            // アプリ側でエラー内容が読めないため、必ずJSONで返す
            console.error('リクエスト処理エラー:', err);
            return json({ error: err.message || 'internal error' }, 500);
        }
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(syncEvents(env).catch(err => console.error('定期同期エラー:', err)));
    },
};

async function route(request, env) {
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
    if (path === '/receipt' && request.method === 'POST') return readReceipt(request, env);
    if (path === '/gcal/events' && request.method === 'POST') {
        return proxyGcal(env, 'POST', '', await request.text());
    }
    const eventMatch = path.match(/^\/gcal\/events\/([^/]+)$/);
    if (eventMatch && (request.method === 'PUT' || request.method === 'DELETE')) {
        const body = request.method === 'PUT' ? await request.text() : null;
        return proxyGcal(env, request.method, `/${eventMatch[1]}`, body);
    }

    return json({ error: 'not found' }, 404);
}

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
        await syncEvents(env);
        // 成功したときだけ記録する（失敗時は次の引っ張って更新で即座に再試行できる）
        await env.GCAL_KV.put('last_sync', String(Date.now()));
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

// ---------- レシート読み取り（Claude API） ----------
//
// アプリから届いたレシート画像（base64）をClaude APIに渡し、店名・日付・合計などをJSONで返す。
// APIキーはこのWorkerのシークレットにだけ置き、ブラウザには一切渡さない。
// Workerはダッシュボードにこのファイルを貼り付けて配置している（ビルド工程なし＝npmパッケージを
// 読み込めない）ため、Anthropic SDKではなくfetchでMessages APIを直接呼ぶ。

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const RECEIPT_DEFAULT_MODEL = 'claude-opus-5-5';
const RECEIPT_DEFAULT_DAILY_LIMIT = 50;
const RECEIPT_MAX_BASE64_CHARS = 10 * 1024 * 1024; // API側の上限（1画像あたりbase64で10MB）
const RECEIPT_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const RECEIPT_TIMEOUT_MS = 90 * 1000;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_PLACEHOLDER = '__RECEIPT_IMAGE__';

const PAYMENT_METHODS = ['cash', 'credit_card', 'debit_card', 'e_money', 'qr', 'other', 'unknown'];

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

/** 構造化出力のスキーマ（固定にしておくと、API側のスキーマのコンパイル結果が再利用される） */
const RECEIPT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['isReceipt', 'store', 'date', 'total', 'paymentMethod', 'category', 'items', 'note'],
    properties: {
        isReceipt: { type: 'boolean' },
        store: nullable({ type: 'string' }),
        date: nullable({ type: 'string', format: 'date' }),
        total: nullable({ type: 'integer' }),
        paymentMethod: { type: 'string', enum: PAYMENT_METHODS },
        category: nullable({ type: 'string' }),
        items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'amount'],
                properties: { name: { type: 'string' }, amount: { type: 'integer' } },
            },
        },
        note: nullable({ type: 'string' }),
    },
};

const RECEIPT_SYSTEM_PROMPT = `あなたは日本の家庭の家計簿アプリで、レシートの写真を読み取る係です。画像から次の項目を読み取り、指定されたJSON形式で返してください。

- isReceipt: レシートや領収書の写真なら true。そうでなければ false にして、ほかの項目は null または空配列にします。
- store: 店名。チェーン名と店舗名があれば「チェーン名 店舗名」（例: イオン 幕張店）。会社名・住所・電話番号は含めません。
- date: 購入日を YYYY-MM-DD 形式で。和暦（令和など）は西暦に直します。年が省略されていれば、ユーザーが伝える今日の日付から最も近い過去の日付として補います。読めなければ null。
- total: 実際に支払った金額（税込の合計）を円の整数で。値引きやポイント利用の後の金額を使い、「お預り」「お釣り」の金額は使いません。読めなければ null。
- paymentMethod: 支払方法。現金は cash。クレジットカード、カードのタッチ決済、iD、QUICPay は credit_card。デビットカードは debit_card。交通系IC、nanaco、WAON、楽天Edy などの電子マネーは e_money。PayPay、楽天ペイ、d払い、au PAY などのコード決済は qr。それ以外は other、判断できなければ unknown。
- items: 品目ごとの名前と金額（円の整数）。値引きはマイナスの金額で1行にします。小計・消費税・合計・お預り・お釣りの行は入れません。
- category: ユーザーが伝えるカテゴリー候補から最も合うものを1つ、候補の表記のまま選びます。合うものがなければ null。
- note: かすれて読めない部分がある、複数枚のレシートが写っている、など読み取りに不安がある点を短い日本語で。なければ null。`;

/** 日本時間の日付（YYYY-MM-DD） */
function jstDateString(now = Date.now()) {
    return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** X-Categories ヘッダー（encodeURIComponent したJSON配列）を読む。壊れていれば空配列 */
function parseCategoriesHeader(value) {
    if (!value) return [];
    try {
        const list = JSON.parse(decodeURIComponent(value));
        if (!Array.isArray(list)) return [];
        return list.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim()).slice(0, 50);
    } catch {
        return [];
    }
}

function receiptUserText(categories, today) {
    const list = categories.length ? categories.join('、') : 'なし';
    return `このレシートを読み取ってください。\nカテゴリー候補: ${list}\n今日の日付: ${today}`;
}

/**
 * Messages APIへのリクエスト本文を作る。
 * 画像のbase64は数MBになるため JSON.stringify に通さず、文字列として差し込む
 * （無料プランのCPU時間の上限対策。文字種はBASE64_REで検証済みなのでエスケープは不要）。
 */
function buildReceiptRequestBody({ model, mediaType, image, categories, today, useFallback }) {
    const body = JSON.stringify({
        model,
        max_tokens: 16000,
        // 安全分類器が誤って断った場合に、APIが推奨モデルで自動的にやり直す
        ...(useFallback ? { fallbacks: 'default' } : {}),
        system: RECEIPT_SYSTEM_PROMPT,
        output_config: {
            effort: 'low', // 読み取りは単純な作業なので、待ち時間と料金を抑える
            format: { type: 'json_schema', schema: RECEIPT_SCHEMA },
        },
        messages: [{
            role: 'user',
            content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: IMAGE_PLACEHOLDER } },
                { type: 'text', text: receiptUserText(categories, today) },
            ],
        }],
    });
    return body.replace(`"${IMAGE_PLACEHOLDER}"`, () => `"${image}"`);
}

/** モデルの出力を、アプリがそのまま使える形に整える（型の崩れや想定外の値を吸収） */
function normalizeReceipt(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const int = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
    const date = str(r.date);
    return {
        isReceipt: r.isReceipt !== false,
        store: str(r.store),
        date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
        total: int(r.total),
        paymentMethod: PAYMENT_METHODS.includes(r.paymentMethod) ? r.paymentMethod : 'unknown',
        category: str(r.category),
        items: Array.isArray(r.items)
            ? r.items
                .filter(i => i && str(i.name))
                .slice(0, 100)
                .map(i => ({ name: i.name.trim(), amount: int(i.amount) }))
            : [],
        note: str(r.note),
    };
}

/** Messages APIを1回呼ぶ（useFallback: サーバー側フォールバックを使うか） */
async function callReceiptApi(env, params, useFallback) {
    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
    };
    if (useFallback) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    const res = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers,
        body: buildReceiptRequestBody({ ...params, useFallback }),
        signal: AbortSignal.timeout(RECEIPT_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
}

async function readReceipt(request, env) {
    if (!env.ANTHROPIC_API_KEY) {
        return json({ error: 'レシート読み取りの設定がまだです（WorkerにANTHROPIC_API_KEYを登録してください）' }, 503);
    }

    const mediaType = request.headers.get('X-Image-Type') || '';
    if (!RECEIPT_MEDIA_TYPES.includes(mediaType)) {
        return json({ error: '対応していない画像形式です（JPEG/PNG/WebP/GIF）' }, 400);
    }
    const image = (await request.text()).trim();
    if (!image) return json({ error: '画像が届いていません' }, 400);
    if (image.length > RECEIPT_MAX_BASE64_CHARS) return json({ error: '画像が大きすぎます' }, 413);
    if (!BASE64_RE.test(image)) return json({ error: '画像データの形式が正しくありません' }, 400);

    // 1日あたりの上限（キーが漏れた場合などにAPIクレジットを使い切られないための歯止め）。
    // 失敗しても料金がかかり得るため、API呼び出しの前に数える。
    const limit = parseInt(env.RECEIPT_DAILY_LIMIT, 10) || RECEIPT_DEFAULT_DAILY_LIMIT;
    const today = jstDateString();
    const countKey = `receipt_count_${today}`;
    const used = parseInt(await env.GCAL_KV.get(countKey) || '0', 10);
    if (used >= limit) {
        return json({ error: `今日の読み取り回数の上限（${limit}回）に達しました。明日またお試しください` }, 429);
    }
    await env.GCAL_KV.put(countKey, String(used + 1), { expirationTtl: 2 * 86400 });

    const params = {
        model: env.RECEIPT_MODEL || RECEIPT_DEFAULT_MODEL,
        mediaType,
        image,
        categories: parseCategoriesHeader(request.headers.get('X-Categories')),
        today,
    };
    let res;
    let data;
    try {
        ({ res, data } = await callReceiptApi(env, params, true));
        // フォールバック指定を受け付けないモデル・設定（RECEIPT_MODELの差し替え等）なら、指定なしで1回だけやり直す
        if (res.status === 400 && /fallback/i.test(String(data?.error?.message || ''))) {
            console.warn('fallbacksが受け付けられなかったため、指定なしで再試行します');
            ({ res, data } = await callReceiptApi(env, params, false));
        }
    } catch (err) {
        console.error('Claude API 通信エラー:', err);
        return json({ error: '読み取りに時間がかかりすぎました。もう一度お試しください' }, 504);
    }

    if (!res.ok) {
        console.error('Claude API エラー:', res.status, data?.error?.type, data?.error?.message);
        // 401はアプリキーの誤り（アプリ側でキーを消す）と区別するため、必ず502で返す
        const apiMessage = String(data?.error?.message || '');
        let message = `読み取りに失敗しました（${res.status}）`;
        if (res.status === 401 || res.status === 403) {
            message = 'Claude APIのキーが正しくありません（Workerの設定を確認してください）';
        } else if (res.status === 429 || res.status === 529) {
            message = '混み合っています。少し待ってからお試しください';
        } else if (res.status === 400 && /credit balance|usage limit|spend limit/i.test(apiMessage)) {
            // クレジット切れ・Workspaceの利用上限（どちらも400で返る）
            message = '今月のAPIクレジット（または利用上限）を使い切りました。Claude ConsoleのBillingを確認してください';
        }
        return json({ error: message }, 502);
    }
    if (data.stop_reason === 'refusal') return json({ error: 'この画像は読み取れませんでした' }, 422);
    if (data.stop_reason === 'max_tokens') return json({ error: '読み取り結果が長すぎて途中で切れました' }, 422);

    // 思考ブロック等を飛ばし、テキストブロック（構造化出力のJSON）だけを読む
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        console.error('レシート読み取り結果の解析失敗:', text.slice(0, 200));
        return json({ error: '読み取り結果を解析できませんでした' }, 502);
    }

    return json({
        receipt: normalizeReceipt(parsed),
        model: data.model || null,
        usage: { input_tokens: data.usage?.input_tokens ?? null, output_tokens: data.usage?.output_tokens ?? null },
    });
}
