# スマートホーム タイマー機能 実装設計書（Cloudflare Worker スケジューラ）

> 対象実装者: **Claude（自走前提）**
> 目的: スマートホーム画面から、エアコン・扇風機などの**ON/OFFタイマー**（一回限り＋毎週繰り返し）を設定できるようにする。
> 方式: 既存の Cloudflare Worker プロキシを**スケジューラに拡張**し、アプリを閉じていても Worker の Cron Trigger が発火してデバイスを操作する。

---

## 0. 前提・環境（必読）

- **完全クライアントサイドのPWA**。GitHub Pages（`https://jimpei1125.github.io/kakeibo/`）で静的配信。常時稼働するサーバーは無い。
- SwitchBot API へのアクセスは既存の Cloudflare Worker プロキシ経由:
  `https://switchbot-proxy.zinnpei11251818.workers.dev/v1.1`（`js/smarthome.js:15`）。
  現在このWorkerは**CORS回避の素通し役**で、認証署名（HMAC-SHA256）はクライアント側 `makeRequest()`（`js/smarthome.js:137`）が生成している。
- **ブラウザ内タイマーは使わない**。スマホでタブがバックグラウンドに回ると `setTimeout` は止まり、PWA の Service Worker にも確実なアラーム機構は無いため。タイマーの発火は**必ずWorker側**で行う。
- **Tailwindはビルド式**。HTML/JSでTailwindクラスを追加・変更したら必ず `npm run build:css` を実行して `css/tailwind.css` を再生成・コミットすること（`README.md` 参照）。
- **Service Worker のキャッシュ名**（`service-worker.js` の `CACHE_NAME`）は、JS/HTMLを変更したら忘れずにバージョンを上げる（現在 `kakeibo-shell-v3`）。
- Worker のコードはこのリポジトリに存在しない。本設計で **`worker/` ディレクトリを新設**してコードを管理下に置く（§4）。デプロイは Cloudflare ダッシュボードから手動（§6）。

---

## 1. 現状分析（js/smarthome.js の構造）

```
SmartHome クラス
  ├─ 認証情報: localStorage('switchbot_token' / 'switchbot_secret')
  ├─ makeRequest(endpoint, method, body)   … HMAC署名を生成してプロキシへfetch
  ├─ loadDevices() → renderDevices()       … 物理デバイス＋赤外線デバイスをカード表示
  ├─ controlDevice()                       … タイプ別に分岐
  │     ├─ Air Conditioner → showAcControl()  … モーダル(#acControlModal)で温度/モード/風量
  │     │     └─ applyAcSettings() … setAll "temp,mode,fan,on" を送信
  │     └─ Fan/Light/TV/Plug → _toggleDevice() … Dialog.chooseでON/OFF選択
  └─ sendCommand(deviceId, command, parameter)
```

UI は `index.html` の `#smartHomeSection`（573行〜）。デバイス一覧は `#irDeviceList`（608行）と `#physicalDeviceList`（613行）、API設定モーダルは `#smartHomeSettingsModal`（870行〜）。

**再利用する資産**: デバイス一覧（`this.devices` / `this.infraredDevices`）、エアコン設定値の概念（`acSettings = {temperature, mode, fanSpeed}`）、モーダル/トースト/ダイアログ部品（`Utils.showModal` / `Dialog.choose` 等）。

---

## 2. 要件

1. スマートホーム画面に**タイマー一覧**と**タイマー追加**UIを設ける。
2. タイマーは以下を設定できる:
   - 対象デバイス（読み込み済みの赤外線デバイス＋Plug/Bot）
   - 動作: **ON / OFF**（エアコンのONは温度・モード・風量つき）
   - 時刻（JST、分単位）
   - 繰り返し: **一回限り**（日付指定）または**毎週**（曜日複数選択）
3. タイマーの**有効/無効切替**と**削除**ができる。
4. アプリを閉じていても発火する（Worker の Cron Trigger が毎分チェック）。
5. 既存のデバイス操作・API設定は現状のまま動き続ける（プロキシの素通し互換を維持）。

---

## 3. 全体設計

