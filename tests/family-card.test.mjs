// 家族カードの買い物（js/family-card.js）と、レシート読み取りからの記録のテスト
function makeEl(id) {
    return {
        id, checked: true, value: '', textContent: '', innerHTML: '', disabled: false,
        style: {}, dataset: {},
        classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
        querySelectorAll: () => [], querySelector: () => null,
        closest: () => null, appendChild(){}, addEventListener(){}, focus(){},
        setAttribute(){}, removeAttribute(){},
    };
}
globalThis.domValues = {};
/** 同じIDには同じ要素を返す（描画結果を後から読めるようにする） */
const elements = {};
globalThis.document = {
    getElementById: (id) => {
        if (!elements[id]) elements[id] = makeEl(id);
        if (id in globalThis.domValues) Object.assign(elements[id], globalThis.domValues[id]);
        return elements[id];
    },
    querySelectorAll: () => [], querySelector: () => null,
    createElement: (t) => makeEl(t), body: makeEl('body'),
};
globalThis.window = globalThis;

const F = await import('../js/family-card.js');
const { ReceiptReader } = await import('../js/receipt.js');
const { BudgetManager } = await import('../js/budget.js');
const { Dialog } = await import('../js/dialog.js');
const { Utils } = await import('../js/utils.js');
const { store } = await import('./stubs/firebase-config.mjs');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const flush = () => new Promise(r => setImmediate(r));
const DOC = 'budgetData/familyCardPurchases';
const toasts = [];
Utils.showToast = (message, type = 'success') => { toasts.push({ message, type }); };

function makeBudget(monthKey, categories = []) {
    const b = new BudgetManager();
    const [y, m] = monthKey.split('-').map(Number);
    b.currentYear = y; b.currentMonth = m;
    b.updateDisplay = () => {}; b.showSyncStatus = () => {};
    b._hideSyncStatusAfterDelay = () => {}; b._updateTotalDisplay = () => {};
    b.data[monthKey] = { categories };
    return b;
}
const makeManager = () => new F.FamilyCardManager(makeBudget('2026-11', [
    { id: 1, name: '食費', amount: 0, note: '', subcategories: [] },
    { id: 2, name: '日用品', amount: 0, note: '', subcategories: [] },
]));

console.log('\n【1】入力の検証と記録の形');
{
    check('日付: 実在する YYYY-MM-DD だけ通す',
        F.isValidDate('2026-11-08') && F.isValidDate('2028-02-29')
        && !F.isValidDate('2026-02-30') && !F.isValidDate('2026/11/08') && !F.isValidDate('') && !F.isValidDate(null));
    check('日付がなければエラー', F.buildPurchase({ date: '', amount: 100 }).error === '日付を入力してください');
    check('金額が空・0・負・数字以外ならエラー',
        ['', '0', '-5', 'abc', null].every(a => !!F.buildPurchase({ date: '2026-11-08', amount: a }).error));
    const p = F.buildPurchase({ date: '2026-11-08', store: ' イオン ', amount: '3280.4', category: ' 食費 ', memo: ' まとめ買い ' }).purchase;
    check('金額は整数・前後の空白を除く',
        p.amount === 3280 && p.store === 'イオン' && p.category === '食費' && p.memo === 'まとめ買い');
    const bare = F.buildPurchase({ date: '2026-11-08', amount: 500 }).purchase;
    check('空の項目も必ず持つ（mergeで前の値が残らないように）',
        bare.store === '' && bare.category === '' && bare.memo === '' && bare.source === 'manual');
    check('レシートからの記録は source: receipt',
        F.buildPurchase({ date: '2026-11-08', amount: 1, source: 'receipt' }).purchase.source === 'receipt');
}

console.log('\n【2】並び順・合計・日付の表示');
{
    const items = {
        a: { id: 'a', date: '2026-11-03', amount: 1000, createdAt: '2026-11-03T10:00:00Z' },
        b: { id: 'b', date: '2026-11-08', amount: 2000, createdAt: '2026-11-08T09:00:00Z' },
        c: { id: 'c', date: '2026-11-08', amount: 300, createdAt: '2026-11-08T12:00:00Z' },
        broken: null,
    };
    const list = F.sortPurchases(items);
    check('新しい順（同じ日は後から記録した方が上）・壊れた項目は除く',
        list.map(p => p.id).join(',') === 'c,b,a', list.map(p => p.id).join(','));
    check('合計', F.purchasesTotal(list) === 3300);
    check('短い日付は M/D', F.formatShortDate('2026-11-08') === '11/8' && F.formatShortDate('') === '-');
    check('記録がなくても動く', F.sortPurchases(undefined).length === 0 && F.purchasesTotal([]) === 0);
}

