// Firestore + js/firebase-config.js のラッパーを模擬するスタブ。
// rawSetDoc = Firestore本体（undefinedを拒否する）
// setDoc    = 実装のラッパー（Utils.stripUndefinedを通してから書き込む）
import { Utils } from '../../js/utils.js';

export const store = {};

function assertNoUndefined(value, path, docPath) {
    if (value === undefined) {
        throw new Error(
            `Function setDoc() called with invalid data. Unsupported field value: undefined (found in field ${path} in document ${docPath})`
        );
    }
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            assertNoUndefined(v, path ? `${path}.${k}` : k, docPath);
        }
    }
}

export const db = {};
export const doc = (_db, collectionName, id) => ({ path: `${collectionName}/${id}` });

/** Firestore本体の挙動 */
export async function rawSetDoc(ref, data) {
    assertNoUndefined(data, '', ref.path);
    store[ref.path] = JSON.parse(JSON.stringify(data));
}

/** js/firebase-config.js のラッパーと同じ処理 */
export async function setDoc(ref, data, options) {
    return rawSetDoc(ref, Utils.stripUndefined(data), options);
}

export const getDoc = async () => ({ exists: () => false, data: () => ({}) });
export const onSnapshot = () => () => {};
export const collection = () => ({});
export const addDoc = async () => ({ id: 'x' });
export const updateDoc = async () => {};
/** deleteDoc の呼び出し記録（テストで削除の有無を検証する用） */
export const deleteLog = [];
export const deleteDoc = async (ref) => { deleteLog.push(ref?.path || String(ref)); };
export const query = () => ({});
export const where = () => ({});
export const getDocs = async () => ({ forEach: () => {}, docs: [] });
export const orderBy = () => ({});
export const auth = {};
export const authManager = { getCurrentUserId: () => 'u1', isLoggedIn: () => true };
export const googleProvider = {};