```
┌─ ブラウザ(PWA) ─────────────┐      ┌─ Cloudflare Worker ──────────────┐
│ スマートホーム画面             │      │ fetch(request):                   │
│  ├─ 既存: デバイス操作 ───────┼──────┼→ /v1.1/* … SwitchBotへ素通し(既存互換) │
│  └─ 新規: タイマーCRUD ───────┼──────┼→ /schedules … KVを読み書き           │
│      (X-App-Key ヘッダで認可)  │      │    （X-App-Key === env.APP_KEY を検証） │
└──────────────────────────┘      │                                   │
                                   │ scheduled(cron "* * * * *"):       │
        ┌─ SwitchBot API ←─────────┼─ 毎分KVを読み、期限が来たタイマーの      │
        │  (Worker Secretの         │   コマンドを署名付きで送信              │
        │   トークンで署名)          └──────────────────────────────────┘
        └─ Workers KV: キー "schedules" に全タイマーのJSON配列
```

### 3.1 設計判断とその理由

| 判断 | 理由 |
|---|---|
| 既存 `/v1.1/*` 素通しは残す | アプリ側の `makeRequest()` を一切変えずに済む。改修範囲を新機能に閉じ込める |
| Cron発火用にトークン/シークレットを**WorkerのSecret**にも持たせる | Cron発火時はクライアントがいないため署名をWorker側で生成する必要がある |
| `/schedules` は **APP_KEY（自分で決める合言葉）** で認可 | Secretを持ったWorkerは「URLを知っていれば誰でも家電を操作できる」状態になり得る。APP_KEYの検証で第三者の操作を防ぐ |
| KVは**単一キー `schedules`** にJSON配列を丸ごと保存 | タイマーは高々数十件。毎分のCronで1読取、変更時に1書込で済み、KV無料枠（読取10万/日・書込1,000/日）に余裕で収まる |
| 発火判定は「予定時刻から**5分以内**なら発火」＋スロットキーで多重発火ガード | Cronはまれに遅延・スキップする。分の完全一致だけだと取りこぼすため猶予を持たせ、同一スロットの二重発火は `lastFired` で防ぐ |

### 3.2 タイマーのデータ構造（KV: キー `schedules` の配列要素）

```js
{
  id: string,             // crypto.randomUUID()
  deviceId: string,
  deviceName: string,     // 表示用スナップショット
  deviceType: string,     // 'Air Conditioner' | 'Fan' | 'Light' | 'TV' | 'Plug' | ...
  action: 'on' | 'off',
  acSettings: { temperature: number, mode: number, fanSpeed: number } | null, // エアコンON時のみ
  time: 'HH:mm',          // JST
  days: number[],         // 毎週: 0(日)〜6(土)。空配列なら一回限り
  date: 'YYYY-MM-DD' | null, // 一回限りの実行日(JST)。days指定時はnull
  enabled: boolean,
  lastFired: string | null   // 'YYYY-MM-DD HH:mm'。多重発火ガード兼実行履歴
}
```

### 3.3 発火時のコマンド変換（Worker側）

| 条件 | 送信コマンド |
|---|---|
| `action === 'off'` | `{ command: 'turnOff', commandType: 'command', parameter: 'default' }` |
| `action === 'on'` かつ エアコン＋acSettingsあり | `{ command: 'setAll', parameter: '${temperature},${mode},${fanSpeed},on' }` |
| `action === 'on'`（その他） | `{ command: 'turnOn', commandType: 'command', parameter: 'default' }` |

一回限り（`days: []`）のタイマーは発火後に `enabled: false` にする（削除はしない＝一覧で「実行済み」が見える）。

---

## 4. Worker の実装（`worker/switchbot-proxy/worker.js` 新規）

リポジトリに以下を新設する。**このコードでCloudflare上の既存Workerを丸ごと置き換える**（素通しプロキシ互換を含んでいる）。