console.log('\n【3】記録の追加・修正・削除（Firestoreへの保存）');
{
    const fc = makeManager();
    const first = fc.add({ date: '2026-11-08', store: 'イオン', amount: 3280, category: '食費', memo: '' });
    await first.saved;
    const id1 = first.purchase.id;
    check('追加: items に記録IDをキーにして保存される',
        store[DOC]?.items?.[id1]?.amount === 3280 && store[DOC].items[id1].id === id1 && !!store[DOC].items[id1].createdAt);

    // 別の端末（妻のスマホ）が同時に記録しても、互いの分を消さない
    const other = makeManager();
    const second = other.add({ date: '2026-11-09', store: 'ドラッグストア', amount: 1280, category: '日用品' });
    await second.saved;
    const id2 = second.purchase.id;
    check('別の端末からの追加で、先の記録が消えない',
        Object.keys(store[DOC].items).length === 2 && !!store[DOC].items[id1] && !!store[DOC].items[id2]);
    check('記録IDは重ならない', id1 !== id2);

    // 修正: カテゴリーを外すと、前のカテゴリーが残らない
    fc.items = JSON.parse(JSON.stringify(store[DOC].items));
    const updated = fc.update(id1, { date: '2026-11-07', store: 'イオン', amount: 3300, category: '', memo: '金額を直した' });
    await updated.saved;
    const saved1 = store[DOC].items[id1];
    check('修正: 日付・金額・メモが変わる', saved1.date === '2026-11-07' && saved1.amount === 3300 && saved1.memo === '金額を直した');
    check('修正: 外したカテゴリーが残らない', saved1.category === '');
    check('修正: 記録した時刻は変わらない', saved1.createdAt === first.purchase.createdAt);
    check('修正: もう一方の記録はそのまま', store[DOC].items[id2].amount === 1280);
    check('修正: 入力が不正なら保存しない', !!fc.update(id1, { date: '2026-11-07', amount: '' }).error && store[DOC].items[id1].amount === 3300);
    check('修正: 削除済みの記録は直せない', !!fc.update('no-such-id', { date: '2026-11-07', amount: 1 }).error);

    // 削除
    const realConfirm = Dialog.confirm;
    Dialog.confirm = async () => false;
    await fc.remove(id1);
    await flush();
    check('削除: 確認でやめたら消さない', !!store[DOC].items[id1] && !!fc.items[id1]);
    Dialog.confirm = async () => true;
    await fc.remove(id1);
    await flush();
    check('削除: その記録だけ消える', !store[DOC].items[id1] && !!store[DOC].items[id2] && !fc.items[id1]);
    Dialog.confirm = realConfirm;

    check('不正な入力は保存しない', !!fc.add({ date: '2026-11-08', amount: 0 }).error && Object.keys(store[DOC].items).length === 1);
}

console.log('\n【4】フォームからの記録と一覧の表示');
{
    delete store[DOC];
    const fc = makeManager();
    globalThis.domValues = {
        familyCardDate: { value: '2026-11-10' }, familyCardStore: { value: 'ライフ' },
        familyCardAmount: { value: '2140' }, familyCardCategory: { value: '食費' }, familyCardMemo: { value: '' },
    };
    fc.submitForm();
    await flush();
    globalThis.domValues = {};
    const saved = Object.values(store[DOC].items);
    check('フォーム: 記録される', saved.length === 1 && saved[0].store === 'ライフ' && saved[0].amount === 2140 && saved[0].category === '食費');
    check('フォーム: 記録したことを知らせる', toasts.at(-1).message.includes('ライフ') && toasts.at(-1).message.includes('2,140'));

    globalThis.domValues = {
        familyCardDate: { value: '2026-11-11' }, familyCardAmount: { value: '980' },
        familyCardCategory: { value: '__new__' }, familyCardNewCategory: { value: ' 医療費 ' },
    };
    fc.submitForm();
    await flush();
    globalThis.domValues = {};
    check('フォーム: 新しいカテゴリー名で記録できる', Object.values(store[DOC].items).some(p => p.category === '医療費' && p.store === ''));

    const before = Object.keys(store[DOC].items).length;
    globalThis.domValues = { familyCardDate: { value: '2026-11-11' }, familyCardAmount: { value: '' } };
    fc.submitForm();
    await flush();
    globalThis.domValues = {};
    check('フォーム: 金額なしは記録せず、エラーを知らせる',
        Object.keys(store[DOC].items).length === before && toasts.at(-1).type === 'error');

    // 一覧
    fc._render();
    const html = elements.familyCardList.innerHTML;
    check('一覧: 新しい順に、日付・店名・金額を出す',
        html.indexOf('11/11') < html.indexOf('11/10') && html.includes('ライフ') && html.includes('¥2,140'));
    check('一覧: 店名のない記録は「店名なし」、件数と合計を出す',
        html.includes('店名なし') && elements.familyCardListCount.textContent === '2件' && elements.familyCardListTotal.textContent === '¥3,120');
    check('「その他の機能」に件数を出す', elements.familyCardCount.textContent === '2件');
    check('カテゴリーの選択肢に、記録で使ったカテゴリーも入る', fc._categoryNames().join(',') === '食費,日用品,医療費');

    // 店名にHTMLが入っても、そのまま文字として出す
    fc.add({ date: '2026-11-12', store: '<img src=x onerror=alert(1)>', amount: 100 });
    check('一覧: 店名はエスケープされる', !elements.familyCardList.innerHTML.includes('<img') && elements.familyCardList.innerHTML.includes('&lt;img'));

    // 直す: フォームに読み込み、保存で更新（新しい記録は増えない）
    const target = fc.list().find(p => p.store === 'ライフ');
    fc.edit(target.id);
    check('直す: フォームに値が入り、ボタンが保存に変わる',
        elements.familyCardStore.value === 'ライフ' && elements.familyCardAmount.value === 2140
        && elements.familyCardSubmit.textContent === '直した内容で保存' && elements.familyCardCancelEdit.style.display === 'block');
    const count = fc.list().length;
    elements.familyCardAmount.value = '2240';
    elements.familyCardCategory.value = '食費';
    fc.submitForm();
    await flush();
    check('直す: 同じ記録が更新される', fc.list().length === count && store[DOC].items[target.id].amount === 2240);
    check('直す: 保存後は新しい記録の入力に戻る',
        fc.editingId === null && elements.familyCardSubmit.textContent === '記録する' && elements.familyCardCancelEdit.style.display === 'none');

    // 空の一覧
    fc.items = {};
    fc._render();
    check('一覧: 記録がなければその旨を出し、件数は空にする',
        elements.familyCardList.innerHTML.includes('まだ記録がありません') && elements.familyCardCount.textContent === '');
}

