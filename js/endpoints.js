/**
 * 外部Workerのエンドポイントと、その認可に使う設定
 *
 * gcal-sync Worker は Googleカレンダー同期に加えてレシート読み取りも担う。
 * どちらも同じアプリキー（Workerに設定した合言葉）で認可するため、端末ごとの入力は1回で済む。
 */

/** gcal-sync Worker のURL（worker/gcal-sync/ 参照） */
export const GCAL_WORKER_URL = 'https://gcal-sync.zinnpei11251818.workers.dev';

/** アプリキーを保存する localStorage のキー */
export const APP_KEY_STORAGE_KEY = 'gcal_app_key';
