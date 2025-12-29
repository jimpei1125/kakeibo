/**
 * Firebase設定モジュール
 * Firestoreデータベースへの接続、認証、必要な関数をエクスポート
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { 
    getFirestore, 
    doc, 
    setDoc, 
    onSnapshot, 
    collection, 
    addDoc, 
    updateDoc, 
    deleteDoc, 
    query, 
    where, 
    getDocs, 
    orderBy 
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import {
    getAuth,
    signInWithPopup,
    signInAnonymously,
    GoogleAuthProvider,
    onAuthStateChanged,
    signOut
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

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

/** Firestoreデータベースインスタンス */
const db = getFirestore(firebaseApp);

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
        
        if (!authStatus) return;

        if (user) {
            authStatus.classList.add('logged-in');
            if (authUserName) {
                authUserName.textContent = user.displayName || user.email || 'ゲスト';
            }
            if (authIcon) {
                authIcon.textContent = '✅';
            }
            if (authBtn) {
                authBtn.textContent = '🚪 ログアウト';
                authBtn.onclick = () => this.signOut();
            }
        } else {
            authStatus.classList.remove('logged-in');
            if (authUserName) {
                authUserName.textContent = '未ログイン';
            }
            if (authIcon) {
                authIcon.textContent = '👤';
            }
            if (authBtn) {
                authBtn.textContent = '🔐 ログイン';
                authBtn.onclick = () => this.showLoginModal();
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
     * 匿名ログイン
     */
    async signInAsGuest() {
        try {
            const result = await signInAnonymously(auth);
            this.closeLoginModal();
            this.showToast('ゲストとしてログインしました');
            return result.user;
        } catch (error) {
            console.error('匿名ログインエラー:', error);
            this.showToast('ログインに失敗しました');
            return null;
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
