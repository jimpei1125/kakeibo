# 明細読み込み機能 拡張設計書（CSV＋PDF対応）

> 対象実装者: **Sonnet**（自走前提）
> 目的: 現状のCSV取込に加え、**Amazon Mastercard（三井住友カード）発行のPDF利用明細**を読み取れるようにする。
> あわせて「CSV取込」ボタンを「**明細読み込み（CSVなど）**」に文言変更し、**選択ファイルの種類（拡張子）で読み込み挙動を自動で切り替える**。

---

## 0. 前提・環境（必読）

- **完全クライアントサイドのPWA**。GitHub Pages（`https://jimpei1125.github.io/kakeibo/`）で静的配信。サーバー側処理は一切できない → PDF解析は**ブラウザ内**で行う。
- **ビルド無し（ESモジュール＋CDN）**。Firebaseは `https://www.gstatic.com/firebasejs/...` からESMで直接 import している（`js/firebase-config.js`）。**CSPメタタグは無い**ため、CDNからのESM読み込みは既存方針と整合する。
- **Tailwindはビルド式**。HTML/JSでTailwindクラスを追加・変更したら必ず以下を実行して `css/tailwind.css` を再生成・コミットすること（`README.md` 参照）。忘れるとスタイルが反映されない。
  ```bash
  npm install        # 初回のみ
  npm run build:css
  ```
- **Service Worker**（`service-worker.js`）は**同一オリジンのGETのみ**傍受する。CDN（クロスオリジン）は素通りするため、pdf.jsをCDN読み込みしてもSWの影響を受けない。

---

## 1. 現状分析（既存CSV取込の構造）

実装は `js/budget.js` の `export class CSVImporter`（436行〜）に集約されている。UIは `index.html` の `#csvImportModal`（162行〜）。エントリは「その他の機能」シート内のボタン（`index.html:343-344`）→ `app.csvImporter.showModal()`。

### データフロー（重要な設計資産）

```
handleFileSelect(event)
  ├─ _readFile(file)            … エンコーディング自動判定でテキスト取得
  ├─ _sha256(content) → fileHash … 二重取込検出用ハッシュ
  ├─ _parseTransactions(content) … ★ CSV固有のパース
  │     → this.transactions[] と this.payMonth を生成
  └─ _setupImportUI()           … ここから下流は「形式非依存」の共通UI
        └─ _renderAll() → チップ/ツールバー/明細表/プレビュー/取込ボタン

importData()                    … カテゴリ割当済み明細を家計簿へ登録（形式非依存）
  ├─ 二重取込チェック（importHistory × fileHash）
  ├─ _importAsDetails() / _importAsSum()
  ├─ rules 学習（店名→カテゴリ）を保存
  └─ 取込先の月へ表示切替・保存
```

### 中核データ構造（これに合わせれば下流は全て再利用できる）

`this.transactions` は次の配列:

```js
{
  id: number,          // 0始まりの連番
  date: string,        // 表示用の日付。CSVは "2026/07/27" 等。表示時 /^\d{4}[\/\-]/ で年を落とす
  store: string,       // 店名（＝家計簿の小カテゴリー名になる）
  amount: number,      // ★当月支払額（分割・リボは当月分）。円。
  category: string|null, // rules[store] による自動分類。未分類は null
  checked: boolean     // UIの選択状態。初期 false
}
```

`this.payMonth`: `"YYYY-MM"`（取込先の月。UIの月セレクタ初期値）。

### 再利用できる共通部品（変更不要）

- `_setupImportUI` / `_renderAll` / `_renderChips` / `_renderToolbar` / `_renderTable` / `_renderPreview` / `_updateImportButton`
- 選択・割当系: `toggleRow` / `toggleAll` / `selectUnassigned` / `assignChip` / `assignNewCategory` / `clearCategory`
- 取込実行: `importData` / `_importAsDetails` / `_importAsSum`
- ユーティリティ: `_parseAmount`（`[,¥円\s]` を除去して数値化。全角数字は数値化されない＝カウント列と区別できる）、`_detectPayMonth`、`_sha256`、`_recordImport`、`_saveRules`
- `Utils.escapeHtml/formatCurrency/generateId/getMonthKey/getJSTDate/getTodayString`、`Dialog.confirm`（すべて既存）

> **設計の核心**: PDF対応で新規に書くのは「**ファイル → `transactions[]` ＋ `payMonth` を作る部分だけ**」。それ以外は 100% 流用する。

---

## 2. 要件

