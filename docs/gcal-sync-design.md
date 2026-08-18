# Googleカレンダー同期機能 実装設計書（Cloudflare Worker 同期方式・案C）

> 対象実装者: **Claude（自走前提）**
> 目的: Googleカレンダーの予定を家計簿アプリの**カレンダーのマスに表示**する。
> あわせて、現在**約1時間ごとに切れて再認証が必要**なGoogleカレンダー連携（メモ登録）を
> Worker経由に置き換え、**ブラウザでのGoogle認証を完全に不要**にする。

---

## 0. 前提・環境（必読）

- **完全クライアントサイドのPWA**。GitHub Pages（`https://jimpei1125.github.io/kakeibo/`）で静的配信。
- Cloudflare Workers の運用実績あり（switchbot-proxy / hue-proxy）。本機能は**新規Worker `gcal-sync`** として追加する（スマートホームタイマー設計 `docs/smarthome-timer-design.md` と同じ流儀。Workerのコードは `worker/gcal-sync/` でリポジトリ管理し、デプロイはダッシュボードから手動）。
- **Tailwindはビルド式**。クラスを追加したら `npm run build:css` を実行して `css/tailwind.css` を再生成・コミットすること。
- **Service Worker のキャッシュ名**（`service-worker.js` の `CACHE_NAME`、現在 `v6`）はJS/HTML変更時に必ず上げる。

### 0.1 なぜWorkerが必要か（再確認）

現在の実装（`js/calendar.js` の `initGoogleCalendar` 一帯）はGoogle Identity Servicesの**トークンフロー**で、①アクセストークンの寿命が約1時間、②リフレッシュトークンが取得できない、という仕様のため再認証が頻発する。認可コードフロー＋リフレッシュトークンに移行するには client_secret を秘匿できるサーバーが必要であり、それをWorkerが担う。トークンはWorkerの外に出さない。

---

## 1. 現状分析

`js/calendar.js`（リファクタリング後、mainのHEAD時点）:

| 箇所 | 内容 | 本設計での扱い |
|---|---|---|
| `initGoogleCalendar()`（293行〜） | gsi/client と api.js の動的ロード、GISトークンクライアント初期化 | **丸ごと削除**（gapiのロードは現状でも未使用の死荷重） |
| `_restoreSavedToken` / `_disconnectGcal` / `_handleTokenExpired` | localStorageのトークン管理 | **削除**（トークンはWorkerが持つ） |
| `_buildGcalEvent(memo)`（369行） | メモ→GCalイベント変換 | **維持**（送信先がWorkerに変わるだけ） |
| `createGoogleCalendarEvent` / `updateGoogleCalendarEvent` / `deleteGoogleCalendarEvent` | fetchでGCal APIを直叩き | **Worker経由に差し替え**（呼び出し元5箇所は無変更で済む） |
| `renderCalendar()`（516行） | 42マスのグリッド描画（祝日・休日・メモバッジ） | **予定チップの描画を追加** |
| `showDateDetail(dateStr)`（794行） | 日付詳細モーダル（休日・メモ） | **予定セクションを追加** |
| `updateGcalStatus()` / `#gcalStatus`（index.html 481行〜） | 連携状態表示と連携ボタン | **Worker連携状態の表示に差し替え** |

メモは `memos[].gcalEventId` にGCalのイベントIDを保持している。この仕組みは維持する。

---

## 2. 要件

1. Googleカレンダー（primary）の予定が、カレンダー画面の**日付マスに表示**される。
2. 日付マスをタップした詳細モーダルに、その日の予定が**時刻つきで一覧表示**される。
3. Google認証は**セットアップ時に一度だけ**（家族の誰か1人がWorker経由で認可）。以降どの端末でも認証不要。
4. 既存の「メモ→Googleカレンダー登録・更新・削除」もWorker経由になり、ブラウザ認証が不要になる。
5. 予定は自動で最新化される（Cronで1時間ごと＋アプリの引っ張って更新で即時同期）。
6. アプリ側は既存の休日・メモ表示を壊さない。

---

## 3. 全体設計