```js
/**
 * SwitchBot プロキシ + タイマースケジューラ
 * - /v1.1/*    : SwitchBot APIへの素通しプロキシ（既存互換。署名はクライアントが生成）
 * - /schedules : タイマーCRUD（X-App-Key認可、Workers KVに保存）
 * - scheduled(): Cron Trigger(毎分)で期限が来たタイマーを発火（署名はWorkerが生成）
 *
 * 必要なバインディング/シークレット（§6参照）:
 *   KV:      SCHEDULES_KV
 *   Secret:  SWITCHBOT_TOKEN / SWITCHBOT_SECRET / APP_KEY
 */

const SWITCHBOT_API = 'https://api.switch-bot.com';
const KV_KEY = 'schedules';
const FIRE_WINDOW_MIN = 5; // 予定時刻から何分以内なら発火するか（Cron遅延の救済）

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,sign,t,nonce,Content-Type,X-App-Key',
};

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        if (url.pathname.startsWith('/v1.1/')) {
            return proxyToSwitchBot(request, url);
        }
        if (url.pathname === '/schedules' || url.pathname.startsWith('/schedules/')) {
            return handleSchedules(request, url, env);
        }
        return json({ error: 'not found' }, 404);
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(fireDueSchedules(env));
    },
};

// ---------- 共通 ----------

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

// ---------- 素通しプロキシ（既存互換） ----------

async function proxyToSwitchBot(request, url) {
    const upstream = SWITCHBOT_API + url.pathname + url.search;
    const headers = new Headers();
    for (const name of ['Authorization', 'sign', 't', 'nonce', 'Content-Type']) {
        const v = request.headers.get(name);
        if (v) headers.set(name, v);
    }
    const init = { method: request.method, headers };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = await request.text();
    }
    const res = await fetch(upstream, init);
    const body = await res.text();
    return new Response(body, {
        status: res.status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

// ---------- タイマーCRUD ----------

async function handleSchedules(request, url, env) {
    if (request.headers.get('X-App-Key') !== env.APP_KEY) {
        return json({ error: 'unauthorized' }, 401);
    }

    const schedules = JSON.parse(await env.SCHEDULES_KV.get(KV_KEY) || '[]');
    const id = url.pathname.split('/')[2] || null;

    if (request.method === 'GET') {
        return json({ schedules });
    }

    if (request.method === 'POST') {
        const input = await request.json();
        const schedule = sanitizeSchedule(input);
        if (!schedule) return json({ error: 'invalid schedule' }, 400);
        schedule.id = crypto.randomUUID();
        schedule.lastFired = null;
        schedules.push(schedule);
        await env.SCHEDULES_KV.put(KV_KEY, JSON.stringify(schedules));
        return json({ schedule });
    }

    if (request.method === 'PUT' && id) {
        const index = schedules.findIndex(s => s.id === id);
        if (index === -1) return json({ error: 'not found' }, 404);
        const input = await request.json();
        // enabledのみのトグルも、全項目更新も受け付ける
        const merged = { ...schedules[index], ...input, id };
        const schedule = sanitizeSchedule(merged);
        if (!schedule) return json({ error: 'invalid schedule' }, 400);
        schedule.id = id;
        schedule.lastFired = schedules[index].lastFired;
        schedules[index] = schedule;
        await env.SCHEDULES_KV.put(KV_KEY, JSON.stringify(schedules));
        return json({ schedule });
    }

    if (request.method === 'DELETE' && id) {
        const next = schedules.filter(s => s.id !== id);
        if (next.length === schedules.length) return json({ error: 'not found' }, 404);
        await env.SCHEDULES_KV.put(KV_KEY, JSON.stringify(next));
        return json({ ok: true });
    }

    return json({ error: 'method not allowed' }, 405);
}

/** 入力を検証し、保存形へ正規化する。不正ならnull */
function sanitizeSchedule(input) {
    if (!input || typeof input !== 'object') return null;
    const { deviceId, deviceName, deviceType, action, time } = input;
    if (!deviceId || !deviceName || !deviceType) return null;
    if (action !== 'on' && action !== 'off') return null;
    if (!/^\d{2}:\d{2}$/.test(time || '')) return null;

    const days = Array.isArray(input.days)
        ? [...new Set(input.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
        : [];
    const date = days.length === 0 ? input.date : null;
    if (days.length === 0 && !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;

    let acSettings = null;
    if (action === 'on' && input.acSettings && typeof input.acSettings === 'object') {
        const { temperature, mode, fanSpeed } = input.acSettings;
        if ([temperature, mode, fanSpeed].every(Number.isFinite)) {
            acSettings = { temperature, mode, fanSpeed };
        }
    }

    return {
        id: input.id || null,
        deviceId: String(deviceId),
        deviceName: String(deviceName),
        deviceType: String(deviceType),
        action,
        acSettings,
        time,
        days,
        date: date || null,
        enabled: input.enabled !== false,
        lastFired: null,
    };
}

// ---------- Cron発火 ----------

/** 現在のJST情報を返す（Dateを+9hしてUTCゲッターで読む） */
function jstNow() {
    const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    return {
        date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
        minutesOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
        dayOfWeek: d.getUTCDay(),
    };
}

async function fireDueSchedules(env) {
    const raw = await env.SCHEDULES_KV.get(KV_KEY);
    if (!raw) return;
    const schedules = JSON.parse(raw);
    const now = jstNow();
    let dirty = false;

    for (const s of schedules) {
        if (!s.enabled) continue;

        // 今日が対象日か（毎週: 曜日一致 / 一回限り: 日付一致）
        const appliesToday = s.days.length > 0 ? s.days.includes(now.dayOfWeek) : s.date === now.date;
        if (!appliesToday) continue;

        // 予定時刻から FIRE_WINDOW_MIN 分以内か
        const [h, m] = s.time.split(':').map(Number);
        const elapsed = now.minutesOfDay - (h * 60 + m);
        if (elapsed < 0 || elapsed >= FIRE_WINDOW_MIN) continue;

        // 同一スロットの多重発火ガード
        const slotKey = `${now.date} ${s.time}`;
        if (s.lastFired === slotKey) continue;

        try {
            await sendSwitchBotCommand(env, s);
            s.lastFired = slotKey;
            if (s.days.length === 0) s.enabled = false; // 一回限りは実行済みにする
            dirty = true;
        } catch (err) {
            // 失敗時はlastFiredを更新しない＝ウィンドウ内の次のCronで再試行される
            console.error(`タイマー発火失敗 (${s.deviceName} ${s.time}):`, err);
        }
    }

    if (dirty) await env.SCHEDULES_KV.put(KV_KEY, JSON.stringify(schedules));
}

async function sendSwitchBotCommand(env, schedule) {
    let body;
    if (schedule.action === 'off') {
        body = { command: 'turnOff', commandType: 'command', parameter: 'default' };
    } else if (schedule.deviceType === 'Air Conditioner' && schedule.acSettings) {
        const { temperature, mode, fanSpeed } = schedule.acSettings;
        body = { command: 'setAll', commandType: 'command', parameter: `${temperature},${mode},${fanSpeed},on` };
    } else {
        body = { command: 'turnOn', commandType: 'command', parameter: 'default' };
    }

    const headers = await buildSwitchBotAuthHeaders(env.SWITCHBOT_TOKEN, env.SWITCHBOT_SECRET);
    const res = await fetch(`${SWITCHBOT_API}/v1.1/devices/${schedule.deviceId}/commands`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const result = await res.json();
    if (result.statusCode !== 100) {
        throw new Error(`SwitchBot API error: ${result.statusCode} ${result.message}`);
    }
}

/** クライアント側 makeRequest() と同一方式のHMAC-SHA256署名を生成 */
async function buildSwitchBotAuthHeaders(token, secret) {
    const t = Date.now().toString();
    const nonce = crypto.randomUUID();
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(token + t + nonce));
    const sign = btoa(String.fromCharCode(...new Uint8Array(signature)));
    return { Authorization: token, sign, t, nonce };
}
```