1. **明細読み込みボタンの文言変更**: 「CSV取込」→「**明細読み込み（CSVなど）**」。モーダル内のファイル選択ボタン・タイトル・注記も明細読み込み前提の表現に更新。
2. **ファイル種別による自動分岐**: `.csv` は従来通り。`.pdf` は新規のPDF明細パーサで処理。ユーザーは1つのファイル入力から両方を選べる。
3. **Amazon Mastercard（三井住友カード）PDF明細の取込**: 添付サンプル形式を確実に解析し、当月支払額ベースで `transactions[]` を生成する。
4. 既存のカテゴリ自動分類・二重取込検出・登録方法（明細/合計）・月自動判定は**そのまま活かす**。

---

## 3. 全体設計方針

**既存 `CSVImporter` クラスを拡張**して両形式を扱う（新クラスを分けない）。理由: 下流UI/取込ロジック/状態/ルール学習/履歴を丸ごと共有でき、改修範囲・リスクが最小になるため。

- クラス名・DOM ID・`app.csvImporter` などの**内部識別子は変更しない**（widescale rename を避け、差分と回帰リスクを最小化）。変更するのは**ユーザーに見える文言**と**分岐ロジック**のみ。
- `handleFileSelect` を「拡張子で分岐するディスパッチャ」に変更する。

```
handleFileSelect(event)
  ├─ .csv →  _readFile → _sha256 → _parseTransactions          （既存）
  └─ .pdf →  _readPdfStatement(file)                            （新規）
              ├─ fileHash = _sha256(ArrayBufferのhex or 抽出テキスト)
              ├─ _parsePdfStatement(textItems) → transactions[] / payMonth
  → どちらも最後に _setupImportUI() を呼ぶ（共通）
```

---

## 4. 解析対象PDFの仕様（三井住友カード「お支払い明細」＝Amazon Mastercard）

添付サンプルを pdf.js で抽出した結果（実測）。**テキストPDF**であり、pdf.js の `getTextContent()` で座標付きテキストが**数字含め正確に**取得できることを確認済み。

### 4.1 ヘッダー領域（抜粋・y座標降順＝上から）

```
2026年7月27日のお支払い明細
2026年7月10日 発行
お名前  木村 仁平 様   金融機関 ＰａｙＰａｙ銀行
お支払い日 2026年7月27日 （月） 支店 はやぶさ支店   ← ★payMonth の源泉
科目 普通
お支払い合計額
54,739 円                                          ← ★総額（検算用）
Amazonﾏｽﾀｰ                                          ← カード名称
8001030811546331                                    ← お問合せ番号
2018年9月5日  加入・切替日
```

### 4.2 明細テーブル

ヘッダー行（複数y行に分かれて描画される）:
```
ご利用日 / ご利用店名 / お支払い金額 / ご利用金額 / 区分 / 回数 / 今回(回数) / 備考
現地通貨額 / 略称 / 換算レート / 換算日     （海外利用時のみ）
```

データ行（実測、左→右の順にトークンが並ぶ）:
```
26/05/31  インターネットイニシアティブ      7,493    １  １  7,493
26/06/15  回収事務手数料                    495      １  １  495    ５月分
26/06/29  ＡｍａｚｏｎＰａｙ提携サイト        20,000   １  １  20,000  ＡＭＺ＊ＣＹＧＡＭＥＳ ＷＥＢＳＴＯＲＥ
26/06/30  ＡｍａｚｏｎＰａｙ提携サイト        10,000   １  １  10,000  ＡＭＺ＊ＣＹＧＡＭＥＳ ＷＥＢＳＴＯＲＥ
26/06/30  イオンリテール                    4,296    １  １  4,296
25/11/21  ＡＭＡＺＯＮ．ＣＯ．ＪＰ           132,103  １２ ８  11,008          ← ★分割払い
遅延損害金（ショッピング利用）              1,447                              ← ★日付なしの特殊行
＜お支払金額総合計＞                         54,739                            ← ★合計行（取込対象外・検算用）
```

### 4.3 列の意味（左→右）

| 列 | 例(通常) | 例(分割) | 備考 |
|----|---------|---------|------|
| ご利用日 | `26/05/31` | `25/11/21` | `YY/MM/DD`。半角。全行の先頭に出る（特殊行を除く） |
| ご利用店名 | インターネットイニシアティブ | ＡＭＡＺＯＮ．ＣＯ．ＪＰ | 全角混在。空白を含むことがある |
| ご利用金額(総額) | `7,493` | `132,103` | 半角・カンマ区切り。**分割時は購入総額** |
| 支払区分/回数 | `１` | `１２` | **全角数字**（＝金額と区別可能） |
| 今回回数 | `１` | `８` | 全角数字 |
| **お支払い金額(当月)** | `7,493` | `11,008` | 半角・カンマ。**★これを amount に採用** |
| 備考 | （空） | （空） | `５月分`, `◎` 等が入ることがある |

