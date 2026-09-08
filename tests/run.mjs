// テストランナー: 各テストファイルを個別のNodeプロセスで実行し、終了コードで判定する。
// 追加パッケージ不要。`npm test` から呼ばれる。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const registerPath = path.join(here, 'register.mjs');

/** @type {Array<{file: string, env?: Object, label: string}>} */
const runs = [
    { file: 'budget.test.mjs', label: '家計簿（budget/copy-month/recurring/calculator/statement-import）' },
    { file: 'worker.test.mjs', label: 'gcal-sync Worker' },
    { file: 'calendar.test.mjs', label: 'カレンダー（JST）', env: { TZ: 'Asia/Tokyo' } },
    // 日付処理がタイムゾーンに依存しないことを、負オフセットのTZでも確認する
    { file: 'calendar.test.mjs', label: 'カレンダー（America/Los_Angeles）', env: { TZ: 'America/Los_Angeles' } },
];

let failed = 0;
for (const run of runs) {
    console.log(`\n========== ${run.label} ==========`);
    const result = spawnSync(process.execPath, ['--import', registerPath, path.join(here, run.file)], {
        stdio: 'inherit',
        env: { ...process.env, ...(run.env || {}) },
    });
    if (result.status !== 0) failed++;
}

console.log(`\n${'='.repeat(40)}\n${failed === 0 ? '✓ 全テストスイート成功' : `✗ ${failed}件のスイートが失敗`}`);
process.exit(failed === 0 ? 0 : 1);
