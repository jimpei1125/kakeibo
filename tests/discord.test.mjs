// Discord Webhook送信モジュールのテスト（fetch/DOM/clipboardをスタブ化）
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const elements = new Map();
const makeEl = (id) => ({ id, value: '', textContent: '', style: {}, focus() {}, classList: { add(){}, remove(){}, toggle(){} } });
globalThis.document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); },
};
globalThis.window = globalThis;
const opened = [];
globalThis.open = (url) => opened.push(url);
const clipboard = [];
// Node 22 では globalThis.navigator が getter 専用のため defineProperty で差し替える
Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (t) => { clipboard.push(t); } } },
    configurable: true, writable: true,
});
const posts = [];
let fetchOk = true;
globalThis.fetch = async (url, options) => { posts.push({ url, body: JSON.parse(options.body) }); return { ok: fetchOk, status: fetchOk ? 204 : 401 }; };

const { DiscordNotifier } = await import('../js/discord.js');
const { store } = await import('./stubs/firebase-config.mjs');

console.log('【1】Webhook URLの検証');
{
    check('discord.com の Webhook URL', DiscordNotifier.isValidWebhookUrl('https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz'));
    check('discordapp.com も可', DiscordNotifier.isValidWebhookUrl('https://discordapp.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz'));
    check('チャンネルURLは不可', !DiscordNotifier.isValidWebhookUrl('https://discord.com/channels/1/2'));
    check('http は不可', !DiscordNotifier.isValidWebhookUrl('http://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz'));
    check('短すぎるものは不可', !DiscordNotifier.isValidWebhookUrl('https://discord.com/api/webhooks/1'));
}

console.log('\n【2】2000文字制限の分割');
{
    check('短文はそのまま1件', JSON.stringify(DiscordNotifier.splitMessage('abc')) === '["abc"]');
    const line = 'x'.repeat(700);
    const text = [line, line, line, line].join('\n'); // 2803文字
    const chunks = DiscordNotifier.splitMessage(text);
    check('改行位置で分割される', chunks.length === 2 && chunks[0] === [line, line].join('\n') && chunks[1] === [line, line].join('\n'));
    check('各チャンクが2000文字以内', chunks.every(c => c.length <= 2000));
    const noNewline = 'y'.repeat(4500);
    const hard = DiscordNotifier.splitMessage(noNewline);
    check('改行が無ければ上限で強制分割', hard.length === 3 && hard.join('') === noNewline);
    check('空文字は0件', DiscordNotifier.splitMessage('').length === 0);
}

console.log('\n【3】send()');
{
    const d = new DiscordNotifier();
    check('未設定ならfalse（通信しない）', await d.send('hi') === false && posts.length === 0);
    d.webhookUrl = 'https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz';
    check('設定済みでtrue', await d.send('hello') === true);
    check('Webhookへ content をPOST', posts.length === 1 && posts[0].url === d.webhookUrl && posts[0].body.content === 'hello');
    posts.length = 0;
    await d.send('a'.repeat(2500));
    check('長文は複数回POSTされる', posts.length === 2);
    fetchOk = false;
    check('HTTPエラーならfalse', await d.send('x') === false);
    fetchOk = true;
}

console.log('\n【4】sendOutput()（テキスト出力の送信とフォールバック）');
{
    const d = new DiscordNotifier();
    document.getElementById('outputText').textContent = '📅 2026年9月 家計簿\n■ 食費：1,000円';
    posts.length = 0; opened.length = 0; clipboard.length = 0;
    await d.sendOutput();
    check('未設定: コピーしてチャンネルを開く（従来動作）', clipboard.length === 1 && opened.length === 1 && posts.length === 0);
    d.webhookUrl = 'https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz';
    opened.length = 0; clipboard.length = 0;
    await d.sendOutput();
    check('設定済み: 直接投稿し、チャンネルは開かない', posts.length === 1 && opened.length === 0 && posts[0].body.content.includes('食費'));
}

console.log('\n【5】設定の保存・削除');
{
    const d = new DiscordNotifier();
    document.getElementById('discordWebhookInput').value = 'https://discord.com/channels/1/2';
    await d.saveWebhook();
    check('不正なURLは保存されない', !store['budgetData/appSettings'] && !d.configured);
    document.getElementById('discordWebhookInput').value = '  https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz  ';
    await d.saveWebhook();
    check('妥当なURLはappSettingsへ保存（前後空白除去）', store['budgetData/appSettings']?.discordWebhookUrl?.startsWith('https://discord.com/api/webhooks/') && d.configured);
    check('保存後のステータス表示', document.getElementById('discordWebhookStatus').textContent.includes('設定済み'));
    await d.clearWebhook();
    check('削除で未設定に戻る', !d.configured && store['budgetData/appSettings'].discordWebhookUrl === '');
}

console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
process.exit(fail === 0 ? 0 : 1);