**検算**: `7,493 + 495 + 20,000 + 10,000 + 4,296 + 11,008 + 1,447 = 54,739 = ＜お支払金額総合計＞ = お支払い合計額`。
→ **当月支払額（各行の最後の半角金額）を合計すると総合計に一致**する。これを取込後の検証に使う。

### 4.4 特殊行

- **遅延損害金（ショッピング利用）**: 日付なし・店名＋金額のみ。`store="遅延損害金（ショッピング利用）"`, `amount=1447`, `date=""`（または お支払い日）として1件計上する。
- **回収事務手数料**: 日付あり通常行と同形。備考に `５月分`。通常行として扱えばよい。
- **合計行 `＜お支払金額総合計＞` / `お支払い合計額`**: **取込対象外**。検算にのみ使う。

---

## 5. パースアルゴリズム（`_parsePdfStatement`）

pdf.js の各テキストアイテムは `item.str` と `item.transform`（`transform[4]=x, transform[5]=y`）を持つ。以下の手順で堅牢に解析する。

### 5.1 行の再構成

1. 全ページの `textContent.items` を集める（本明細は1ページだが複数ページ化に備え全ページ走査）。
2. `y = Math.round(item.transform[5])` でグルーピング。近接（±2px）は同一行とみなす。
3. 各行内は `x` 昇順に並べ、`item.str` を**そのまま連結**して行テキストを得る（独自の区切り文字は挿入しない。理由は下記コラム参照）。
4. 行は **y 降順**（＝紙面の上から下）で処理する。
5. `tokens` は連結後のテキストを空白（`\s+`）で分割して得る。

> pdf.js が数字・カンマ・全角を正しく返すことは実測済み。CID/ToUnicodeの心配は不要。

> #### ⚠️ 実装で判明した2つの罠（設計時の想定から修正済み。要注意）
>
> **① 康熙部首（Kangxi Radicals）への字形すり替え**
> このPDFのフォントは、一部の漢字（`日 月 支 金 手 用 目 行 人 入 大 非 示 長` 等）を、見た目は同じだが**意味的に異なる**Unicodeの部首ブロック（`U+2E80-2EFF` CJK Radicals Supplement, `U+2F00-2FDF` Kangxi Radicals）のコードポイントで埋め込んでいる（例: `月`→`⽉` U+2F49、`金`→`⾦` U+2FA6）。これは**フォント/PDF生成側の癖**であり、`NFKC` 等の標準Unicode正規化では復元できない（部首ブロックは対象の漢字への互換分解を持たない）。
> このため `お支払い日`・`遅延損害金` のような固定文言の正規表現マッチが、正規化せずに実装すると**静かに失敗する**（`金`→`⾦`により「遅延損害金」の判定が外れ、当該行が明細から欠落する、など）。
> **対策**: 実測で確認した該当文字の対応表（`KANGXI_RADICAL_TO_KANJI`）で該当ブロックの文字を通常の漢字に変換してから、あらゆる判定・抽出を行う。将来別のPDFで未知の部首文字が出てきた場合は、同様に実測して対応表に追加する。
>
> **② 単語内で pdf.js のテキストアイテムが分割される**
> 同じ単語（例: 「手数料」）でも、フォントの字送り調整（カーニング）によって pdf.js が複数の `TextItem` に分割して返すことがある（実測: 「手数料」が `"回収事務"` / `"⼿"` / `"数料"` の3アイテムに分割）。設計時の想定（`item.str` を毎回スペース1つで連結）ではこの内部分割箇所に**余計な空白が入り**、店名が `"回収事務 手 数料"` のように壊れてしまう。
> 一方で pdf.js は実際の列区切り（本来の空白）についても**リテラルな空白文字を含むテキストアイテム**として返しており、その空白アイテムの `width` は文字幅よりずっと大きい（実測: 通常文字の width≈7.6 に対し、列区切りの空白アイテムは width≈100〜240）。
> **対策**: 独自の区切り文字を挿入せず、`item.str` を**そのまま**連結する。pdf.js が返す空白はそのまま列区切りとして機能するため、連結結果を `\s+` で分割するだけで正しい列（トークン）が得られる。あわせて、稀に混入する非表示の制御文字（実測: `\u0001`。字送り専用のグリフ）を `[\x00-\x1f]` で除去する。