あわせて `worker/switchbot-proxy/README.md` に §6 のセットアップ手順の要約と「ダッシュボードのエディタに `worker.js` を貼り付けてデプロイする」旨を書いておく（wranglerを使わない前提の運用メモ）。

---

## 5. アプリ側の実装（js/smarthome.js ＋ index.html）

### 5.1 設定の追加: アプリキー

- `SmartHome` コンストラクタに `this.appKey = localStorage.getItem('switchbot_app_key') || ''` を追加。
- API設定モーダル（`#smartHomeSettingsModal`、`index.html:870`〜）に「タイマー用アプリキー」の入力欄を1つ追加し、`updateToken()` で `switchbot_app_key` として保存する（トークン/シークレットと同じ流儀）。
- アプリキー未設定の間、タイマーカードには案内文（「API設定でアプリキーを登録するとタイマーが使えます」）を表示する。

### 5.2 Workerとの通信メソッド

`makeRequest()` とは別に、`/schedules` 用の軽量メソッドを追加する（署名不要、`X-App-Key` のみ）:

```js
/** タイマーAPI（Worker /schedules）へのリクエスト */
async scheduleRequest(path = '', method = 'GET', body = null) {
    const options = {
        method,
        headers: { 'X-App-Key': this.appKey, 'Content-Type': 'application/json' },
    };
    if (body) options.body = JSON.stringify(body);
    const response = await fetch(`${SWITCHBOT_WORKER_URL}/schedules${path}`, options);
    if (response.status === 401) throw new Error('アプリキーが正しくありません');
    return response.json();
}
```

