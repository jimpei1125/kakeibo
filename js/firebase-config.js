import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getFirestore, doc, setDoc, onSnapshot, collection, addDoc, updateDoc, deleteDoc, query, where, getDocs, orderBy } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

// Firebase設定
const firebaseConfig = {
    apiKey: "AIzaSyBhFzS8r2T4zvaEwC6EbH4wbt2sEuf9sEE",
    authDomain: "kakeibo-cc964.firebaseapp.com",
    projectId: "kakeibo-cc964",
    storageBucket: "kakeibo-cc964.firebasestorage.app",
    messagingSenderId: "120845540864",
    appId: "1:120845540864:web:a7a3d776ba900f2e0202e5"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

export { db, doc, setDoc, onSnapshot, collection, addDoc, updateDoc, deleteDoc, query, where, getDocs, orderBy };