```
┌─ ブラウザ(PWA) ──────────────┐     ┌─ Cloudflare Worker: gcal-sync ─────────┐
│ カレンダー画面                  │     │ fetch(request):                         │
│  ├─ GET /events ──────────────┼─────┼→ KVの予定キャッシュを返す                  │
│  ├─ POST /sync（引っ張って更新） ┼─────┼→ GCalから再取得してKV更新                 │
│  ├─ メモ登録→ POST /gcal/events ┼─────┼→ 保存済みトークンでGCal APIに書き込み       │
│  └─ (X-App-Key ヘッダで認可)    │     │                                         │
└───────────────────────────┘     │ /oauth/start → Google同意画面へリダイレクト │
                                       │ /oauth/callback → code交換、             │
        ┌─ Google Calendar API ←──────┼─ refresh_tokenをKVに保存（一度だけ）       │
        │  (Workerがrefresh_tokenで     │                                         │
        │   access_tokenを自動更新)      │ scheduled(cron 毎時):                   │
        └──────────────────────────┼─ 予定を取得してKVにキャッシュ               │
                                       └────────────────────────────────────┘
```

### 3.1 設計判断とその理由

| 判断 | 理由 |
|---|---|
| 予定はFirestoreに書かず、**WorkerのKVキャッシュをアプリが直接GET** | WorkerからFirestoreに書くにはサービスアカウント鍵の管理が必要になり、セットアップが大幅に重くなる。予定は読み取り専用のミラーデータなのでリアルタイム購読の価値も薄い。KV返却なら追加インフラゼロ |
| 対象は **primaryカレンダーのみ**（v1） | メモ登録も現状primary固定。複数カレンダー対応はKVに`calendarIds`を持てば後から足せる（§10） |
| スコープは `calendar.events`（読み書き） | 予定の読み取り＋メモの書き込みを1スコープで賄う。フルアクセス（`calendar`）は要求しない |
| `singleEvents=true` で取得 | 繰り返し予定を個別インスタンスに展開してもらう。自前でRRULEを解釈しない |
| 取得範囲は **前後およそ1〜3ヶ月**（timeMin=31日前、timeMax=93日後） | カレンダーの主な閲覧範囲。KVサイズと同期時間を抑える。範囲外の月は予定なし表示（§7に明記） |
| APP_KEY（合言葉）で全エンドポイントを認可 | タイマー設計と同じパターン。URLを知られても予定の閲覧・書き込みはできない |
| OAuthの `state` はKVに10分TTLで保存して検証 | CSRF対策。ステートレスWorkerでも安全に往復できる |

### 3.2 KVのデータ構造（ネームスペース: `GCAL_KV`）

| キー | 内容 |
|---|---|
| `tokens` | `{ refresh_token, access_token, expires_at }`（expires_atはepoch ms） |
| `events` | `{ events: Event[], fetchedAt: ISO文字列 }` |
| `oauth_state` | OAuth往復中のCSRFトークン（TTL 600秒） |
| `last_sync` | 手動同期の連打ガード用epoch ms |

`Event` の正規化形:

```js
{
  id: string,          // GCalのイベントID（メモ由来の予定の重複排除に使う）
  title: string,       // summary（無ければ「（無題）」）
  start: string,       // 終日: "YYYY-MM-DD" / 時刻あり: RFC3339（例 "2026-08-17T10:00:00+09:00"）
  end: string,         // 同上。終日イベントのendは排他的（GCal仕様のまま持つ）
  allDay: boolean,
  location: string     // 無ければ ''
}
```

### 3.3 認証・認可の流れ

- **一度だけ**: アプリの「連携」ボタン → `GET /oauth/start?key=APP_KEY` → Google同意画面（`access_type=offline&prompt=consent`）→ `/oauth/callback` でcode交換 → `refresh_token` をKVへ → 完了ページ表示 → 初回同期を実行。
- **以降**: Workerが `refresh_token` で `access_token` を自動更新（期限60秒前で更新）。`invalid_grant`（ユーザーが連携を取り消した等）が返ったら `tokens` を削除して未連携状態に戻す。
- **解除**: `DELETE /oauth` → Googleのrevokeエンドポイントに通知し、KVの `tokens`・`events` を削除。

---

## 4. Workerの実装（`worker/gcal-sync/worker.js` 新規）

