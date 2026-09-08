/**
 * Firebase設定モジュール
 * Firestoreデータベースへの接続、認証、必要な関数をエクスポート
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
// 名前空間importにしているのは、オフライン永続化用の関数（initializeFirestore /
// persistentLocalCache）がこのCDN版で提供されていない場合でも読み込みが失敗しないように
// するため（名前付きimportは存在しない名前があると読み込み自体がエラーになる）。
import * as firestore from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import {
    getAuth,
    signInWithPopup,
    GoogleAuthProvider,
    onAuthStateChanged,
    signOut
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { Icons } from './icons.js';
import { Utils } from './utils.js';

/** Firebase プロジェクト設定 */
const firebaseConfig = {
    apiKey: "AIzaSyBhFzS8r2T4zvaEwC6EbH4wbt2sEuf9sEE",
    authDomain: "kakeibo-cc964.firebaseapp.com",
    projectId: "kakeibo-cc964",
    storageBucket: "kakeibo-cc964.firebasestorage.app",
    messagingSenderId: "120845540864",
    appId: "1:120845540864:web:a7a3d776ba900f2e0202e5"
};

// Firebase初期化
const firebaseApp = initializeApp(firebaseConfig);

const {
    doc, getDoc, onSnapshot, collection, addDoc, updateDoc, deleteDoc, query, where, getDocs, orderBy,
    setDoc: firestoreSetDoc,
} = firestore;

/**
 * Firestoreインスタンスを生成する（オフライン永続化つき）
 *
 * 永続キャッシュを有効にすると、圏外でも最後に同期したデータで画面が開き、
 * 圏外中の編集は端末内に保持されて接続時に自動送信される。
 * 複数タブ対応のタブマネージャーを使い、同じアプリを2タブ開いても衝突しない。
 * 対応関数が無い／初期化に失敗した場合は従来どおりの（永続化なし）インスタンスにフォールバックする。
 * @param {Object} app - Firebaseアプリ
 * @returns {Object} Firestoreインスタンス
 */
function createFirestore(app) {
    const { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, getFirestore } = firestore;
    if (typeof initializeFirestore === 'function' && typeof persistentLocalCache === 'function') {
        try {
            const cacheSettings = typeof persistentMultipleTabManager === 'function'
                ? { tabManager: persistentMultipleTabManager() }
                : {};
            return initializeFirestore(app, { localCache: persistentLocalCache(cacheSettings) });
        } catch (error) {
            console.warn('オフライン永続化を有効にできませんでした（通常モードで続行）:', error);
        }
    }
    return getFirestore(app);
}

/** Firestoreデータベースインスタンス */
const db = createFirestore(firebaseApp);

/**
 * setDoc のラッパー。値がundefinedのフィールドを取り除いてから書き込む。
 *
 * このアプリには payer のように「未設定＝undefined（＝夫払い）」を意味する
 * フィールドがあり、undefinedのまま渡すとFirestoreが
 * 「Unsupported field value: undefined」で書き込み全体を失敗させてしまう
 * （他の月からコピーした際の同期エラーの原因）。
 * undefinedは「フィールドを持たない」と同義なので、取り除くのが正しい挙動になる。
 *
 * 各モジュールは setDoc をこのファイル経由でimportしているため、
 * ここを通すことで同種の不具合が保存全体を壊すことを防ぐ。
 *
 * @param {Object} ref - ドキュメント参照
 * @param {Object} data - 書き込むデータ
 * @param {Object} [options] - setDocのオプション（{ merge: true } など）
 * @returns {Promise<void>}
 */
function setDoc(ref, data, options) {
    const sanitized = Utils.stripUndefined(data);
    return options === undefined
        ? firestoreSetDoc(ref, sanitized)
        : firestoreSetDoc(ref, sanitized, options);
}

/** Firebase Authインスタンス */
const auth = getAuth(firebaseApp);

/** Google認証プロバイダー */
const googleProvider = new GoogleAuthProvider();

/**
 * 認証管理クラス
 */
class AuthManager {
    constructor() {
        this.currentUser = null;
        this.authStateListeners = [];
    }

    /**
     * 認証状態の監視を開始
     */
    initAuthStateListener() {
        onAuthStateChanged(auth, (user) => {
            this.currentUser = user;
            this.notifyListeners(user);
            this.updateAuthUI(user);
        });
    }