console.log('\n【5】購読（家族の端末の記録が届く）');
{
    const fc = makeManager();
    const snapOf = (data) => ({ exists: () => data !== undefined, data: () => data });
    fc._handleSnapshot(snapOf(undefined));
    check('まだ記録の入れ物がなくても空で動く', fc.list().length === 0 && elements.familyCardCount.textContent === '');
    fc._handleSnapshot(snapOf({ items: {
        w1: { id: 'w1', date: '2026-11-09', store: '西友', amount: 1500, category: '食費', memo: '', source: 'manual', createdAt: '2026-11-09T03:00:00Z' },
    } }));
    check('家族の端末の記録が一覧と件数に出る',
        fc.list().length === 1 && elements.familyCardList.innerHTML.includes('西友') && elements.familyCardCount.textContent === '1件');

    // 直している途中の記録が、家族の端末で削除された場合
    fc.edit('w1');
    fc._handleSnapshot(snapOf({ items: {} }));
    globalThis.domValues = { familyCardDate: { value: '2026-11-09' }, familyCardAmount: { value: '1600' } };
    fc.submitForm();
    await flush();
    globalThis.domValues = {};
    check('直している途中で削除された記録は、復活させずエラーを知らせる',
        toasts.at(-1).type === 'error' && !store[DOC]?.items?.w1);
}

console.log('\n【6】レシート読み取りから家族カードの買い物へ記録');
{
    delete store[DOC];
    const budget = makeBudget('2026-11', [{ id: 1, name: '食費', amount: 0, note: '', subcategories: [] }]);
    const reader = new ReceiptReader(budget);
    const fc = new F.FamilyCardManager(budget);
    reader.familyCard = fc;
    fc.receipt = reader;
    reader.close = () => { reader.closed = true; };

    // 家族カードの画面から開くと、記録先は家族カード
    fc.openReceipt();
    check('家族カードの画面から開くと記録先は家族カード', reader.target === 'family');
    check('撮影画面の説明が家族カード用になる',
        elements.receiptLeadFamily.style.display === 'block' && elements.receiptLeadBudget.style.display === 'none');

    reader._showResult({ isReceipt: true, store: 'イオン', date: '2026-11-08', total: 3280, paymentMethod: 'credit_card', category: '食費', items: [] });
    check('確認画面: ボタンが家族カードへの記録になり、支払った人は出さない',
        elements.receiptSubmit.textContent === '家族カードの買い物に記録' && elements.receiptPayerWrap.style.display === 'none');
    check('確認画面: 二重計上の注意は出さない', elements.receiptCardWarning.style.display === 'none');

    globalThis.domValues = {
        receiptCategory: { value: '食費' }, receiptStore: { value: 'イオン' }, receiptDate: { value: '2026-11-08' },
        receiptAmount: { value: '3280' }, receiptMemo: { value: '2026/11/08' },
    };
    reader.save();
    await flush();
    const saved = Object.values(store[DOC]?.items || {});
    check('記録される（利用日・店名・金額・カテゴリー・レシート由来）',
        saved.length === 1 && saved[0].date === '2026-11-08' && saved[0].store === 'イオン'
        && saved[0].amount === 3280 && saved[0].category === '食費' && saved[0].source === 'receipt');
    check('日付だけのメモは持たせない', saved[0].memo === '');
    check('家計簿には入れない（二重計上を防ぐ）', budget.getCurrentMonthData().categories[0].subcategories.length === 0);
    check('記録後にシートを閉じる', reader.closed === true);

    // カテゴリーは未定でも記録できる・自分で書いたメモは残す
    globalThis.domValues = {
        receiptCategory: { value: '' }, receiptStore: { value: '薬局' }, receiptDate: { value: '2026-11-09' },
        receiptAmount: { value: '980' }, receiptMemo: { value: '風邪薬' },
    };
    reader.save();
    await flush();
    const second = Object.values(store[DOC].items).find(p => p.store === '薬局');
    check('カテゴリー未定でも記録でき、自分で書いたメモは残る', !!second && second.category === '' && second.memo === '風邪薬');

    // 日付・金額がなければ記録しない
    const before = Object.keys(store[DOC].items).length;
    globalThis.domValues = { receiptStore: { value: 'x' }, receiptDate: { value: '' }, receiptAmount: { value: '100' } };
    reader.save();
    globalThis.domValues = { receiptStore: { value: 'x' }, receiptDate: { value: '2026-11-09' }, receiptAmount: { value: '' } };
    reader.save();
    await flush();
    globalThis.domValues = {};
    check('日付なし・金額なしは記録しない', Object.keys(store[DOC].items).length === before);

    // 記録先を家計簿に戻すと、これまでどおり家計簿に入る
    reader.setTarget('budget');
    check('記録先を家計簿に戻すと、カード払いの注意と支払った人が出る',
        elements.receiptCardWarning.style.display === 'block' && elements.receiptPayerWrap.style.display === 'block'
        && elements.receiptSubmit.textContent === '2026年11月に追加');
    globalThis.domValues = {
        receiptCategory: { value: '食費' }, receiptStore: { value: 'コンビニ' }, receiptDate: { value: '2026-11-09' },
        receiptAmount: { value: '450' }, receiptMemo: { value: '' },
    };
    reader.save();
    await flush();
    globalThis.domValues = {};
    check('家計簿に追加され、家族カードの記録は増えない',
        budget.getCurrentMonthData().categories[0].subcategories.length === 1 && Object.keys(store[DOC].items).length === before);

    // 「その他の機能」から開いたときの記録先は家計簿
    reader.open({ target: 'family' });
    reader.open();
    check('ふつうに開くと記録先は家計簿に戻る',
        reader.target === 'budget' && elements.receiptLeadBudget.style.display === 'block');

    // レシートの日付が表示中の月と違うときの案内は、家計簿に入れるときだけ
    elements.receiptDate.value = '';
    reader._showResult({ isReceipt: true, store: 'A', date: '2026-10-30', total: 100, paymentMethod: 'cash', category: null, items: [] });
    check('家計簿: 月が違うと追加先を案内', elements.receiptMonthHint.style.display === 'block');
    reader.setTarget('family');
    check('家族カード: 月の案内は出さない', elements.receiptMonthHint.style.display === 'none');
}