定数は `SWITCHBOT_PROXY_URL`（`.../v1.1` 付き）と分けて、ベースURL `SWITCHBOT_WORKER_URL = 'https://switchbot-proxy.zinnpei11251818.workers.dev'` を新設する（`/v1.1` はプロキシ用のパス。既存定数はそのまま残す）。

### 5.3 タイマーUI

`#smartHomeDevices` 内、物理デバイスリスト（`index.html:613`）と「API設定」ボタン（617行）の間に**タイマーカード**を追加する:

```
⏰ タイマー                      [＋ 追加]
┌────────────────────────────────────┐
│ ❄️ エアコン  ON 23:00  毎週 月〜金   [有効●] [削除] │
│ 🌀 扇風機    OFF 01:30  7/25(一回)   [無効○] [削除] │
└────────────────────────────────────┘
```

- 一覧描画 `renderSchedules()`: `deviceName`＋アイコン（`DEVICE_ICONS` 流用）、`ON/OFF`（エアコンONは「26℃冷房」のように設定値も添える）、時刻、繰り返し表示（`days` → 「毎週 日月…」/ `date` → 「M/D（一回）」、実行済みは「実行済み」）。有効トグルは `PUT /schedules/:id` で `{enabled}` のみ送る。削除は `Dialog.confirm` を挟んで `DELETE`。
- 追加モーダル `#timerModal`（新規、既存モーダルのマークアップ流儀に合わせる）:
  1. **デバイス選択**: `<select>`。`this.infraredDevices`（remoteType）＋ `this.devices` のうち `Bot`/`Plug` 系を候補にする。デバイス未読み込みなら先に `loadDevices()`。
  2. **動作**: ON / OFF のセグメント切替。
  3. **エアコン設定**（選択デバイスが `Air Conditioner` かつ ON のときだけ表示）: 温度±・モード・風量。`#acControlModal` のUI部品と同じ見た目で縮小版を作る（`acSettings` の概念を流用。DOM IDは `timerAc*` で別に切る＝既存モーダルと同時利用しても衝突しない）。
  4. **時刻**: `<input type="time">`。
  5. **繰り返し**: 「一回限り / 毎週」切替＋曜日チップ（日〜土、複数選択）。一回限りの実行日は「指定時刻が現在より後なら今日、過ぎていれば明日」を自動設定（日付入力は出さずシンプルに保つ。※必要になったら後日拡張）。
  6. 保存 → `POST /schedules` → 一覧再描画。
- `init()` / `loadDevices()` 成功後に `loadSchedules()` を呼び、タイマー一覧を最新化する（アプリキー未設定ならスキップ）。

### 5.4 追加するメソッド一覧（SmartHomeクラス）