必要なバインディング/シークレット（§6参照）: KV `GCAL_KV`、Secret `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `APP_KEY`。

```js
/**
 * Googleカレンダー同期Worker
 * - /oauth/*      : 認可コードフロー（refresh_tokenをKVに保存。一度だけ）
 * - /events       : KVにキャッシュ済みの予定を返す（アプリのカレンダー表示用）
 * - /sync         : 手動同期（引っ張って更新から呼ぶ。60秒の連打ガードつき）
 * - /gcal/events* : メモ→Googleカレンダーの登録・更新・削除の代理実行
 * - scheduled()   : Cron（毎時）で予定をKVへキャッシュ
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
            return proxyGcal(env, request.method, `/${encodeURIComponent(eventMatch[1])}`, body);
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
```

あわせて `worker/gcal-sync/README.md` にセットアップ手順（§6）の要約を置く。

---

## 5. アプリ側の実装（js/calendar.js ＋ index.html）

### 5.1 定数・設定

- `const GCAL_WORKER_URL = 'https://gcal-sync.zinnpei11251818.workers.dev';`
- アプリキー: `localStorage('gcal_app_key')`。`#gcalStatus` エリア（index.html 481行〜）にキー入力欄（未設定時のみ表示）を追加。タイマー機能と同じ「合言葉を1回入れる」体験に揃える。
- 旧キーの掃除: 初期化時に `gcal_access_token` / `gcal_token_expiry` を `localStorage.removeItem`。

### 5.2 削除するもの

- `initGoogleCalendar` / `_loadScript` / `_restoreSavedToken` / `setupGoogleAuth` / `_handleTokenExpired` と、gsi/gapiスクリプトのロード（ページ負荷も軽くなる）。
- `gcalTokenClient` / `gcalAccessToken` プロパティ。

### 5.3 Worker通信と差し替え

```js
async _gcalRequest(path, method = 'GET', body = null) {
    const options = { method, headers: { 'X-App-Key': this.gcalAppKey, 'Content-Type': 'application/json' } };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`${GCAL_WORKER_URL}${path}`, options);
    return res.json();
}
```

- `createGoogleCalendarEvent(memo)` → `POST /gcal/events`（bodyは既存 `_buildGcalEvent(memo)`）→ 返却 `id`。
- `updateGoogleCalendarEvent(eventId, memo)` → `PUT /gcal/events/${eventId}`。
- `deleteGoogleCalendarEvent(eventId)` → `DELETE /gcal/events/${eventId}`。
- 呼び出し元（saveMemo / handleDrop / deleteMemo の5箇所）は**シグネチャ不変のため無変更**。
- `gcalConnected` は `GET /status` の `linked` で初期化（`init()` 内）。
- 連携ボタン: `window.open(\`${GCAL_WORKER_URL}/oauth/start?key=${encodeURIComponent(this.gcalAppKey)}\`, '_blank')`。連携解除: `Dialog.confirm` → `DELETE /oauth`。
- ステータス文言: 「Googleカレンダー: 連携中（家族で共有）✓ / 未連携」。

### 5.4 予定の取得と日付マッピング

```js
/** 予定を取得して描画（forceで手動同期） */
async loadGcalEvents(force = false) {
    if (!this.gcalAppKey) return;
    try {
        const data = force
            ? await this._gcalRequest('/sync', 'POST')
            : await this._gcalRequest('/events');
        this.gcalEvents = data.events || [];
        localStorage.setItem('gcal_events_cache', JSON.stringify(this.gcalEvents)); // オフライン・初回描画用
        this.renderCalendar();
    } catch (e) { console.error('予定取得エラー:', e); }
}
```

- コンストラクタで `this.gcalEvents = JSON.parse(localStorage.getItem('gcal_events_cache') || '[]')`（キャッシュで即描画）。
- `init()` で `loadGcalEvents()`、引っ張って更新（`refreshData`）で `loadGcalEvents(true)` を並行実行。
- **日付→予定のマップ** `_buildGcalEventMap()`:
  - 終日イベント: `start`〜`end`（endは**排他的**）の各日に展開。
  - 時刻ありイベント: `start` のRFC3339をJSTの日付に変換（`new Date(start)` を+9時間してUTCゲッターで読む、`Utils.getJSTDate` と同じ手法）して1日に割り当てる。
  - **メモ由来の予定を除外**: `this.memos` の `gcalEventId` 集合に `event.id` が含まれるものはスキップ（メモバッジと二重表示になるため）。
  - 繰り返し予定のインスタンスIDは `元ID_20260817T010000Z` 形式になるため、`event.id.split('_')[0]` でもgcalEventId集合と照合する。

### 5.5 マス表示（renderCalendar への追加）

各日付マスの構成（上から）: 日付数字 → メモバッジ（既存） → **予定チップ（新規・最大2件＋「+n」）** → 休日ユーザー（既存・最大3件）。

```html
<!-- 予定チップ（1件分）: 休日ユーザー行と同じ極小スタイル・スカイ系で区別 -->
<div class="calendar-gcal-event flex items-center gap-0.5 rounded-sm bg-sky-500/15 px-0.5
            text-[6px] leading-tight text-sky-300 sm:text-[7px]">
    <span class="truncate">10:00 歯医者</span>
