// js/firebase-config.js（Firebase CDNをimportしていてNodeでは読めない）を
// メモリ上のFirestoreスタブへ差し替える解決フック
const STUB_URL = new URL('./stubs/firebase-config.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
    const fromApp = context.parentURL?.includes('/js/');
    if (fromApp && specifier.endsWith('firebase-config.js')) {
        return { url: STUB_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