console.log('\n【7】家族カードの明細CSV（見出し行なし）の読み取り');
const S = await import('../js/statement-import.js');
// 実物と同じ列の並びの架空データ（利用日,店名,利用者,支払区分,,支払月,利用金額,支払金額,,,現地通貨額,通貨,換算レート,換算日）
const FAMILY_CSV = [
    '2026/10/02,スーパーマルナカ,ご家族,1回払い,,26/11,4210,4210,,,,,',
    '2026/10/03,ＳＡＭＰＬＥ＊  ＳＴＯＲＥ  ＪＰ,ご家族,1回払い,,26/11,1980,,,12,USD,165.000,10/04',
    '2026/10/05,Ａ  Ｂ  Ｃ  Ｄ,ご家族,1回払い,,26/11,1200,1200,,,,,',
    '2026/10/07,ドラッグスト－ア駅前店,ご家族,1回払い,,26/11,880,880,,,,,',
    '2026/10/09,ブティック花,ご家族,1回払い,,26/11,8800,8800,,,,,',
    '2026/10/12,スーパーマルナカ,ご家族,1回払い,,26/11,4210,4210,,,,,',
].join('\n');
{
    check('全角英数を半角に・空白をまとめる', S.normalizeStoreName('ＳＡＭＰＬＥ＊  ＳＴＯＲＥ  ＪＰ') === 'SAMPLE* STORE JP');
    check('1文字ずつ空いた名前は詰める', S.normalizeStoreName('Ｕ  Ｂ  Ｅ  Ｒ') === 'UBER');
    check('長音の代わりの「－」は残す', S.normalizeStoreName('業務ス－パ－') === '業務ス－パ－');
    check('全角スラッシュ・英字', S.normalizeStoreName('ホワイティ／ＮＦＣ') === 'ホワイティ/NFC');

    const lines = ['山田 様,1234-****-****-5678,テストカード', ...FAMILY_CSV.split('\n'), ',,,,,,25280,,,,,,'];
    const parsed = S.parseHeaderlessCardRows(lines.map(l => l.split(',')));
    check('利用日で始まる行だけを明細にする（氏名・合計の行は読み飛ばす）', parsed.rows.length === 6, `got ${parsed.rows.length}`);
    check('支払月 26/11 → 2026-11', parsed.payMonth === '2026-11');
    check('海外利用は支払金額が空なので利用金額を使う', parsed.rows[1].amount === 1980 && parsed.rows[1].store === 'SAMPLE* STORE JP');
    check('ご家族の行に印が付く', parsed.rows.every(r => r.family));
    const self = S.parseHeaderlessCardRows([['2026/10/02', 'コンビニ', 'ご本人', '1回払い', '', '26/11', '500', '500']]);
    check('ご本人の行には印が付かない', self.rows.length === 1 && self.rows[0].family === false);

    // CSVImporter 経由（見出しがないと判断して読み替える）
    const imp = new S.CSVImporter(makeBudget('2026-11'));
    imp._parseTransactions(FAMILY_CSV);
    check('取込: 6件・支払月の2026-11に入れる', imp.transactions.length === 6 && imp.payMonth === '2026-11');
    check('取込: 家族カードの印', imp.transactions.every(t => t.family));
    let err = null;
    try { imp._parseTransactions('a,b,c\nx,y,z'); } catch (e) { err = e.message; }
    check('見出しも利用日もないCSVはこれまでどおりエラー', !!err && err.includes('利用店名'));
}

console.log('\n【8】明細の行と記録の照らし合わせ');
{
    const row = (id, date, amount) => ({ id, date, amount });
    const rec = (id, date, amount, createdAt = '2026-10-01T00:00:00Z') => ({ id, date, amount, createdAt });
    const m1 = F.matchFamilyRows([row(0, '2026/10/10', 3000)], [rec('a', '2026-10-10', 3000)]);
    check('同じ日・同じ金額は一致', m1.get(0)?.id === 'a');
    check('利用日が記録日の前日なら一致', F.matchFamilyRows([row(0, '2026/10/09', 3000)], [rec('a', '2026-10-10', 3000)]).size === 1);
    check('2日前は一致しない', F.matchFamilyRows([row(0, '2026/10/08', 3000)], [rec('a', '2026-10-10', 3000)]).size === 0);
    check('7日後は一致（通販の発送日請求）', F.matchFamilyRows([row(0, '2026/10/17', 3000)], [rec('a', '2026-10-10', 3000)]).size === 1);
    check('8日後は一致しない', F.matchFamilyRows([row(0, '2026/10/18', 3000)], [rec('a', '2026-10-10', 3000)]).size === 0);
    check('金額が1円でも違えば一致しない', F.matchFamilyRows([row(0, '2026/10/10', 3001)], [rec('a', '2026-10-10', 3000)]).size === 0);
    check('月をまたいでも日数で数える', F.matchFamilyRows([row(0, '2026/11/02', 3000)], [rec('a', '2026-10-30', 3000)]).size === 1);

    // 同じ金額が2回: それぞれ日付の近い記録と組む
    const m2 = F.matchFamilyRows(
        [row(0, '2026/10/02', 4210), row(1, '2026/10/12', 4210)],
        [rec('late', '2026-10-12', 4210), rec('early', '2026-10-02', 4210)]
    );
    check('同じ金額が2回あっても、日付の近い組にする', m2.get(0)?.id === 'early' && m2.get(1)?.id === 'late');
    // 記録1つに行2つ: 近い方だけ
    const m3 = F.matchFamilyRows([row(0, '2026/10/10', 500), row(1, '2026/10/12', 500)], [rec('a', '2026-10-11', 500)]);
    check('1つの記録は1行にだけ使う', m3.size === 1);
    const m4 = F.matchFamilyRows([row(0, '2026/10/14', 500), row(1, '2026/10/11', 500)], [rec('a', '2026-10-11', 500)]);
    check('ずれの小さい行を優先', m4.get(1)?.id === 'a' && !m4.has(0));
    check('日付の読めない行・記録は飛ばす', F.matchFamilyRows([row(0, '', 500)], [rec('a', '2026-10-11', 500)]).size === 0);
}