### 5.2 各行の分類と抽出

行テキスト（またはトークン配列）に対して:

- **日付トークン**: `/^\d{2}\/\d{2}\/\d{2}$/` にマッチする最初のトークン。`26/05/31` → `2026/05/31`（`YY` は `20YY` に補完）。
- **当月支払額**: 行内で `/^\d{1,3}(?:,\d{3})*$/`（半角・カンマ区切りの整数）にマッチするトークンのうち**最後のもの**。
  - カウント列（`１`,`１２`,`８`）は**全角数字**なのでこの正規表現にマッチせず、自然に除外される。
  - 備考 `５月分` も全角なので除外される。
- **店名**: 日付の次のトークンから、最初の半角金額トークンの手前までを連結。前後空白を trim。

**行タイプ判定:**

| 条件 | 処理 |
|------|------|
| 日付トークンあり かつ 半角金額あり | 通常明細 → `{date, store, amount=当月支払額}` を push |
| 日付なし かつ 行頭が `遅延損害金` | 特殊行 → `{date:"", store:行の非数値部分, amount=半角金額}` を push |
| `＜お支払金額総合計＞` / `お支払い合計額` / `お支払い日` を含む | 取込せずメタ情報として保持（total, payDate） |
| 上記以外（ヘッダー・住所・カード名等） | 無視 |

**除外すべき既知の非明細行**: `木村 … 様 … ご利用分`（カード名義サブヘッダ。`5334-91**-****-****` のようなマスク番号を含む）、`ご利用日`/`ご利用店名`/`現地通貨額` を含むヘッダー行、`※`で始まる注記、`三井住友カード株式会社`以降のフッター。
→ 「日付＋半角金額の両方を持つ行」だけを通常明細に採用すれば、これらは自動的に落ちる。特殊行は `遅延損害金` の明示判定のみ許可する。

### 5.3 payMonth の決定

`お支払い日 2026年7月27日` を正規表現 `お支払い日\s*(\d{4})年(\d{1,2})月(\d{1,2})日` で抽出し、`payMonth = Utils.getMonthKey(2026, 7)`（=`"2026-07"`）とする。
- 取れない場合は既存 `_detectPayMonth([])` のフォールバック（今月）に委譲。
- あわせて総合計を検算用に保持する。**総合計の金額は「＜お支払金額総合計＞ 54,739」のようにラベルと同じ行にまとまって出現する**（一方「お支払い合計額」という見出しは、実測では金額と別の行に分かれて描画されており、同一行前提の正規表現では拾えない）。そのため正規表現は `＜お支払金額総合計＞[^\d]*([\d,]+)` を用いる。
- **取込プレビュー時に「明細合計 == 総合計」を検算**、不一致なら注意トーストを出す（取込は妨げない）。

### 5.4 category 初期割当

CSVと同じく `category: this.rules[store] || null`。

### 5.5 （任意・推奨度中）全角→半角正規化

店名の見栄え・ルール一致率向上のため、店名に対し全角英数記号→半角の正規化を行うヘルパーを用意してもよい。ただし**既存CSVで学習済みのルールキーと不一致になり得る**ため、既定はOFF（抽出テキストそのまま）で実装し、必要なら別タスクで有効化する。

---

## 6. pdf.js の導入方式

### 6.1 方針: **CDNから遅延読み込み（lazy import）**

- 既存のFirebase同様、ESMを**CDNから直接 import**する。**PDFが選択された瞬間に初めて動的 import** し、初期ロードを重くしない。
- バージョンは pdfjs-dist を**明示ピン**（例: `6.1.200` で実測済み。実装時は当時の安定版で可）。
- **worker** は同一バージョンの worker を `GlobalWorkerOptions.workerSrc` に設定する。

```js
// budget.js 内。モジュール先頭の static import は使わず、必要時に動的 import する。
let _pdfjsPromise = null;
function loadPdfJs() {
  if (!_pdfjsPromise) {
    const VER = '6.1.200';
    const base = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VER}/build`;
    _pdfjsPromise = import(`${base}/pdf.min.mjs`).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${base}/pdf.worker.min.mjs`;
      return pdfjs;
    });
  }
  return _pdfjsPromise;
}
```

> **代替案（オフライン重視なら）**: pdf.js を `js/vendor/` に**同梱（vendoring）**し、`service-worker.js` の `APP_SHELL` に加えてSWキャッシュ対象にする。オフラインでもPDF取込が可能になる反面、リポジトリに約1MB追加・バージョン更新が手作業になる。**既定はCDN遅延読み込み**を採用（Firebase等と同じ方針・追加ファイル無し）。オフラインPDF取込は現状スコープ外とし、CDN到達不可時は「オンラインで再試行してください」と案内する。

