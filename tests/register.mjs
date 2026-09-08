// テスト実行時に読み込むローダー登録（node --import ./tests/register.mjs）
// js/ 配下のモジュールが import する './firebase-config.js'（CDNのFirebaseに依存）を
// tests/stubs/firebase-config.mjs に差し替える。
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