console.log('\n【9】取込: 共有と妻の個人利用の振り分け');
{
    delete store[DOC];
    delete store['budgetMonths/2026-11'];
    const budget = makeBudget('2026-11', [{ id: 1, name: '食費', amount: 0, note: '', subcategories: [] }]);
    budget.data['2026-11'].categories[0].subcategories.push({ id: 11, name: '既存', amount: 1000, note: '' });
    const fc = new F.FamilyCardManager(budget);
    await fc.add({ date: '2026-10-02', store: 'マルナカ', amount: 4210, category: '食費' }).saved;
    await fc.add({ date: '2026-10-12', store: 'マルナカ', amount: 4210, category: '食費' }).saved;
    await fc.add({ date: '2026-10-07', store: '薬局', amount: 880, category: '' }).saved;
    await fc.add({ date: '2026-10-30', store: '月末の買い物', amount: 2500, category: '食費' }).saved;

    const imp = new S.CSVImporter(budget);
    imp.familyCard = fc;
    imp._saveRules = async () => { imp.rulesSaved = true; };
    imp._parseTransactions(FAMILY_CSV);
    imp._applyFamilyMatching();
    const byStore = (name) => imp.transactions.filter(t => t.store === name);

    check('記録と一致した行は共有・記録のカテゴリー', byStore('スーパーマルナカ').every(t => !t.personal && t.category === '食費' && t.recordId));
    check('カテゴリーが未定の記録と一致した行は共有・未分類', (() => { const t = byStore('ドラッグスト－ア駅前店')[0]; return !t.personal && !t.category && !!t.recordId; })());
    check('記録のない行は妻の個人利用', ['SAMPLE* STORE JP', 'ABCD', 'ブティック花'].every(n => byStore(n)[0].personal));

    // 画面の表示（まとめ・一覧）
    globalThis.domValues = { csvImportMonth: { value: '2026-11' } };
    imp._renderAll();
    const panel = elements.csvFamilyPanel.innerHTML;
    check('まとめ: 家族カード6件・妻の個人利用3件と金額', panel.includes('6件') && panel.includes('3件') && panel.includes('¥11,980'));
    check('まとめ: 照らし合わせできなかった記録（月末の買い物）を出す', panel.includes('月末の買い物') && panel.includes('1件'));
    check('一覧: 記録と一致した行に印、切り替えボタン', elements.csvTxList.innerHTML.includes('記録あり 10/2') && elements.csvTxList.innerHTML.includes('共有にする'));
    check('プレビュー: 妻の個人利用は合計外として別に出す', elements.csvPreview.innerHTML.includes('妻の個人利用 ¥11,980'));
    check('取込ボタンが押せる', elements.csvImportBtn.disabled === false);

    // 共有の買い物だった行を切り替え、カテゴリーを付ける
    const abc = byStore('ABCD')[0];
    imp.setPersonal(abc.id, false);
    check('共有にすると未分類になる', !abc.personal && !abc.category);
    abc.checked = true;
    imp._assignToChecked('日用品');
    check('カテゴリーを選ぶと共有で分類される', abc.category === '日用品' && !abc.personal);
    // チェックした行をまとめて妻個人に戻せる
    abc.checked = true;
    imp.markCheckedPersonal();
    check('「妻個人にする」でまとめて戻せる', abc.personal === true);
    imp.setPersonal(abc.id, false);
    check('戻したあと共有にすると、前に選んだカテゴリーが残る', abc.category === '日用品');
    // 薬局（カテゴリー未定）も分類する
    const drug = byStore('ドラッグスト－ア駅前店')[0];
    drug.checked = true;
    imp._assignToChecked('日用品');

    const realConfirm = Dialog.confirm;
    Dialog.confirm = async () => true;
    await imp.importData();
    await flush();
    Dialog.confirm = realConfirm;
    globalThis.domValues = {};

    const month = budget.data['2026-11'];
    const food = month.categories.find(c => c.name === '食費');
    const daily = month.categories.find(c => c.name === '日用品');
    check('共有の行はカテゴリーに明細として入る', food.subcategories.length === 3 && daily.subcategories.length === 2);
    check('妻の個人利用は別に持つ（店名・金額・利用日）',
        month.wifePersonal.length === 2
        && month.wifePersonal.some(p => p.name === 'SAMPLE* STORE JP' && p.amount === 1980 && p.note === '2026/10/03')
        && month.wifePersonal.some(p => p.name === 'ブティック花' && p.amount === 8800));
    check('保存される', store['budgetMonths/2026-11']?.wifePersonal?.length === 2);
    check('共有で取り込んだ行と一致した記録は消える、月末の記録は残る',
        Object.values(store[DOC].items).length === 1 && Object.values(store[DOC].items)[0].store === '月末の買い物');
    check('妻の個人利用の店名は学習しない', imp.rules['ブティック花'] === undefined && imp.rules['ABCD'] === '日用品');
    check('取込を知らせる（妻の個人利用の件数と金額）', toasts.at(-1).message.includes('妻の個人利用2件') && toasts.at(-1).message.includes('10,780'));
}