</div>
```

- 表示テキスト: 時刻あり→`HH:MM タイトル`、終日→タイトルのみ。
- 3件以上は `+n` 表示（休日の `+n` と同じ流儀）。
- マスの高さは既存の `min-h-[85px]` のまま。予定＋休日が多い日は詰まるが、詳細はタップで見る設計（既存の休日3件制限と同じ思想）。

### 5.6 日付詳細モーダル（showDateDetail への追加）

「休日」「メモ」セクションの間に「予定（Googleカレンダー）」セクションを追加:

- 各行: `📅 10:00 - 11:00 歯医者`（終日は「終日」表示）、`location` があれば2行目に小さく表示。
- ここでもメモ由来（gcalEventId一致）の予定は除外。

### 5.7 index.html の変更

- `#gcalStatus`（481行〜）: 現状の文言・ボタンはそのまま流用し、`onclick` の遷移先ロジックが変わるのみ。直下にアプリキー入力欄（未設定時のみ表示）を追加:
  「タイマーと同じ合言葉（アプリキー）を入力すると、家族共有のGoogleカレンダー連携が有効になります」＋input＋保存ボタン。

---

## 6. セットアップ手順（一度だけ・ダッシュボード操作のみ）

### 手順1: Google Cloud Console（既存プロジェクトを流用）

既存のOAuthクライアント（GIS用に作成済み、`js/calendar.js` の `GCAL_CONFIG.clientId`）をそのまま使う。

1. https://console.cloud.google.com → 該当プロジェクト → 「APIとサービス」→「認証情報」
2. 既存のOAuth 2.0クライアント（ウェブアプリケーション）を開き、**承認済みのリダイレクトURI**に
   `https://gcal-sync.zinnpei11251818.workers.dev/oauth/callback` を追加して保存
3. 同じ画面の**クライアントID**と**クライアントシークレット**を控える（手順3で使う）
4. **「OAuth同意画面」→ 公開ステータスを「本番」に公開**（Publish App）。
   ⚠️ **最重要**: 「テスト」のままだとrefresh_tokenが**7日で失効**し、毎週再連携になる。
   本番公開すると「Googleによる確認が済んでいない」警告が同意画面に出るが、
   「詳細」→「（アプリ名）に移動」で続行できる（家族利用ならこれで問題ない）

### 手順2: Cloudflare — KVとWorker作成

1. dash.cloudflare.com → 「Storage & Databases」→「KV」→ Create namespace: `kakeibo-gcal`
2. 「Workers & Pages」→「Create」→ Worker名: `gcal-sync`（URLが `gcal-sync.zinnpei11251818.workers.dev` になることを確認）
3. 作成したWorker → Settings → Bindings → Add → KV Namespace:
   Variable name **`GCAL_KV`**（コードと厳密一致）、Namespace: `kakeibo-gcal`

### 手順3: シークレット3つ

Settings → Variables and Secrets → Type: Secret で登録:

| 名前 | 値 |
|---|---|
| `GOOGLE_CLIENT_ID` | 手順1-3で控えたクライアントID |
| `GOOGLE_CLIENT_SECRET` | 同クライアントシークレット |
| `APP_KEY` | 自分で決めるランダムな合言葉（タイマー用と同じ値にしてよい） |

### 手順4: Cron Trigger

Settings → Trigger Events → Add → Cron Trigger: `0 * * * *`（毎時。予定の反映は最長1時間遅れ＋引っ張って更新で即時）

### 手順5: コード配置と動作確認

1. 「Edit code」→ `worker/gcal-sync/worker.js` の中身を貼り付け → Deploy
2. 確認:
   ```bash
   curl -H "X-App-Key: （APP_KEY）" https://gcal-sync.zinnpei11251818.workers.dev/status
   # → {"linked":false,"fetchedAt":null}
   ```
