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

console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
process.exit(fail === 0 ? 0 : 1);