### 6.2 テキスト抽出コア

> §5.1コラムの2つの罠（康熙部首の字形すり替え／単語内でのアイテム分割）を踏まえた**実装版**（`js/budget.js` の実コードと同一）。

```js
async _extractPdfLines(buf) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
  const lines = []; // { y:number, text:string, tokens:string[] }

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const byY = new Map();

    for (const item of tc.items) {
      if (!item.str) continue;
      // 康熙部首の字形を通常の漢字に正規化し、制御文字を除去する。
      // 空白文字（実際の列の区切り）はここでは捨てずに残す。
      const s = normalizeKangxiRadicals(item.str).replace(/[\x00-\x1f]/g, '');
      if (!s) continue;
      const y = Math.round(item.transform[5]);
      let key = y;
      for (const k of byY.keys()) { if (Math.abs(k - y) <= 2) { key = k; break; } }
      if (!byY.has(key)) byY.set(key, []);
      byY.get(key).push({ x: item.transform[4], s });
    }

    for (const [y, arr] of byY) {
      arr.sort((a, b) => a.x - b.x);
      // pdf.jsが返す空白文字は実際の列の区切りをそのまま表しているため、
      // 独自の区切り文字を挿入せずに連結する（挿入すると単語の途中に
      // 余分な空白が入ってしまう。例:「手数料」が複数グリフに分割されている場合）。
      const text = arr.map(a => a.s).join('').replace(/\s+/g, ' ').trim();
      const tokens = text.split(/\s+/).filter(Boolean);
      if (tokens.length) lines.push({ y, text, tokens });
    }
  }

  lines.sort((a, b) => b.y - a.y); // 上から下
  return lines;
}
```

---

## 7. 実装詳細（ファイル別）

### 7.1 `index.html`

1. **エントリボタンの文言変更**（`index.html:343-344` 付近）:
   - 「CSV取込」→「**明細読み込み（CSVなど）**」。アイコン(`upload`)は流用可。
2. **モーダル（`#csvImportModal`）**:
   - タイトル（164行）「CSVインポート」→「**明細読み込み**」。
   - ファイル選択 `<input type="file" id="csvFileInput" ...>`（171行）の `accept` に PDF を追加:
     ```html
     accept=".csv,.pdf,text/csv,application/csv,text/comma-separated-values,application/pdf"
     ```
   - ファイル選択ボタン文言（174行）「CSVファイルを選択」→「**ファイルを選択（CSV / PDF）**」。
   - 注記（177行）を「※ クレジットカードの利用明細（PayPayカード等のCSV、Amazon Mastercard等のPDF）を選択してください」に更新。
   - 取込ボタンや設定UI（`#csvImportSetup` 配下）は**変更不要**（形式非依存）。
3. **DOM ID は変更しない**（`csvImportModal`/`csvFileInput`/`csvImportSetup`/`csvImportMonth`/`csvImportBtn` 等はそのまま）。
4. Tailwindクラスを新規追加した場合は **`npm run build:css` を実行**して `css/tailwind.css` を更新・コミット。

> 文言だけの変更で新規クラスを増やさなければ、CSS再ビルドは不要。増やしたら必須。

### 7.2 `js/budget.js`（`CSVImporter` 拡張）

**(a) 動的ローダを追加**（クラス外、ファイル上部の適切な位置）: 上記 `loadPdfJs()`。

**(b) `handleFileSelect` をディスパッチャ化**（既存 567-599 を置換）:

```js
async handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const nameEl = document.getElementById('csvFileName');
  if (nameEl) { nameEl.textContent = `選択されたファイル: ${file.name} (${(file.size/1024).toFixed(1)}KB)`; nameEl.style.display = 'block'; }

  const lower = file.name.toLowerCase();
  try {
    if (lower.endsWith('.pdf')) {
      Utils.showToast('PDF読み込み中...');
      await this._handlePdfFile(file);
    } else if (lower.endsWith('.csv')) {
      Utils.showToast('CSV読み込み中...');
      const content = await this._readFile(file);
      this.fileHash = await this._sha256(content);
      this._parseTransactions(content);
    } else {
      Utils.showToast('CSVまたはPDFファイルを選択してください', 'error');
      return;
    }
    this._setupImportUI();
    const autoAssigned = this.transactions.filter(t => t.category).length;
    Utils.showToast(autoAssigned > 0
      ? `${this.transactions.length}件読み込み（${autoAssigned}件を自動分類）`
      : `${this.transactions.length}件読み込みました`);
  } catch (error) {
    console.error('明細読み込みエラー:', error);
    Utils.showToast(`ファイルの読み込みに失敗しました: ${error.message}`, 'error');
    this._resetImportState();
  }
}
```

