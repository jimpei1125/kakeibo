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

console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
process.exit(fail === 0 ? 0 : 1);