| メソッド | 役割 |
|---|---|
| `loadSchedules()` | `GET /schedules` → `this.schedules` → `renderSchedules()` |
| `renderSchedules()` | タイマーカードの一覧HTML生成 |
| `showTimerModal()` / `closeTimerModal()` | 追加モーダルの開閉・初期化 |
| `onTimerDeviceChange()` | デバイス選択変更時、エアコン設定ブロックの表示切替 |
| `setTimerAction(action)` / `adjustTimerTemp(d)` / `setTimerAcMode(m)` / `setTimerAcFan(f)` | モーダル内の入力状態管理 |
| `toggleTimerRepeat(mode)` / `toggleTimerDay(d)` | 繰り返し/曜日チップ |
| `saveTimer()` | 入力検証 → `POST /schedules` → 再描画 |
| `toggleSchedule(id, enabled)` | `PUT /schedules/:id` |
| `deleteSchedule(id)` | 確認ダイアログ → `DELETE /schedules/:id` |
| `scheduleRequest(path, method, body)` | §5.2 |

---

## 6. Cloudflare側のセットアップ手順（Worker初心者向け・ダッシュボード操作のみ）

> wrangler CLI は使わない。全部ブラウザの Cloudflare ダッシュボードで完結する。
> 既にWorker `switchbot-proxy` が動いているので、**アカウントは作成済み**のはず。https://dash.cloudflare.com にログインして始める。

### 手順1: KVネームスペースを作る（タイマーの保存先）

1. 左メニュー **「Storage & Databases」→「KV」** を開く
2. **「Create a namespace」** をクリック
3. 名前に `kakeibo-schedules` と入力して作成

### 手順2: WorkerにKVを紐付ける（バインディング）

1. 左メニュー **「Workers & Pages」** → `switchbot-proxy` を開く
2. **「Settings」タブ →「Bindings」→「Add binding」→「KV namespace」**
3. Variable name: `SCHEDULES_KV`（**コードがこの名前で参照するので厳密に一致させる**）
4. KV namespace: 手順1で作った `kakeibo-schedules` を選択 → 保存

### 手順3: シークレットを3つ登録する

同じ Settings 内の **「Variables and Secrets」→「Add」** で、Type を **Secret** にして以下を登録:

| 名前 | 値 |
|---|---|
| `SWITCHBOT_TOKEN` | SwitchBotアプリで発行したトークン（アプリの設定→アプリバージョンを10回タップ→開発者向けオプション。家計簿アプリのAPI設定に入れているものと同じ値） |
| `SWITCHBOT_SECRET` | 同じくシークレット |
| `APP_KEY` | **自分で決めるランダムな合言葉**。長めのランダム文字列にする（例: パスワード管理アプリで32文字生成、またはPCで `openssl rand -hex 16`）。後で家計簿アプリのAPI設定にも同じ値を入れる |

> **APP_KEYの役割**: 手順3以降、WorkerはSwitchBotのトークンを内部に持つため、`/schedules` を叩けば誰でもタイマーを操作できてしまう。APP_KEYはそれを防ぐ「このアプリだけが知っている合言葉」。URLを知られても操作はできなくなる。

### 手順4: Cron Trigger（毎分起動）を設定する

1. 同じ Settings 内の **「Trigger Events」（または「Triggers」）→「Add」→「Cron Trigger」**
2. Cron式に `* * * * *`（毎分）を入力して保存

> Cron式はUTCで評価されるが、毎分実行なのでタイムゾーンの影響はない。JSTへの変換はWorkerのコード内で行っている。無料プランでもCron Triggerは使える（毎分実行＝1日1,440回で、無料枠の1日10万リクエストに対して余裕）。

### 手順5: Workerのコードを置き換える

1. `switchbot-proxy` のページ右上 **「</> Edit code」** をクリック（オンラインエディタが開く）
2. 既存コードを全選択して削除し、このリポジトリの **`worker/switchbot-proxy/worker.js` の中身を丸ごと貼り付け**
3. 右上 **「Deploy」** をクリック

### 手順6: 動作確認

```bash
# 認可なし → 401 になること
curl -i https://switchbot-proxy.zinnpei11251818.workers.dev/schedules

# APP_KEY付き → {"schedules":[]} が返ること
curl -H "X-App-Key: （手順3で決めた値）" \
     https://switchbot-proxy.zinnpei11251818.workers.dev/schedules
```