3. ブラウザで `https://gcal-sync.zinnpei11251818.workers.dev/oauth/start?key=（APP_KEY）` を開き、
   Google認可 → 「連携しました」表示を確認
4. `curl .../events` で予定JSONが返ることを確認 → アプリ側実装に着手

---

## 7. 制約・エッジケース

- **表示範囲**: 同期対象は31日前〜93日後。それより外の月を表示すると予定は出ない（休日・メモは従来通り出る）。必要になれば定数を広げるだけ。
- **反映遅延**: GCal側での変更は最長1時間（Cron間隔）遅れる。引っ張って更新で即時同期できる（60秒連打ガードあり）。
- **メモとの二重表示**: アプリ発のメモはgcalEventId照合で予定チップから除外（§5.4）。照合前提のため、**Worker移行後もメモ保存時のgcalEventId記録は必須で維持**する。
- **refresh_tokenの失効**: ユーザーがGoogleセキュリティ設定から連携を取り消すと `invalid_grant` になる。Workerは未連携状態に戻し、アプリは「未連携」表示→再連携ボタンで復旧。
- **KVの結果整合**: 手動同期直後、別リージョンの家族には反映まで最大60秒程度かかることがある（実害は小さい）。
- **プライバシー**: APP_KEYを知る家族全員がprimaryカレンダーの予定を閲覧できる。連携するアカウントは家族共有前提のものにすること。
- **無料枠**: Cron 24回/日＋アプリアクセスでWorkers/KVとも余裕（KV読み書きは1同期あたり数回）。
- **オフライン**: 直近の予定はlocalStorageキャッシュから描画される（更新はオンライン復帰後）。

---

## 8. 検証手順

1. **Worker単体**: §6手順5のcurl検証（401 / status / oauth往復 / events）。
2. **予定表示**: GCalに「終日」「時刻あり」「複数日にまたがる終日」「繰り返し（週次）」の4種を作成し、マス表示と日付詳細の両方で正しい日付・時刻に出ること。繰り返しが各回で表示されること。
3. **メモ書き込み**: メモ（通知ON）作成→GCalに登録されID保存→編集・ドラッグ移動・削除がGCalへ反映。**この間ブラウザでGoogle認証が一度も出ない**こと。
4. **二重表示なし**: 手順3で作ったメモ由来の予定が、予定チップとして重複表示されないこと。
5. **更新系**: GCal側で予定を追加→引っ張って更新で即反映。何もしなければ次のCron（毎時）で反映。
6. **未連携・キー誤り**: アプリキー未設定時の案内表示、誤ったキーで401ハンドリング（トースト）。
7. **回帰**: 休日表示・休日編集・メモバッジ・祝日表示が従来通り。`npm run build:css` 実行済み、SWキャッシュ名更新済み。

---

## 9. 受け入れ基準

- [ ] カレンダーのマスにGoogleカレンダーの予定が表示される（時刻あり=HH:MM付き、終日、複数日、繰り返しに対応）
- [ ] 日付詳細モーダルに予定セクションが表示される
- [ ] Google認証はWorkerセットアップ時の1回のみ。以降どの端末・いつ開いても認証が発生しない
- [ ] メモのGCal登録・更新・削除がWorker経由で動き、ブラウザからgsi/gapiスクリプトのロードが消えている
- [ ] メモ由来の予定が二重表示されない
- [ ] 引っ張って更新で予定が即時同期される
- [ ] 既存機能（休日・メモ・祝日）に回帰がない
- [ ] Workerコードが `worker/gcal-sync/` でリポジトリ管理されている

---

## 10. 実装メモ・将来拡張

- 実装順: ①Workerコード作成＋リポジトリ追加 → ②Google Cloud/Cloudflareセットアップ（§6・ユーザー作業）＋curl検証 → ③アプリ側（削除→差し替え→表示追加の順）→ ④結合テスト（§8）。②が完了するまで③の結合確認はできないが、コード実装自体は先行してよい。
- **将来拡張の下地**:
  - 複数カレンダー対応: KVに `calendarIds` を持ち、syncEventsでループ＋Eventに `calendarId`/色を追加。
  - 家族それぞれのカレンダー: 連携を複数持つ場合は `tokens` をアカウント別キーにする。
  - タイマーWorker（`docs/smarthome-timer-design.md`）とは独立したWorkerとして運用する。統合はどちらも安定してから検討。