console.log('\n【10】精算・合計・出力（妻の個人利用は合計外、精算で全額）');
{
    const B = await import('../js/budget.js');
    const budget = makeBudget('2026-11', [
        { id: 1, name: '食費', amount: 0, note: '', subcategories: [
            { id: 11, name: 'スーパー', amount: 30000, note: '' },
            { id: 12, name: '外食', amount: 10000, payer: 'wife', note: '' },
        ] },
    ]);
    const before = budget.calculateSettlement();
    check('個人利用がなければ今までどおり（差の半分）', before.settlementAmount === 10000 && before.direction === 'wife-to-husband' && before.wifePersonal === 0);

    B.addWifePersonal(budget.data['2026-11'], [{ name: 'ブティック', amount: 8800, note: '2026/10/09' }, { name: 'ネット', amount: 1980, note: '2026/10/03' }]);
    const s1 = budget.calculateSettlement();
    check('精算: 差の半分に、個人利用の全額を足す', s1.settlementAmount === 20780 && s1.direction === 'wife-to-husband' && s1.wifePersonal === 10780);
    check('合計には入れない', budget.calculateTotal() === 40000 && s1.total === 40000);
    check('内訳グラフにも入れない', budget._getCategoryBreakdown().total === 40000);

    // 妻払いが多い月: 夫→妻の精算が、個人利用の分だけ減る・逆転する
    const b2 = makeBudget('2026-12', [{ id: 1, name: '家賃', amount: 60000, payer: 'wife', note: '', subcategories: [] }]);
    B.addWifePersonal(b2.data['2026-12'], [{ name: 'x', amount: 10000 }]);
    const s2 = b2.calculateSettlement();
    check('夫→妻の精算から個人利用を差し引く', s2.direction === 'husband-to-wife' && s2.settlementAmount === 20000);
    B.addWifePersonal(b2.data['2026-12'], [{ name: 'y', amount: 30000 }]);
    const s3 = b2.calculateSettlement();
    check('個人利用が多ければ妻→夫に変わる', s3.direction === 'wife-to-husband' && s3.settlementAmount === 10000);
    const b3 = makeBudget('2027-01', [{ id: 1, name: '家賃', amount: 20000, payer: 'wife', note: '', subcategories: [] }]);
    B.addWifePersonal(b3.data['2027-01'], [{ name: 'z', amount: 10000 }]);
    check('ちょうど相殺なら精算なし', b3.calculateSettlement().direction === 'none');

    const out = budget.generateOutput();
    check('出力: 妻の個人利用を合計外として載せる', out.includes('■ 妻の個人利用（合計外）：10,780円') && out.includes('ブティック：8,800円'));
    check('出力: 合計は個人利用を含まない・精算額に含む',
        out.includes('Total：40,000円') && out.includes('妻の個人利用：10,780円（精算で妻が全額負担）') && out.includes('妻→夫 ¥20,780'));
    check('出力: 個人利用のない月は行を出さない', !makeBudget('2027-02', [{ id: 1, name: 'a', amount: 1, note: '', subcategories: [] }]).generateOutput().includes('個人利用'));

    // 家計簿画面の一覧と削除
    const html = budget._renderWifePersonal(budget.data['2026-11']);
    check('一覧: 件数・合計・各行', html.includes('2件') && html.includes('¥10,780') && html.includes('ブティック') && html.includes('10/09'));
    check('一覧: 個人利用がなければ何も出さない', budget._renderWifePersonal({ categories: [] }) === '');
    const id = budget.data['2026-11'].wifePersonal[0].id;
    const realConfirm = Dialog.confirm;
    Dialog.confirm = async () => true;
    await budget.deleteWifePersonal(id);
    await flush();
    Dialog.confirm = realConfirm;
    check('削除: その1件だけ消えて保存される',
        budget.data['2026-11'].wifePersonal.length === 1 && store['budgetMonths/2026-11']?.wifePersonal?.length === 1);

    // PayPayの請求文に内訳を添える
    const { PayPayRequestManager } = await import('../js/paypay.js');
    const pp = new PayPayRequestManager(budget, null);
    pp.link = 'https://qr.paypay.ne.jp/x';
    const msg = pp._buildMessage();
    check('PayPay: 精算額と、うち妻の個人利用', msg.includes('¥11,980') && msg.includes('うち妻の個人利用 ¥1,980'));
}