最後に、家計簿アプリのスマートホーム画面で**既存のデバイス一覧・操作が今まで通り動くこと**を確認する（素通しプロキシ互換の検証）。その後、アプリのAPI設定モーダルにAPP_KEYを登録すればタイマーUIが有効になる。

---

## 7. 制約・エッジケース

- **KVは結果整合**: アプリからの保存が別リージョンのCronに見えるまで最大60秒程度かかることがある。**「2〜3分以上先」のタイマー設定を前提**とし、保存時に指定時刻が3分未満先ならトースト警告を出す（保存自体は許可）。
- **多重発火**: Cronのat-least-once実行に対して `lastFired`（スロットキー）でガード済み（§4）。
- **発火失敗時**: `lastFired` を更新しないため、5分のウィンドウ内で自動リトライされる。5分を過ぎたら諦める（エアコンONが深夜に遅れて発火し続けるより安全側）。
- **赤外線デバイスの限界**: IR家電は状態が取れないため「すでにONのところにON」も送信される。エアコンの `setAll` / `turnOn` / `turnOff` は冪等なので実害はない。
- **時刻の意味**: すべてJST固定。端末のタイムゾーンには依存しない（Worker側で日本時間として解釈）。
- **無料枠**: Workers 10万req/日（Cron 1,440回＋アプリ操作で余裕）、KV読取10万/日（Cronで1,440回）、KV書込1,000/日（CRUDと発火時のみ）。いずれも問題なし。
- **セキュリティ**: APP_KEYはlocalStorage保存（既存のSwitchBotトークンと同等の扱い）。HTTPSのみ。Worker側でAPP_KEY不一致は401。素通しプロキシ部分は従来通り署名がなければSwitchBot側で拒否される。

---

## 8. 検証手順

1. **Worker単体**: §6手順6のcurl（401/200）。POSTで1件作成→GETで見える→PUT `{enabled:false}`→DELETE。
2. **発火テスト**: 2〜3分後の一回限りタイマーを作成し、実際にデバイスが動くこと・一覧が「実行済み」になることを確認。エアコンON（温度/モード付き）とOFFの両方。
3. **毎週タイマー**: 今日の曜日＋2分後で作成し発火を確認。発火後も `enabled: true` のままであること。
4. **多重発火なし**: 発火後5分間、同じコマンドが再送されないこと（SwitchBotアプリの履歴で確認可能）。
5. **既存機能の回帰**: デバイス一覧表示・エアコンモーダル・ON/OFF操作・温湿度表示が従来通り動くこと。
6. **アプリキー未設定/誤り**: タイマーカードに案内が出ること、誤ったキーでは「アプリキーが正しくありません」となること。
7. **表示**: タイマー0件時の空表示、複数件時の一覧、曜日表示（毎週 月〜金 等）の整形。

---

## 9. 受け入れ基準

- [ ] スマートホーム画面にタイマー一覧・追加・有効/無効・削除のUIがある
- [ ] エアコンは温度・モード・風量つきでON予約できる。扇風機等はON/OFF予約できる
- [ ] 一回限り／毎週（曜日複数）の両方が設定できる
- [ ] アプリ（PWA）を完全に閉じていても指定時刻（±5分以内）に発火する
- [ ] 同一タイマーが同一スロットで二重発火しない
- [ ] 既存のデバイス操作・API設定が回帰なく動く
- [ ] Workerコードが `worker/switchbot-proxy/` でリポジトリ管理されている
- [ ] `npm run build:css` 実行済み・Service Workerのキャッシュ名更新済み

---

## 10. 実装メモ

- 実装順の推奨: ①Workerコード作成＋リポジトリ追加 → ②Cloudflareセットアップ（§6）＋curl検証 → ③アプリ側UI → ④結合テスト（§8）。②が終わるまでアプリ側は着手しない（結合先がないため）。
- Workerの変更はGitHub Pagesのデプロイと独立している。**Workerを先にデプロイしても既存アプリは壊れない**（素通し互換のため）ことを②の段階で必ず確認する。