**(c) PDF処理を追加**:

```js
async _handlePdfFile(file) {
  const buf = await file.arrayBuffer();
  this.fileHash = await this._sha256Bytes(buf); // ArrayBufferを直接ハッシュ化（バイト列ベース）
  const lines = await this._extractPdfLines(buf);
  this._parsePdfStatement(lines);
}

async _sha256Bytes(buf) {
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
```

- `_sha256`（文字列用・CSVで使用）とは別に `_sha256Bytes`（`ArrayBuffer`用・PDFで使用）を用意する。二重取込検出（`importHistory`）にそのまま乗る。

**(d) `_parsePdfStatement(lines)` を実装**（§5のアルゴリズム。§5.1コラムの罠を反映した最終版）:

```js
_parsePdfStatement(lines) {
  const isSmbc = lines.some(l => /お支払い明細|三井住友カード|お支払い合計額/.test(l.text));
  if (!isSmbc) throw new Error('対応していないPDF形式です（三井住友カード/Amazon Mastercardの明細PDFを選択してください）');

  const MONEY = /^\d{1,3}(?:,\d{3})*$/;
  const DATE  = /^\d{2}\/\d{2}\/\d{2}$/;
  const txs = [];
  let total = null, payMonth = null;

  for (const { text, tokens } of lines) {
    // メタ情報
    const pay = text.match(/お支払い日\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (pay) payMonth = Utils.getMonthKey(parseInt(pay[1]), parseInt(pay[2]));
    // 「＜お支払金額総合計＞ 54,739」のようにラベルと金額が同じ行にまとまって出現する
    const grand = text.match(/＜お支払金額総合計＞[^\d]*([\d,]+)/);
    if (grand) total = this._parseAmount(grand[1]);
    if (/＜お支払金額総合計＞/.test(text)) continue; // 合計行は明細にしない

    const moneyTokens = tokens.filter(t => MONEY.test(t));
    const dateTok = tokens.find(t => DATE.test(t));

    if (dateTok && moneyTokens.length) {
      // 通常明細
      const amount = this._parseAmount(moneyTokens[moneyTokens.length - 1]); // 当月支払額
      if (!amount) continue;
      const dateIdx = tokens.indexOf(dateTok);
      const moneyIdx = tokens.indexOf(moneyTokens[0]);
      const store = tokens.slice(dateIdx + 1, moneyIdx).join(' ').trim();
      if (!store) continue;
      txs.push({ id: txs.length, date: this._normPdfDate(dateTok), store, amount,
                 category: this.rules[store] || null, checked: false });
    } else if (/^遅延損害金/.test(text) && moneyTokens.length) {
      const amount = this._parseAmount(moneyTokens[moneyTokens.length - 1]);
      const store = text.replace(/\s*[\d,]+\s*$/, '').trim();
      if (amount) txs.push({ id: txs.length, date: '', store, amount,
                             category: this.rules[store] || null, checked: false });
    }
  }

  if (!txs.length) throw new Error('有効な明細が見つかりませんでした');
  this.transactions = txs;
  this.payMonth = payMonth || this._detectPayMonth([]);
  // 検算: 明細合計と総合計の一致確認（不一致でも取込自体は継続する）
  if (total != null) {
    const sum = txs.reduce((s, t) => s + t.amount, 0);
    if (Math.abs(sum - total) >= 1) {
      Utils.showToast(`注意: 明細合計(¥${Utils.formatCurrency(sum)})と総合計(¥${Utils.formatCurrency(total)})が一致しません`, 'error');
    }
  }
}

_normPdfDate(yymmdd) {          // "26/05/31" → "2026/05/31"
  const [y, m, d] = yymmdd.split('/');
  return `20${y}/${m}/${d}`;
}
```

**(e) `_extractPdfLines` を実装**（§6.2）。

> `_parseTransactions`（CSV）・下流UI・`importData` は**一切変更しない**。`date` を `2026/05/31` 形式にしておくことで、既存 `_renderTable` の `t.date.replace(/^\d{4}[\/\-]/, '')`（年を落として `05/31` 表示）とも整合する。

### 7.3 `js/app.js` / `service-worker.js`

