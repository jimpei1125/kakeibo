# Google Calendar API 設定ガイド

## 🔑 クライアントIDの設定

`app.js` の `GoogleCalendarAuth` クラスで、取得したクライアントIDを設定してください。

### 設定箇所

`app.js` の約234行目付近：

```javascript
class GoogleCalendarAuth {
    constructor() {
        this.clientId = 'YOUR_CLIENT_ID.apps.googleusercontent.com'; // ← ここを変更
```

### 設定方法

1. Google Cloud Consoleで取得したクライアントIDをコピー
2. `app.js` を開く
3. `YOUR_CLIENT_ID.apps.googleusercontent.com` を実際のクライアントIDに置き換え
4. ファイルを保存

### 例

```javascript
this.clientId = '123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com';
```

---

## ✅ 動作確認

1. ファイルをGitHubにアップロード
2. https://jimpei1125.github.io/kakeibo/ にアクセス
3. カレンダーページを開く
4. 「連携する」ボタンをクリック
5. Googleログイン画面が表示される
6. 権限を許可
7. 「Googleカレンダー連携中」と表示される

---

## 🎯 機能

### 自動同期
- スケジュール作成 → Googleカレンダーに自動追加
- スケジュール編集 → Googleカレンダーも自動更新
- スケジュール削除 → Googleカレンダーからも自動削除

### 連携状態
- 接続中: 緑色のカード、「連携中」表示
- 未接続: グレーのカード、「連携する」ボタン

---

## 🐛 トラブルシューティング

### 「認証に失敗しました」と表示される
- クライアントIDが正しいか確認
- OAuth同意画面でテストユーザーに追加されているか確認
- 承認済みのJavaScript生成元とリダイレクトURIが正しいか確認

### 予定が同期されない
- 「連携する」ボタンで再連携
- ブラウザのコンソールでエラーを確認
- アクセストークンの有効期限が切れている可能性（1時間で期限切れ）

### アクセストークンの更新
現在の実装では、トークンは1時間で期限切れになります。
期限切れ後は再度「連携する」ボタンをクリックして再認証が必要です。

**将来の改善案:**
- リフレッシュトークンを使った自動更新機能の実装
- Cloud Functionsを使ったバックグラウンド同期

---

## 📝 次のステップ

Phase 2が完了したら、Phase 3で以下を実装できます：

1. **Cloud Functions連携**
   - サーバーサイドでの同期
   - リフレッシュトークン管理
   - エラーハンドリング

2. **双方向同期**
   - Googleカレンダーの変更をWebアプリに反映
   - Webhookによるリアルタイム更新

3. **複数カレンダー対応**
   - 個人カレンダー、家族カレンダーなど
   - カレンダー選択機能
