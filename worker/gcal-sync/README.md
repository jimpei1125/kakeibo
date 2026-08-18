# gcal-sync Worker

Googleカレンダーの予定を家計簿アプリに同期するCloudflare Worker。
設計・セットアップ手順の完全版は `docs/gcal-sync-design.md` を参照。

## デプロイ方法

wranglerは使わない。Cloudflareダッシュボードで Worker `gcal-sync` を開き、
「Edit code」に `worker.js` の中身を丸ごと貼り付けて Deploy する。
コードを変更したら、このリポジトリと本番Workerの両方を更新すること。

## 必要な設定（ダッシュボード）

| 種別 | 名前 | 内容 |
|---|---|---|
| KV binding | `GCAL_KV` | ネームスペース `kakeibo-gcal` |
| Secret | `GOOGLE_CLIENT_ID` | Google Cloud のOAuthクライアントID |
| Secret | `GOOGLE_CLIENT_SECRET` | 同クライアントシークレット |
| Secret | `APP_KEY` | アプリと共有する合言葉 |
| Cron Trigger | `0 * * * *` | 毎時同期 |

Google Cloud側: OAuthクライアントのリダイレクトURIに
`https://gcal-sync.zinnpei11251818.workers.dev/oauth/callback` を追加し、
OAuth同意画面を**本番公開**すること（テストのままだとrefresh_tokenが7日で失効する）。

## 動作確認

```bash
# 認可なし → 401
curl -i https://gcal-sync.zinnpei11251818.workers.dev/status

# APP_KEY付き → {"linked":false,...}（連携前）
curl -H "X-App-Key: （APP_KEY）" https://gcal-sync.zinnpei11251818.workers.dev/status

# ブラウザで開いてGoogle認可（一度だけ）
# https://gcal-sync.zinnpei11251818.workers.dev/oauth/start?key=（APP_KEY）

# 連携後、予定が返ること
curl -H "X-App-Key: （APP_KEY）" https://gcal-sync.zinnpei11251818.workers.dev/events
```
