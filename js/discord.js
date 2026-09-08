/**
 * Discord送信モジュール
 * Webhook URL（家族共有・Firestoreの budgetData/appSettings に保存）が設定されていれば
 * テキスト出力やPayPay請求文をボタン1つでチャンネルへ直接投稿する。
 * 未設定のときは従来どおり「コピーしてDiscordを開く」動作にフォールバックする。
 */

import { db, doc, setDoc, onSnapshot } from './firebase-config.js';
import { Utils } from './utils.js';

/** DiscordのWebhook URLとして受け付ける接頭辞 */
const WEBHOOK_PREFIXES = [
    'https://discord.com/api/webhooks/',
    'https://discordapp.com/api/webhooks/',
    'https://ptb.discord.com/api/webhooks/',
    'https://canary.discord.com/api/webhooks/',
];

/** 家族のDiscordチャンネルURL（Webhook未設定時のフォールバックで開く） */
const DISCORD_CHANNEL_URL = 'https://discord.com/channels/1360206899278118972/1366013675051159564';

/** Discordの1メッセージあたりの最大文字数 */
const MAX_MESSAGE_LENGTH = 2000;

export class DiscordNotifier {
    constructor() {
        /** @type {string} 保存済みのWebhook URL */
        this.webhookUrl = '';
    }

    /**
     * アプリ設定（Webhook URL）をFirestoreから購読開始
     */
    init() {
        onSnapshot(
            doc(db, 'budgetData', 'appSettings'),
            (snap) => {
                this.webhookUrl = (snap.exists() && snap.data().discordWebhookUrl) || '';
                this._renderSettings();
            },
            (error) => console.error('Discord設定読み込みエラー:', error)
        );
    }

    /** Webhookが設定済みか */
    get configured() {
        return !!this.webhookUrl;
    }

    /**
     * DiscordのWebhook URLとして妥当な形式か
     * @param {string} url
     * @returns {boolean}
     */
    static isValidWebhookUrl(url) {
        return WEBHOOK_PREFIXES.some(prefix => url.startsWith(prefix)) && url.length > 40;
    }

    /**
     * 長文をDiscordの上限（2000文字）以内に、できるだけ行の切れ目で分割する
     * @param {string} text
     * @returns {string[]}
     */
    static splitMessage(text) {
        const chunks = [];
        let rest = text;
        while (rest.length > MAX_MESSAGE_LENGTH) {
            // 上限以内で最後の改行を探し、そこで切る（無ければ上限ぴったりで切る）
            let cut = rest.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
            if (cut <= 0) cut = MAX_MESSAGE_LENGTH;
            chunks.push(rest.slice(0, cut));
            rest = rest.slice(cut).replace(/^\n/, '');
        }
        if (rest.length) chunks.push(rest);
        return chunks;
    }

    /**
     * Webhookへ投稿する（2000文字を超える場合は分割して順に送る）
     * @param {string} text
     * @returns {Promise<boolean>} すべて送信できたか
     */
    async send(text) {
        if (!this.configured || !text) return false;
        try {
            for (const content of DiscordNotifier.splitMessage(text)) {
                const res = await fetch(this.webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
            }
            return true;
        } catch (error) {
            console.error('Discord送信エラー:', error);
            Utils.showToast('Discordへの送信に失敗しました。Webhook URLと通信状態を確認してください', 'error');
            return false;
        }
    }

    /**
     * 家計簿のテキスト出力をDiscordへ送る（Webhook未設定時はコピーしてチャンネルを開く）
     */
    async sendOutput() {
        const text = document.getElementById('outputText')?.textContent?.trim();
        if (!text) return;

        if (this.configured) {
            if (await this.send(text)) Utils.showToast('Discordに送信しました');
            return;
        }

        // フォールバック: 従来どおりコピーしてチャンネルを開く
        try {
            await navigator.clipboard.writeText(text);
            Utils.showToast('コピーしました。Discordに貼り付けてください（Webhookを設定すると直接送信できます）');
        } catch {
            Utils.showToast('コピーに失敗しました');
        }
        window.open(DISCORD_CHANNEL_URL, '_blank', 'noopener,noreferrer');
    }

    // ==================== 設定UI ====================

    /**
     * Webhook設定欄の表示/非表示を切り替え
     */
    toggleSettings() {
        const setup = document.getElementById('discordWebhookSetup');
        if (!setup) return;
        const visible = setup.style.display !== 'none';
        setup.style.display = visible ? 'none' : 'block';
        if (!visible) {
            const input = document.getElementById('discordWebhookInput');
            if (input) {
                input.value = this.webhookUrl;
                input.focus();
            }
        }
    }

    /**
     * Webhook URLを保存（家族共有）
     */
    async saveWebhook() {
        const input = document.getElementById('discordWebhookInput');
        const url = input?.value.trim() || '';

        if (!url) return Utils.showToast('Webhook URLを入力してください', 'error');
        if (!DiscordNotifier.isValidWebhookUrl(url)) {
            return Utils.showToast('DiscordのWebhook URL（https://discord.com/api/webhooks/... ）を入力してください', 'error');
        }

        try {
            await setDoc(doc(db, 'budgetData', 'appSettings'), { discordWebhookUrl: url }, { merge: true });
            this.webhookUrl = url;
            this._renderSettings();
            const setup = document.getElementById('discordWebhookSetup');
            if (setup) setup.style.display = 'none';
            Utils.showToast('Webhookを保存しました。次からは直接送信されます');
        } catch (error) {
            console.error('Webhook保存エラー:', error);
            Utils.showToast('保存に失敗しました', 'error');
        }
    }

    /**
     * Webhook設定を削除（コピー方式に戻す）
     */
    async clearWebhook() {
        try {
            await setDoc(doc(db, 'budgetData', 'appSettings'), { discordWebhookUrl: '' }, { merge: true });
            this.webhookUrl = '';
            this._renderSettings();
            const input = document.getElementById('discordWebhookInput');
            if (input) input.value = '';
            Utils.showToast('Webhook設定を削除しました');
        } catch (error) {
            console.error('Webhook削除エラー:', error);
            Utils.showToast('削除に失敗しました', 'error');
        }
    }

    /**
     * 設定状態の表示を更新
     * @private
     */
    _renderSettings() {
        const status = document.getElementById('discordWebhookStatus');
        if (status) {
            status.textContent = this.configured
                ? 'Webhook: 設定済み（ボタンで直接投稿します）'
                : 'Webhook: 未設定（コピーしてDiscordを開きます）';
        }
    }
}
