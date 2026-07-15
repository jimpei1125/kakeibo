/**
 * PayPay請求モジュール
 * 折半金額の請求文を自動生成し、PayPayの受け取りリンクを添えて
 * コピー・共有・Discord送信できるようにする。
 *
 * 注意: PayPayの個人間送金には外部から請求リンクを生成する公開APIが
 * 存在しないため、ユーザーがPayPayアプリで発行した「受け取りリンク
 * （マイコード）」を設定として保存し、請求文に添付する方式をとる。
 * 金額の自動入力もPayPayの仕様上できないため、文面に金額を明記して
 * 相手に入力してもらう。
 */

import { db, doc, setDoc, onSnapshot } from './firebase-config.js';
import { Utils } from './utils.js';

/** PayPay受け取りリンクとして想定されるURLの接頭辞 */
const PAYPAY_LINK_PREFIXES = [
    'https://qr.paypay.ne.jp/',
    'https://pay.paypay.ne.jp/',
];

/** 家族のDiscordチャンネルURL（既存の「Discordに送る」と同じ） */
const DISCORD_CHANNEL_URL = 'https://discord.com/channels/1360206899278118972/1366013675051159564';

export class PayPayRequestManager {
    /**
     * @param {import('./budget.js').BudgetManager} budgetManager - 予算管理インスタンス
     */
    constructor(budgetManager) {
        /** @type {import('./budget.js').BudgetManager} */
        this.budgetManager = budgetManager;
        /** @type {string} 保存済みの受け取りリンク */
        this.link = '';
    }

    /**
     * アプリ設定（受け取りリンク）をFirestoreから購読開始
     */
    init() {
        onSnapshot(
            doc(db, 'budgetData', 'appSettings'),
            (snap) => {
                this.link = (snap.exists() && snap.data().paypayLink) || '';
            },
            (error) => console.error('アプリ設定読み込みエラー:', error)
        );
    }

    /**
     * 請求モーダルを表示
     */
    showModal() {
        const linkInput = document.getElementById('paypayLinkInput');
        if (linkInput) linkInput.value = this.link;

        // Web Share API非対応環境では共有ボタンを隠す（コピーで代替）
        const shareBtn = document.getElementById('paypayShareBtn');
        if (shareBtn) shareBtn.style.display = navigator.share ? '' : 'none';

        this._renderBody();
        Utils.showModal('paypayRequestModal');
    }

    /**
     * 請求モーダルを閉じる
     */
    closeModal() {
        Utils.closeModal('paypayRequestModal');
        this._hideLinkWarning();
    }

    /**
     * 請求文を生成（表示中の月・折半金額から）
     * @private
     * @returns {string}
     */
    _buildMessage() {
        const total = this.budgetManager.calculateTotal();
        const half = Math.round(total / 2);
        const year = this.budgetManager.currentYear;
        const month = this.budgetManager.currentMonth;

        return `📅 ${year}年${month}月分 折半 ¥${Utils.formatCurrency(half)} をお願いします🙏\n`
            + `こちらから送金できます → ${this.link}`;
    }

    /**
     * モーダル本文（ガイド/請求文プレビュー・ボタン活性）を更新
     * @private
     */
    _renderBody() {
        const hasLink = !!this.link;

        const guide = document.getElementById('paypayGuide');
        const messageSection = document.getElementById('paypayMessageSection');
        if (guide) guide.style.display = hasLink ? 'none' : 'block';
        if (messageSection) messageSection.style.display = hasLink ? 'block' : 'none';

        if (hasLink) {
            const textarea = document.getElementById('paypayMessage');
            if (textarea) textarea.value = this._buildMessage();
        }

        // リンク未設定の間は送信系ボタンを無効化
        ['paypayCopyBtn', 'paypayShareBtn', 'paypayDiscordBtn'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = !hasLink;
        });
    }

    /**
     * 受け取りリンクを保存
     */
    async saveLink() {
        const input = document.getElementById('paypayLinkInput');
        const link = input?.value.trim() || '';

        if (!link) {
            Utils.showToast('受け取りリンクを入力してください');
            return;
        }

        // PayPayのリンク形式でない場合は警告（ドメイン変更に備えて保存自体は許可）
        const looksValid = PAYPAY_LINK_PREFIXES.some(prefix => link.startsWith(prefix));
        const warning = document.getElementById('paypayLinkWarning');
        if (warning) warning.classList.toggle('hidden', looksValid);

        try {
            await setDoc(doc(db, 'budgetData', 'appSettings'), { paypayLink: link }, { merge: true });
            this.link = link;
            Utils.showToast('受け取りリンクを保存しました');
            this._renderBody();
        } catch (error) {
            console.error('受け取りリンク保存エラー:', error);
            Utils.showToast('保存に失敗しました');
        }
    }

    /**
     * リンク形式の警告を非表示に
     * @private
     */
    _hideLinkWarning() {
        document.getElementById('paypayLinkWarning')?.classList.add('hidden');
    }

    /**
     * 送信する請求文（textareaの編集内容を反映）を取得
     * @private
     * @returns {string}
     */
    _getMessage() {
        return document.getElementById('paypayMessage')?.value.trim() || '';
    }

    /**
     * 請求文をクリップボードにコピー
     * @returns {Promise<boolean>} コピーできたか
     */
    async copyMessage() {
        const message = this._getMessage();
        if (!message) return false;

        try {
            await navigator.clipboard.writeText(message);
            Utils.showToast('請求文をコピーしました');
            return true;
        } catch (error) {
            console.error('コピーエラー:', error);
            Utils.showToast('コピーに失敗しました');
            return false;
        }
    }

    /**
     * OSの共有シートで請求文を共有（LINE・Discord等へ直接送信）
     */
    async shareMessage() {
        const message = this._getMessage();
        if (!message || !navigator.share) return;

        try {
            await navigator.share({ text: message });
        } catch (error) {
            // ユーザーによる共有キャンセルはエラー扱いしない
            if (error.name !== 'AbortError') {
                console.error('共有エラー:', error);
                Utils.showToast('共有に失敗しました');
            }
        }
    }

    /**
     * 請求文をコピーしてDiscordチャンネルを開く（貼り付けるだけの状態にする）
     */
    async sendToDiscord() {
        const copied = await this.copyMessage();
        if (copied) {
            window.open(DISCORD_CHANNEL_URL, '_blank', 'noopener,noreferrer');
        }
    }
}