- **`app.js` は変更不要**（`csvImporter` の生成・`init()` 呼び出しはそのまま）。
- **`service-worker.js` は変更不要**（CDNは素通り）。オフライン対応をする場合のみ vendoring 案を採る（スコープ外・§6.1代替案）。

---

## 8. テスト計画

### 8.1 サンプルPDF（添付）での期待値

`お支払い日 2026年7月27日` → `payMonth = "2026-07"`。抽出される明細（7件）と当月支払額:

| date | store | amount |
|------|-------|-------:|
| 2026/05/31 | インターネットイニシアティブ | 7,493 |
| 2026/06/15 | 回収事務手数料 | 495 |
| 2026/06/29 | ＡｍａｚｏｎＰａｙ提携サイト | 20,000 |
| 2026/06/30 | ＡｍａｚｏｎＰａｙ提携サイト | 10,000 |
| 2026/06/30 | イオンリテール | 4,296 |
| 2026/11/21相当(25/11/21) → 2025/11/21 | ＡＭＡＺＯＮ．ＣＯ．ＪＰ | 11,008 |
| （空） | 遅延損害金（ショッピング利用） | 1,447 |

- **合計 = 54,739**、`お支払い合計額`(54,739) と一致 → 検算パス。
- 分割行は購入総額132,103ではなく**当月分11,008**が採用されること（最重要）。

### 8.2 手動E2E

1. 「その他の機能」→「明細読み込み（CSVなど）」→ モーダル表示。
2. サンプルPDFを選択 → 「7件読み込みました」トースト、取込設定UI表示、月セレクタ=2026-07。
3. 明細に店名・日付・金額が正しく並ぶ。カテゴリを割当→プレビュー集計→インポート→家計簿の2026年7月に反映。
4. 同じPDFを再選択→**二重取込警告**が出る（`fileHash`＋`importHistory`）。
5. 従来のCSV（PayPayカード等）が**従来通り**動く（回帰無し）。
6. 非対応PDF（他社明細等）→「対応していないPDF形式です」で安全に失敗。

### 8.3 開発中の抽出検証（任意・参考）

Nodeで `pdfjs-dist` を使い抽出結果を目視できる（本リポジトリのビルドとは無関係の検証用）:
```bash
npm i pdfjs-dist
node -e "..."  # getDocument→getTextContent で y でグルーピングして行表示
```

### 8.4 実施済み検証（本実装で完了）

以下は実装時に実際に行い、**全て合格**した。

- **Node単体検証**: `_extractPdfLines`/`_parsePdfStatement` と同一ロジックを `pdfjs-dist`（npm経由）でNode上に移植し、添付サンプルPDFに対して実行。§8.1の7件・`payMonth=2026-07`・合計54,739=総合計と**完全一致**を確認。
- **実ブラウザE2E（Playwright）**: 本物の `index.html`/`js/budget.js` をローカルサーバーで配信し、Chromiumで実行。この開発環境の egress プロキシは一般的なCDN（jsdelivr/gstatic/unpkg等）へのアクセスをポリシーでブロックするため、`page.route()` で `https://cdn.jsdelivr.net/npm/pdfjs-dist@6.1.200/build/**` へのリクエストを npm 経由でインストール済みのローカル pdf.js ファイルに差し替えて検証した（本番のGitHub Pages利用者は実際のCDNに直接アクセスするため、この制約の影響は受けない。既存のFirebaseもgstatic CDNから同様に読み込んでおり、実運用で機能している）。
  - モーダルを開きサンプルPDFを選択 → 7件読み込み、月セレクタ`2026-07`、明細一覧の内容が§8.1と一致。
  - 全選択→新規カテゴリ「カード引落」を割当→インポート実行 → 家計簿`2026-07`に小カテゴリー7件（合計54,739）として反映、店名→カテゴリのルールが学習される。
  - 同じPDFを再選択（学習済みルールにより自動分類）→インポート実行 → カスタムDialog（`Dialog.confirm`）による二重取込警告が表示され、「続行」で取込続行、取込履歴が2件に増加。
  - 従来のサンプルCSV（PayPayカード形式）を選択 → 3件・当月お支払日から`payMonth`自動判定、**従来通り動作**（回帰なし）。
  - 三井住友カード以外の体裁のPDFを選択 → 「対応していないPDF形式です」でエラートースト、クラッシュなし。
  - 不正なPDF（破損ファイル）を選択 → pdf.js側のエラーがそのままエラートーストとして表示され、クラッシュなし。
  - モーダルのスクリーンショットで文言・レイアウト崩れが無いことを目視確認。

---

## 9. 受け入れ基準（Definition of Done）

