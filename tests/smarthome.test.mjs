// スマートホーム画面のデバイス一覧キャッシュのテスト
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const elements = new Map();
const makeEl = (id) => ({ id, textContent: '', innerHTML: '', style: {}, classList: { add(){}, remove(){}, toggle(){} } });
globalThis.document = { getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); } };
const ls = {};
globalThis.localStorage = { getItem: (k) => ls[k] ?? null, setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } };

const { SmartHome } = await import('../js/smarthome.js');

console.log('【1】init() のキャッシュ判定');
{
    const sh = new SmartHome();
    let loads = 0, renders = 0;
    sh.loadDevices = async () => { loads++; };
    sh.renderDevices = () => { renders++; };

    sh.init();
    check('トークン未設定ならAPIを叩かずセットアップ画面', loads === 0 && document.getElementById('smartHomeSetup').style.display === 'block');

    sh.token = 't'; sh.secret = 's';
    sh.init();
    check('初回はデバイス一覧を取得する', loads === 1);

    // 取得済み・5分以内 → キャッシュから描画
    sh.devices = [{ deviceId: '1', deviceType: 'Bot', deviceName: 'ボット' }];
    sh.infraredDevices = [{ deviceId: '2', remoteType: 'Fan', deviceName: '扇風機' }];
    sh._devicesLoadedAt = Date.now();
    sh.init();
    check('5分以内の再表示はAPIを叩かずキャッシュ描画', loads === 1 && renders === 1);
    check('台数表示も復元される', document.getElementById('devicesStatus').textContent === '2台のデバイス');

    sh.init(true);
    check('force=true（更新ボタン）なら再取得', loads === 2);

    sh._devicesLoadedAt = Date.now() - 6 * 60 * 1000;
    sh.init();
    check('5分を過ぎたら再取得', loads === 3);
}

console.log(`\n結果: ${pass}件成功 / ${fail}件失敗`);
process.exit(fail === 0 ? 0 : 1);