    /**
     * 認証状態変更リスナーを追加
     */
    addAuthStateListener(callback) {
        this.authStateListeners.push(callback);
    }

    /**
     * リスナーに通知
     */
    notifyListeners(user) {
        this.authStateListeners.forEach(callback => callback(user));
    }

    /**
     * UIを更新
     */
    updateAuthUI(user) {
        const authStatus = document.getElementById('authStatus');
        const authBtn = document.getElementById('authBtn');
        const authUserName = document.getElementById('authUserName');
        const authIcon = document.getElementById('authIcon');
        const authUserId = document.getElementById('authUserId');

        if (!authStatus) return;

        if (user) {
            authStatus.classList.add('logged-in');
            if (authUserName) {
                authUserName.textContent = user.displayName || user.email || 'ユーザー';
            }
            if (authIcon) {
                authIcon.innerHTML = Icons.svg('check-circle');
                authIcon.classList.add('text-emerald-400');
            }
            if (authBtn) {
                authBtn.innerHTML = `${Icons.svg('log-out')} ログアウト`;
                authBtn.onclick = () => this.signOut();
            }
            // Firestoreルール設定用にUIDを表示（タップでコピー）
            if (authUserId && user.uid) {
                authUserId.textContent = `ID: ${user.uid}`;
                authUserId.classList.remove('hidden');
                authUserId.onclick = () => this.copyUserId(user.uid);
            }
        } else {
            authStatus.classList.remove('logged-in');
            if (authUserName) {
                authUserName.textContent = '未ログイン';
            }
            if (authIcon) {
                authIcon.innerHTML = Icons.svg('user');
                authIcon.classList.remove('text-emerald-400');
            }
            if (authBtn) {
                authBtn.innerHTML = `${Icons.svg('log-in')} ログイン`;
                authBtn.onclick = () => this.showLoginModal();
            }
            if (authUserId) {
                authUserId.classList.add('hidden');
                authUserId.textContent = '';
            }
        }
    }

    /**
     * ログインモーダルを表示
     */
    showLoginModal() {
        const modal = document.getElementById('loginModal');
        if (modal) modal.style.display = 'flex';
    }

    /**
     * ログインモーダルを閉じる
     */
    closeLoginModal() {
        const modal = document.getElementById('loginModal');
        if (modal) modal.style.display = 'none';
    }

    /**
     * Googleでログイン
     */
    async signInWithGoogle() {
        try {
            const result = await signInWithPopup(auth, googleProvider);
            this.closeLoginModal();
            this.showToast(`ようこそ、${result.user.displayName}さん！`);
            return result.user;
        } catch (error) {
            console.error('Googleログインエラー:', error);
            this.showToast('ログインに失敗しました');
            return null;
        }
    }

    /**
     * ユーザーIDをクリップボードにコピー（Firestoreルール設定用）
     * @param {string} uid
     */
    async copyUserId(uid) {
        try {
            await navigator.clipboard.writeText(uid);
            this.showToast('UIDをコピーしました');
        } catch {
            this.showToast('コピーに失敗しました');
        }
    }

    /**
     * ログアウト
     */
    async signOut() {
        try {
            await signOut(auth);
            this.showToast('ログアウトしました');
        } catch (error) {
            console.error('ログアウトエラー:', error);
            this.showToast('ログアウトに失敗しました');
        }
    }

    /**
     * 現在のユーザーIDを取得
     */
    getCurrentUserId() {
        return this.currentUser?.uid || null;
    }

    /**
     * ログイン済みかチェック
     */
    isLoggedIn() {
        return this.currentUser !== null;
    }

    /**
     * トースト表示（Utils未読み込み時用）
     */
    showToast(message) {
        const toast = document.getElementById('toast');
        if (toast) {
            toast.textContent = message;
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 2000);
        }
    }
}

// 認証マネージャーのインスタンス
const authManager = new AuthManager();

export {
    db,
    doc,
    getDoc,
    setDoc,
    onSnapshot,
    collection,
    addDoc, 
    updateDoc, 
    deleteDoc, 
    query, 
    where, 
    getDocs, 
    orderBy,
    auth,
    authManager,
    googleProvider
};