- [x] エントリボタンが「明細読み込み（CSVなど）」表記になっている。
- [x] `.csv` は従来の挙動を維持（回帰なし）。
- [x] `.pdf`（三井住友/Amazon Mastercard）で §8.1 の7件・payMonth=2026-07 が得られる。
- [x] 分割払い行は**当月支払額**が採用される。
- [x] 遅延損害金の特殊行が1件として取り込まれる。
- [x] 明細合計と総合計の検算が行われ、不一致時に警告が出る。
- [x] 二重取込検出・カテゴリ自動分類・登録方法(明細/合計)・月自動判定が PDF でも機能する。
- [x] 非対応PDF・空PDF・破損PDFでクラッシュせずエラートーストで終わる。
- [x] 新規Tailwindクラスを追加した場合、`css/tailwind.css` を再ビルド＆コミット済み（本実装は文言変更のみでクラス追加無し、再ビルド不要）。

> **実装ステータス: 完了・検証済み**（§8.4）。§5.1コラムに記載の2つの罠（康熙部首の字形すり替え／単語内でのアイテム分割）は実装中に発見し、対策済み。

---

## 10. リスクと留意点

1. **カード会社ごとにPDFレイアウトが異なる**: 本設計は三井住友カード（Amazon Mastercard発行元）フォーマット専用。将来他社対応する場合は `_parsePdfStatement` をフォーマット検出→各パーサに分岐する形へ拡張する（`isSmbc` 判定を分岐点として設計済み）。
2. **座標グルーピングの閾値**: 行判定の y 許容（±2）はフォント/明細で微調整の余地。ヘッダーが複数y行に割れる点に注意（データ行は1行に揃うことを実測済み）。
3. **全角/半角**: 金額は半角・カウントは全角という差を列判定に利用している。将来フォーマットで金額が全角になると破綻するため、フォーマット固有の前提としてコメントを残すこと。
4. **オフライン**: CDN遅延読み込みのためオフラインではPDF取込不可（CSVは可）。必要になれば §6.1 代替案（vendoring＋SWキャッシュ）へ。
5. **pdf.js worker/CORS**: `workerSrc` を同一CDN・同一バージョンに合わせること。バージョン不一致はworkerロード失敗の典型原因。
6. **スキャンPDF（画像）非対応**: 本機能はテキストPDF前提（サンプルはテキストPDFで確認済み）。画像PDF（OCRが必要）はスコープ外とし、「テキストが抽出できません」で失敗させる。

---

## 付録A: 変更ファイル一覧

| ファイル | 変更 |
|---------|------|
| `index.html` | ボタン/タイトル/注記の文言、`accept` にPDF追加（DOM IDは不変） |
| `js/budget.js` | `loadPdfJs`/`normalizeKangxiRadicals`/`_extractPdfLines`/`_handlePdfFile`/`_sha256Bytes`/`_parsePdfStatement`/`_normPdfDate` 追加、`handleFileSelect` を分岐化、月ヒント文言を形式非依存に変更 |
| `css/tailwind.css` | 新規クラス追加時のみ再ビルド |
| （不変） | `js/app.js`, `service-worker.js`, 下流UI・`importData` 系 |

## 付録B: 実装順序（Sonnet自走チェックリスト）

1. `index.html` の文言・`accept` 変更（DOM IDは触らない）。必要なら `npm run build:css`。
2. `budget.js`: `loadPdfJs` と `_extractPdfLines` を追加し、まず抽出行を `console.log` して添付PDFで §8.1 の行が出ることを確認。
   - ここで康熙部首の字形すり替え（§5.1コラム①）と単語内アイテム分割（§5.1コラム②）に遭遇するはずなので、`normalizeKangxiRadicals` と「独自区切りを挿入しない連結」で対処する。
3. `_parsePdfStatement` を実装し、7件・payMonth・検算が合うことを確認（本実装ではNode単体検証＝§8.4で確認済み）。
4. `handleFileSelect` を分岐化し、`_handlePdfFile`（PDF用 `_sha256Bytes` 含む）を接続。
5. E2E（§8.2/§8.4）を通し、CSV回帰が無いことを確認。
   - この開発環境では一般CDNへの外部アクセスが遮断されているため、実ブラウザで検証する場合は Playwright の `page.route()` で pdf.js のCDN URLをローカルファイルに差し替えるとよい（§8.4参照）。
6. コミット（`css/tailwind.css` 再ビルドが必要なら含める）。

**本設計書のステータス: 上記1〜6は実装・検証済み（§8.4, §9参照）。**
