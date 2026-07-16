# kakeibo

家族向けの家計簿・カレンダー・買い物リスト・スマートホーム操作をまとめたWebアプリ。
GitHub Pages（`https://jimpei1125.github.io/kakeibo/`）で公開。

## スタイル（Tailwind CSS）のビルド

UIは Tailwind CSS で構築しています。以前は CDN（`cdn.tailwindcss.com`）を
読み込んでいましたが、本番非推奨・表示のチラつき・実行時生成による速度低下が
あったため、**ビルド済みCSS（`css/tailwind.css`）を配信する方式**に変更しました。

GitHub Pages はビルドを実行しないため、生成物 `css/tailwind.css` は
リポジトリにコミットしています。

### 重要: クラスを変更したら再ビルドする

HTML（`index.html`）や JS（`js/**/*.js`）で **Tailwind のクラスを追加・変更したら**、
必ず以下を実行して `css/tailwind.css` を更新し、コミットしてください。
再ビルドを忘れると、新しいクラスがスタイルに反映されません。

```bash
npm install      # 初回のみ
npm run build:css
```

開発中は監視モードが便利です（保存のたびに自動ビルド）:

```bash
npm run watch:css
```

スキャン対象は `tailwind.config.js` の `content`（`index.html` / `callback.html` /
`js/**/*.js`）です。新しいファイルを追加したらここにも追記してください。

## 主な構成

- `index.html` … 画面のマークアップ（各セクション・モーダル）
- `js/app.js` … アプリ統合・画面遷移
- `js/budget.js` … 家計簿・電卓・CSV入出力
- `js/calendar.js` … 休日カレンダー・メモ・Googleカレンダー連携
- `js/shopping.js` … 買い物リスト
- `js/smarthome.js` / `js/hue.js` … SwitchBot / Philips Hue 操作
- `js/icons.js` … インラインSVGアイコン
- `js/firebase-config.js` … Firestore/認証設定
- `firestore.rules` … Firestore セキュリティルール（家族UID限定・要デプロイ手順は同ファイル参照）
- `sw.js` / `manifest.webmanifest` / `icons/` … PWA（ホーム画面アプリ化・オフライン起動）

## PWA（Service Worker）のキャッシュ運用

`sw.js` が同一オリジンのファイルを stale-while-revalidate 方式でキャッシュします
（キャッシュを即返しつつ裏で最新版を取得し、次回以降に反映）。個々のファイルの
内容更新はバージョンを上げなくても自動的に反映されますが、**`sw.js` の
`APP_SHELL` にファイルを追加・削除したときは `CACHE_VERSION` の値
（例: `kakeibo-v1` → `kakeibo-v2`）を必ず上げてください**。上げないと古いキャッシュが
残り続け、削除したファイルへの参照や新規ファイルの初回キャッシュに支障が出ます。