console.log('\n【11】本会員のアカウントの明細CSV（会員ごとの区切り行つき）');
// 実物と同じ並びの架空データ。本会員（スマホ決済用カードを含む）→小計→家族会員→小計→総合計
const SECTIONED_CSV = [
    '山田　太郎　様,1234-56**-****-****,テストカード',
    '2026/10/01,ＧＯＯＧＬＥ　ＰＬＡＹ　ＪＡＰＡＮ,750,１,１,750,',
    '2026/10/01,ＧＯＯＧＬＥ　ＰＬＡＹ　ＪＡＰＡＮ,750,１,１,750,',
    '2026/10/07,SAMPLE* MEMBERSHIP (INTERNET ),1614,１,１,1614,10.00　USD　161.485　10 07',
    '2025/11/21,ＡＭＡＺＯＮ．ＣＯ．ＪＰ,132103,１２,１２,11008,',
    '山田　太郎　様,9999-11**-****-****,スマホ決済／ｉＤ',
    '2026/10/05,スーパーマルナカ／ｉＤ,5290,１,１,5290,',
    ',,,,,19412',
    '山田　花子　様,1234-56**-****-****,テストカード',
    '2026/10/02,スーパーマルナカ,4210,１,１,4210,',
    '2026/10/09,ブティック花,8800,１,１,8800,',
    '2026/10/18,Ｕ　Ｂ　Ｅ　Ｒ,2257,１,１,2257,',
    ',,,,,15267',
    ',,,,,34679,',
].join('\n');
{
    const parsed = S.parseSectionedCardRows(SECTIONED_CSV.split('\n').map(l => l.split(',')), '202611_1.csv');
    check('区切り行・小計・総合計を読み飛ばし、明細の行だけ読む', parsed.rows.length === 8, `got ${parsed.rows.length}`);
    check('最初の会員（本会員）の行は家族カードではない', parsed.rows.slice(0, 5).every(r => !r.family));
    check('同じ氏名のスマホ決済用カードも本会員のまま', parsed.rows[4].store === 'スーパーマルナカ/iD' && !parsed.rows[4].family);
    check('氏名の違う会員の行は家族カード', parsed.rows.slice(5).every(r => r.family));
    check('分割払いは今回の支払金額', parsed.rows[3].amount === 11008 && parsed.rows[3].date === '2025/11/21');
    check('全角の店名を半角に・1文字ずつ空いた名前を詰める', parsed.rows[0].store === 'GOOGLE PLAY JAPAN' && parsed.rows[7].store === 'UBER');
    check('合計が明細の小計・総合計と合う', parsed.rows.reduce((s, r) => s + r.amount, 0) === 34679);
    check('ファイル名から支払月', parsed.payMonth === '2026-11');
    check('ファイル名に年月がなければ、最も多い利用月の翌月',
        S.parseSectionedCardRows(SECTIONED_CSV.split('\n').map(l => l.split(',')), 'meisai.csv').payMonth === '2026-11');
    check('支払月: 12月の翌月は翌年1月',
        S.parseSectionedCardRows([['A 様', '1234-56**-****-****', 'x'], ['2026/12/03', 'a', '100', '1', '1', '100', '']], '').payMonth === '2027-01');
    check('ファイル名の読み方', S.payMonthFromFileName('202611.csv') === '2026-11' && S.payMonthFromFileName('202611_1.csv') === '2026-11'
        && S.payMonthFromFileName('202613.csv') === null && S.payMonthFromFileName('明細.csv') === null);

    const imp = new S.CSVImporter(makeBudget('2026-11'));
    imp.fileName = '202611_1.csv';
    imp._parseTransactions(SECTIONED_CSV);
    check('取込: 区切り行つきの形式を見分ける', imp.transactions.length === 8 && imp.payMonth === '2026-11'
        && imp.transactions.filter(t => t.family).length === 3);
    // 全角のまま覚えた店名のルールも使える
    imp.rules = { 'ＧＯＯＧＬＥ　ＰＬＡＹ　ＪＡＰＡＮ': 'サブスク' };
    imp._parseTransactions(SECTIONED_CSV);
    check('全角で覚えた店名のカテゴリーも使う', imp.transactions[0].category === 'サブスク');
}

