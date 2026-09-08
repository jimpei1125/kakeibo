// DOM最小スタブ（どのIDでも許容する擬似要素を返す）
function makeEl(id) {
    return {
        id, checked: true, value: '', textContent: '', innerHTML: '', disabled: false,
        style: {}, dataset: {},
        classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
        querySelectorAll: () => [], querySelector: () => null,
        closest: () => null, appendChild(){}, addEventListener(){},
    };
}
globalThis.domValues = {};
globalThis.document = {
    getElementById: (id) => {
        const el = makeEl(id);
        if (id in globalThis.domValues) Object.assign(el, globalThis.domValues[id]);
        return el;
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: (t) => makeEl(t),
    body: makeEl('body'),
};
globalThis.window = globalThis;
globalThis.setTimeout = setTimeout;

const { BudgetManager } = await import('../js/budget.js');
const { CopyMonthManager } = await import('../js/copy-month.js');
const { RecurringManager } = await import('../js/recurring.js');
const { store, rawSetDoc } = await import('./stubs/firebase-config.mjs');
const { Utils } = await import('../js/utils.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

/** DOMに触れる表示系だけ無効化した BudgetManager（保存パスは本物のまま） */
function makeBudget(monthKey, categories = []) {
    const b = new BudgetManager();
    const [y, m] = monthKey.split('-').map(Number);
    b.currentYear = y; b.currentMonth = m;
    b.updateDisplay = () => {};
    b.showSyncStatus = () => {};
    b._hideSyncStatusAfterDelay = () => {};
    b._updateTotalDisplay = () => {};
    b.data[monthKey] = { categories };
    return b;
}

const lastError = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const resetStore = () => { for (const k of Object.keys(store)) delete store[k]; };
const flush = () => new Promise(r => setImmediate(r));

console.log('\n【1】不具合の再現（旧実装が生成していた payer: undefined）');
{
    const { doc, db } = await import('./stubs/firebase-config.mjs');
    const oldShape = { categories: [{ id: 1, name: '家賃', amount: 66000, payer: undefined, note: '', subcategories: [] }] };
    // rawSetDoc = Firestore本体の検証（ラッパーを通さない）
    const msg = await lastError(() => rawSetDoc(doc(db, 'budgetMonths', '2026-08'), oldShape));
    check('旧形式はsetDocに拒否される', msg !== null);
    check('エラー文が実機と一致（Unsupported field value: undefined / budgetMonths/2026-08）',
        !!msg && msg.includes('Unsupported field value: undefined') && msg.includes('budgetMonths/2026-08'),
        `\n     got: ${msg}`);
}

resetStore();
console.log('\n【2】他の月からコピー（夫払い＝payer未設定）');
{
    const budget = makeBudget('2026-08');
    budget.data['2026-07'] = { categories: [
        { id: 1, name: '家賃', amount: 66000, note: '', subcategories: [] },
        { id: 2, name: '食費', amount: 0, note: '', subcategories: [
            { id: 21, name: 'スーパー', amount: 30000, note: '' },
            { id: 22, name: '外食', amount: 23907, note: '' },
        ] },
    ] };
    globalThis.domValues = { copyMonthSource: { value: '2026-07' }, copyMonthKeepAmount: { checked: true } };
    const copy = new CopyMonthManager(budget);
    copy.closeModal = () => {};
    copy._renderList = () => {};
    copy._buildList();
    check('コピー元2件を認識', copy.items.length === 2, `got ${copy.items.length}`);
    copy.execute();
    await flush();
    const saved = store['budgetMonths/2026-08'];
    check('保存が成功する（同期エラーが出ない）', !!saved);
    check('カテゴリ2件が追加される', saved?.categories.length === 2);
    check('payerキーを持たない（夫払い）', saved && !('payer' in saved.categories[0]));
    check('小カテゴリーもpayerキーを持たない',
        saved && !('payer' in saved.categories[1].subcategories[0]));
    check('金額が引き継がれる', saved?.categories[0].amount === 66000);
}

resetStore();
console.log('\n【3】他の月からコピー（妻払いを含む）');
{
    const budget = makeBudget('2026-08');
    budget.data['2026-07'] = { categories: [
        { id: 1, name: '美容', amount: 8000, payer: 'wife', note: '', subcategories: [] },
        { id: 2, name: '雑費', amount: 0, note: '', subcategories: [
            { id: 21, name: '妻の分', amount: 3000, payer: 'wife', note: '' },
            { id: 22, name: '夫の分', amount: 2000, note: '' },
        ] },
    ] };
    globalThis.domValues = { copyMonthSource: { value: '2026-07' }, copyMonthKeepAmount: { checked: true } };
    const copy = new CopyMonthManager(budget);
    copy.closeModal = () => {}; copy._renderList = () => {};
    copy._buildList();
    copy.execute();
    await flush();
    const saved = store['budgetMonths/2026-08'];
    check('保存が成功する', !!saved);
    check('妻払いが維持される', saved?.categories[0].payer === 'wife');
    check('小カテゴリーの妻払いが維持される', saved?.categories[1].subcategories[0].payer === 'wife');
    check('小カテゴリーの夫払いはキーなし', saved && !('payer' in saved.categories[1].subcategories[1]));
}

resetStore();
console.log('\n【4】支払者チップの切替（夫→妻→夫）');
{
    const budget = makeBudget('2026-08', [
        { id: 1, name: '家賃', amount: 66000, note: '', subcategories: [] },
    ]);
    budget.togglePayer(1, null);
    await flush();
    check('夫→妻の保存が成功', store['budgetMonths/2026-08']?.categories[0].payer === 'wife');
    budget.togglePayer(1, null);
    await flush();
    const saved = store['budgetMonths/2026-08'];
    check('妻→夫の保存が成功（同期エラーが出ない）', !!saved);
    check('夫に戻すとpayerキーが消える', saved && !('payer' in saved.categories[0]));
    check('メモリ上のオブジェクトにもundefinedキーが残らない',
        !('payer' in budget.data['2026-08'].categories[0]));
}

resetStore();
console.log('\n【5】固定費（recurring）');
{
    const budget = makeBudget('2026-08', [
        { id: 1, name: '家賃', amount: 66000, note: '', subcategories: [] },
        { id: 2, name: '美容', amount: 8000, payer: 'wife', note: '', subcategories: [] },
    ]);
    const rec = new RecurringManager(budget);
    rec._renderList = () => {}; rec._renderFromCategoryList = () => {};
    rec.addFromCategory(1);
    await flush();
    check('夫払いカテゴリの固定費追加が成功', !!store['budgetData/recurringItems']);
    check('payerキーを持たない', !('payer' in store['budgetData/recurringItems'].items[0]));
    rec.addFromCategory(2);
    await flush();
    check('妻払いが維持される', store['budgetData/recurringItems'].items[1].payer === 'wife');
    const wifeItemId = rec.items[1].id;
    rec.togglePayer(wifeItemId);
    await flush();
    check('固定費の妻→夫の保存が成功', !!store['budgetData/recurringItems']);
    check('夫に戻すとpayerキーが消える', !('payer' in store['budgetData/recurringItems'].items[1]));
}

resetStore();
console.log('\n【6】固定費の自動記帳');
{
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const budget = makeBudget(key);
    budget.isInitialLoad = false;
    budget.recurringManager = { loaded: true, items: [
        { id: 1, name: '家賃', amount: 66000, note: '' },
        { id: 2, name: '美容', amount: 8000, payer: 'wife', note: '' },
    ] };
    budget.maybeAutoEntry();
    await flush();
    const saved = store[`budgetMonths/${key}`];
    check('自動記帳の保存が成功', !!saved, `key=${key}`);
    check('固定費2件が記帳される', saved?.categories.length === 2, `got ${saved?.categories.length}`);
    check('夫払いはpayerキーなし', saved && !('payer' in saved.categories[0]));
    check('妻払いは維持', saved?.categories[1]?.payer === 'wife');
}

resetStore();
console.log('\n【7】精算計算の回帰（payerキーなし＝夫払い）');
{
    const budget = makeBudget('2026-08', [
        { id: 1, name: '家賃', amount: 60000, note: '', subcategories: [] },
        { id: 2, name: '美容', amount: 10000, payer: 'wife', note: '', subcategories: [] },
    ]);
    const s = budget.calculateSettlement();
    check('夫払い60,000円', s.husband === 60000, `got ${s.husband}`);
    check('妻払い10,000円', s.wife === 10000, `got ${s.wife}`);
}

resetStore();
console.log('\n【8】安全網: 保存直前のundefined除去（Utils.stripUndefined）');
{
    const { setDoc, doc, db } = await import('./stubs/firebase-config.mjs');
    // 将来どこかが再びundefinedを混ぜても、保存が壊れないこと
    const withUndefined = { categories: [
        { id: 1, name: '家賃', amount: 66000, payer: undefined, note: '', subcategories: [
            { id: 11, name: '駐車場', amount: 5000, payer: undefined, note: '' },
        ] },
    ] };
    const msg = await lastError(() => setDoc(doc(db, 'budgetMonths', '2026-09'), withUndefined));
    check('undefinedが混ざっても保存が成功する', msg === null, `\n     got: ${msg}`);
    const saved = store['budgetMonths/2026-09'];
    check('undefinedのキーは書き込まれない', saved && !('payer' in saved.categories[0]));
    check('入れ子の小カテゴリーでも除去される',
        saved && !('payer' in saved.categories[0].subcategories[0]));

    // stripUndefined 単体の性質
    const src = { a: 1, b: undefined, c: { d: undefined, e: 2 }, f: [{ g: undefined, h: 3 }] };
    const out = Utils.stripUndefined(src);
    check('トップレベルのundefinedを除去', !('b' in out));
    check('入れ子のundefinedを除去', !('d' in out.c));
    check('配列内オブジェクトのundefinedを除去', !('g' in out.f[0]));
    check('undefined以外の値は保持', out.a === 1 && out.c.e === 2 && out.f[0].h === 3);
    check('nullは保持する', Utils.stripUndefined({ x: null }).x === null);
    check('0や空文字は保持する', (() => { const r = Utils.stripUndefined({ n: 0, s: '' }); return r.n === 0 && r.s === ''; })());
    check('元のオブジェクトを変更しない', 'b' in src);
    const d = new Date('2026-08-17T00:00:00Z');
    check('Dateインスタンスはそのまま返す', Utils.stripUndefined({ d }).d === d);
}

resetStore();
console.log('\n【9】リファクタリング回帰: 共通化ヘルパー');
{
    // Utils.shiftMonth（月送り計算の共通化）
    const eq = (a, b) => a.year === b.year && a.month === b.month;
    check('前月（年またぎ）', eq(Utils.shiftMonth(2026, 1, -1), { year: 2025, month: 12 }));
    check('翌月（年またぎ）', eq(Utils.shiftMonth(2026, 12, 1), { year: 2027, month: 1 }));
    check('同月', eq(Utils.shiftMonth(2026, 8, 0), { year: 2026, month: 8 }));
    check('-13ヶ月', eq(Utils.shiftMonth(2026, 8, -13), { year: 2025, month: 7 }));
    check('+25ヶ月', eq(Utils.shiftMonth(2026, 8, 25), { year: 2028, month: 9 }));

    // Utils.escapeJsArg（shopping/smarthomeで共用）
    check('escapeJsArg: 引用符・タグをエスケープ',
        Utils.escapeJsArg('a"b<c>') === '&quot;a\\&quot;b&lt;c&gt;&quot;');

    // changeMonth が shiftMonth 経由でも従来どおり動くこと
    const budget = makeBudget('2026-01', []);
    budget._resetTotalView = () => {};
    budget._animateMonthChange = () => {};
    budget.changeMonth(-1);
    check('changeMonth(-1)で2025年12月へ', budget.currentYear === 2025 && budget.currentMonth === 12);
    budget.changeMonth(1);
    check('changeMonth(+1)で2026年1月へ戻る', budget.currentYear === 2026 && budget.currentMonth === 1);
}

console.log('\n【10】リファクタリング回帰: 合計・出力テキスト');
{
    const cats = [
        { id: 1, name: '家賃', amount: 66000, note: '', subcategories: [] },
        { id: 2, name: 'クレカ', amount: 999, note: '', subcategories: [
            { id: 21, name: 'Amazon', amount: 12000, note: '' },
            { id: 22, name: 'Uber', amount: 8500, note: '' },
            { id: 23, name: 'セブン', amount: 4200, note: '' },
            { id: 24, name: 'ローソン', amount: 890, note: '' },
            { id: 25, name: '薬局', amount: 2100, note: '' },
        ] },
    ];
    const budget = makeBudget('2026-08', cats);
    // 小カテゴリーがある場合はamountではなく小計が使われる（999は無視）
    check('calculateTotal: 小計優先', budget.calculateTotal() === 66000 + 27690, `got ${budget.calculateTotal()}`);

    budget.outputDetailMode = false;
    const out = budget.generateOutput();
    check('概要モード: 上位3件＋ほか2件に圧縮',
        out.includes('├ Amazon：12,000円') && out.includes('└ ほか2件：2,990円'), `\n${out}`);
    check('概要モード: カテゴリ合計は小計', out.includes('■ クレカ：27,690円'));

    budget.outputDetailMode = true;
    const detail = budget.generateOutput();
    check('詳細モード: 全5件展開', detail.includes('ローソン：890円') && detail.includes('薬局：2,100円'));
}

console.log('\n【11】リファクタリング回帰: 電卓・SHA-256');
{
    const { Calculator } = await import('../js/calculator.js');
    const { CSVImporter } = await import('../js/statement-import.js');
    check('電卓: 四則演算', Calculator.evaluate('1+2*3') === 7);
    check('電卓: 括弧', Calculator.evaluate('(1+2)*(3+4)') === 21);
    check('電卓: 全角演算子', Calculator.evaluate('10×3÷4') === 7.5);
    check('電卓: 単項マイナス', Calculator.evaluate('-5+8') === 3);
    let threw = false;
    try { Calculator.evaluate('1++'); } catch { threw = true; }
    check('電卓: 不正な式はエラー', threw);

    // _sha256 が文字列とArrayBufferの両方を受けること（旧_sha256Bytes統合の検証）
    const imp = new CSVImporter(makeBudget('2026-08', []));
    const strHash = await imp._sha256('hello');
    const bytes = new TextEncoder().encode('hello');
    const bufHash = await imp._sha256(bytes.buffer);
    check('SHA-256: 文字列', strHash === '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    check('SHA-256: ArrayBufferで同一ハッシュ', bufHash === strHash);
}

resetStore();
console.log('\n【12】再描画時の画面状態復元（アコーディオン・スクロール・フォーカス）');
{
    // ブラウザ挙動を模したDOM: 要素をIDでキャッシュし、innerHTML再構築でフォーカス喪失を再現
    const cache = new Map();
    const makeTracked = (id) => ({
        id, value: '', textContent: '', innerHTML: '', checked: false, disabled: false,
        style: {}, dataset: {}, _classes: new Set(), _focusCalls: 0,
        classList: {
            add(c) { cache.get(id)._classes.add(c); },
            remove(c) { cache.get(id)._classes.delete(c); },
            toggle() {}, contains(c) { return cache.get(id)._classes.has(c); },
        },
        focus() { cache.get(id)._focusCalls++; },
        querySelectorAll: () => [], querySelector: () => null, closest: () => null,
    });
    const getEl = (id) => {
        if (!cache.has(id)) cache.set(id, makeTracked(id));
        return cache.get(id);
    };

    const origGetById = globalThis.document.getElementById;
    const origActive = globalThis.document.activeElement;
    globalThis.document.getElementById = getEl;

    // 再描画前の状態: カテゴリ1のアコーディオンが開いていて、名前欄にフォーカス、スクロール位置640px
    const listEl = getEl('categoryList');
    listEl.querySelectorAll = (sel) => sel === '.category-details.open' ? [getEl('details-1')] : [];
    Object.defineProperty(listEl, 'innerHTML', {
        get() { return this._html || ''; },
        set(v) {
            this._html = v;
            // ブラウザではinnerHTML再構築でフォーカス中の要素が破棄されbodyに移る
            globalThis.document.activeElement = { id: '' };
            // 再構築されたdetails/iconは閉じた状態で生成される
            cache.get('details-1')?._classes.clear();
            cache.get('icon-1')?._classes.clear();
        },
        configurable: true,
    });
    getEl('details-1')._classes.add('open');
    getEl('icon-1')._classes.add('open');
    globalThis.document.activeElement = { id: 'subname-1' };
    globalThis.scrollY = 640;
    const scrollCalls = [];
    globalThis.scrollTo = (x, y) => scrollCalls.push([x, y]);

    const budget = makeBudget('2026-09', [
        { id: 1, name: '食費', amount: 0, budget: 0, note: '', subcategories: [
            { id: 11, name: 'スーパー', amount: 1000, note: '' },
        ] },
    ]);
    delete budget.updateDisplay; // makeBudgetのスタブを外し、実物のupdateDisplayを検証する
    budget.updateDisplay();

    check('再構築後もアコーディオンが開いたまま', getEl('details-1')._classes.has('open'));
    check('開閉アイコンも開いたまま', getEl('icon-1')._classes.has('open'));
    check('フォーカスが名前欄に復元される', getEl('subname-1')._focusCalls === 1, `calls=${getEl('subname-1')._focusCalls}`);
    check('スクロール位置が復元される', scrollCalls.some(([x, y]) => x === 0 && y === 640), JSON.stringify(scrollCalls));
    check('カテゴリHTML自体は再構築されている', listEl._html.includes('食費') && listEl._html.includes('details-1'));

    // 閉じていたカテゴリは閉じたまま（開き癖がつかないこと）
    listEl.querySelectorAll = () => []; // 今度は何も開いていない状態
    globalThis.document.activeElement = { id: '' };
    budget.updateDisplay();
    check('閉じていたカテゴリは閉じたまま', !getEl('details-1')._classes.has('open'));

    // addSubcategory: 追加後に名前欄へフォーカスが戻る（続けて入力できる）
    getEl('subname-1')._focusCalls = 0;
    getEl('subname-1').value = '外食';
    getEl('subamount-1').value = '2000';
    getEl('subnote-1').value = '';
    budget.updateDisplay = () => {}; // ここでは保存副作用だけ見る
    budget.addSubcategory(1);
    await flush();
    check('小カテゴリーが追加される', budget.data['2026-09'].categories[0].subcategories.length === 2);
    check('追加後に名前欄へフォーカスが戻る', getEl('subname-1')._focusCalls >= 1);
    check('入力欄はクリアされる', getEl('subname-1').value === '' && getEl('subamount-1').value === '');

    globalThis.document.getElementById = origGetById;
    globalThis.document.activeElement = origActive;
}

console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
process.exit(fail === 0 ? 0 : 1);