console.log('\n【12】取込済みの明細（別のファイルで同じ明細を読んだとき）');
{
    const month = { categories: [
        { id: 1, name: '食費', amount: 0, note: '', subcategories: [
            { id: 11, name: 'マルナカ', amount: 4210, note: '2026/10/02', familyCard: true },
            { id: 12, name: 'GOOGLE', amount: 750, note: '2026/10/01' },
        ] },
    ], wifePersonal: [{ id: 21, name: 'ブティック花', amount: 8800, note: '2026/10/09' }] };
    const rows = [
        { id: 0, date: '2026/10/01', amount: 750 }, { id: 1, date: '2026/10/01', amount: 750 },
        { id: 2, date: '2026/10/02', amount: 4210 }, { id: 3, date: '2026/10/09', amount: 8800 },
        { id: 4, date: '2026/10/09', amount: 8801 },
    ];
    const found = S.findAlreadyImported(rows, month);
    check('利用日と金額が同じ明細を取込済みとみなす', found.get(0)?.subId === 12 && found.get(2)?.subId === 11 && found.get(3)?.id === 21);
    check('同じ日・同じ金額が2回あれば、取込済みの数だけ対応させる', found.has(0) && !found.has(1));
    check('金額が違えば別の明細', !found.has(4));
    check('振り分け済みかどうか', found.get(2).classified === true && found.get(0).classified === false && found.get(3).classified === true);
    check('月データがなくても動く', S.findAlreadyImported(rows, undefined).size === 0);

    // 妻のCSVで振り分けて取り込んだあと、本会員のCSVを読む
    delete store['budgetMonths/2026-11'];
    const budget = makeBudget('2026-11');
    const realConfirm = Dialog.confirm;
    Dialog.confirm = async () => true;
    const mkImporter = () => {
        const i = new S.CSVImporter(budget);
        i.familyCard = new F.FamilyCardManager(budget);
        i._saveRules = async () => {};
        return i;
    };
    globalThis.domValues = { csvImportMonth: { value: '2026-11' } };
    const wifeImp = mkImporter();
    wifeImp._parseTransactions(FAMILY_CSV);
    wifeImp._applyFamilyMatching();
    wifeImp.transactions.filter(t => t.store === 'スーパーマルナカ').forEach(t => { t.personal = false; t.category = '食費'; });
    await wifeImp.importData();
    const afterWife = budget.data['2026-11'];
    check('妻のCSV: 共有2件・妻個人4件', afterWife.categories[0].subcategories.length === 2 && afterWife.wifePersonal.length === 4);
    check('家族カードの共有の明細に印が付く', afterWife.categories[0].subcategories.every(sub => sub.familyCard === true));

    const ownImp = mkImporter();
    ownImp.fileName = '202611_1.csv';
    // 家族会員の行を、妻のCSVと同じ明細にそろえる（マルナカ2回・ブティック花）
    const ownCsv = SECTIONED_CSV.replace('2026/10/18,Ｕ　Ｂ　Ｅ　Ｒ,2257,１,１,2257,', '2026/10/12,スーパーマルナカ,4210,１,１,4210,');
    ownImp._parseTransactions(ownCsv);
    ownImp._applyFamilyMatching();
    ownImp._renderAll();
    const plan = (t) => ownImp._rowPlan(t);
    const ownFamily = ownImp.transactions.filter(t => t.family);
    check('本会員のCSV: 振り分け済みの家族カード分は前回の振り分けを引き継いで取り込まない',
        ownFamily.every(t => plan(t) === 'skip') && ownFamily.filter(t => t.store === 'スーパーマルナカ').every(t => !t.personal && t.category === '食費'));
    check('本会員の分は取り込む', ownImp.transactions.filter(t => !t.family).every(t => plan(t) === 'import'));
    check('一覧に取込済みと出し、集計からは外す',
        elements.csvTxList.innerHTML.includes('取込済み') && elements.csvPreview.innerHTML.includes('取込済み ¥17,220（3件・取り込みません）'));
    const personalBefore = afterWife.wifePersonal.length;
    ownImp.transactions.filter(t => !t.family).forEach(t => { t.category = 'その他'; });
    await ownImp.importData();
    check('取り込んでも家族カード分は二重にならない',
        budget.data['2026-11'].wifePersonal.length === personalBefore && budget.data['2026-11'].categories[0].subcategories.length === 2);
    check('本会員の分（5件）が入る', budget.data['2026-11'].categories.find(c => c.name === 'その他')?.subcategories.length === 5);
    check('取込済みを除いたことを知らせる', toasts.at(-1).message.includes('取込済み3件は除きました'));

    // 同じファイルをもう一度
    const again = mkImporter();
    again.fileName = '202611_1.csv';
    again._parseTransactions(ownCsv);
    again._applyFamilyMatching();
    await again.importData();
    check('同じ明細をもう一度読むと、すべて取込済み', toasts.at(-1).message === 'この明細はすべて取込済みです' && toasts.at(-1).type === 'error');

    // PDFなどで家族カード分を区別せず共有に入れていた月: 妻個人の行は共有から外して移す
    delete store['budgetMonths/2026-12'];
    const b2 = makeBudget('2026-12', [{ id: 5, name: 'クレカ明細', amount: 0, note: '', subcategories: [
        { id: 51, name: 'ブティック花', amount: 8800, note: '2026/10/09' },
        { id: 52, name: 'マルナカ', amount: 4210, note: '2026/10/02' },
        { id: 53, name: 'GOOGLE PLAY JAPAN', amount: 750, note: '2026/10/01' },
    ] }]);
    const pdfImp = new S.CSVImporter(b2);
    pdfImp.familyCard = new F.FamilyCardManager(b2);
    pdfImp._saveRules = async () => {};
    pdfImp.fileName = '202612.csv';
    globalThis.domValues = { csvImportMonth: { value: '2026-12' } };
    pdfImp._parseTransactions(SECTIONED_CSV);
    pdfImp._applyFamilyMatching();
    pdfImp._renderAll();
    const boutique = pdfImp.transactions.find(t => t.store === 'ブティック花');
    const marunaka = pdfImp.transactions.find(t => t.store === 'スーパーマルナカ');
    check('区別せず入れた家族カード分は、妻個人なら「移す」', pdfImp._rowPlan(boutique) === 'move' && boutique.personal);
    check('移すことを案内する', elements.csvFamilyPanel.innerHTML.includes('取込済みの明細を外して'));
    pdfImp.setPersonal(marunaka.id, false);
    check('共有に切り替えた行は、そのまま（取り込まない）', pdfImp._rowPlan(marunaka) === 'skip');
    // それでも取り込む
    const google = pdfImp.transactions.find(t => t.store === 'GOOGLE PLAY JAPAN');
    check('本会員の取込済みの行は取り込まない', pdfImp._rowPlan(google) === 'skip');
    pdfImp.toggleForceImport(google.id);
    check('「別に取り込む」で取り込める', pdfImp._rowPlan(google) === 'import');
    pdfImp.toggleForceImport(google.id);
    pdfImp.transactions.filter(t => !t.family && pdfImp._rowPlan(t) === 'import').forEach(t => { t.category = 'その他'; });
    await pdfImp.importData();
    const m2 = b2.data['2026-12'];
    const pdfCat = m2.categories.find(c => c.name === 'クレカ明細');
    check('移した明細は共有のカテゴリーから外れる', !pdfCat.subcategories.some(sub => sub.id === 51) && pdfCat.subcategories.length === 2);
    check('妻の個人利用に入る（他の妻個人の行と合わせて）',
        m2.wifePersonal.some(p => p.name === 'ブティック花' && p.amount === 8800) && m2.wifePersonal.some(p => p.name === 'UBER'));
    check('合計から外れる', b2.calculateTotal() === 4210 + 750 + 750 + 1614 + 11008 + 5290);

    Dialog.confirm = realConfirm;
    globalThis.domValues = {};
}

console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
process.exit(fail === 0 ? 0 : 1);
