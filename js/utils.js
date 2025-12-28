/**
 * ユーティリティクラス
 * アプリケーション全体で使用される共通関数を提供
 */
export class Utils {
    /** トースト表示時間（ミリ秒） */
    static TOAST_DURATION = 2000;
    
    /** 日本標準時のオフセット（分） */
    static JST_OFFSET_MINUTES = 9 * 60;

    /**
     * トースト通知を表示
     * @param {string} message - 表示するメッセージ
     */
    static showToast(message) {
        const toast = document.getElementById('toast');
        if (!toast) return;
        
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), this.TOAST_DURATION);
    }

    /**
     * 日本標準時の日付オブジェクトを取得
     * @returns {Date} JST日付オブジェクト
     */
    static getJSTDate() {
        const now = new Date();
        return new Date(now.getTime() + (now.getTimezoneOffset() + this.JST_OFFSET_MINUTES) * 60000);
    }

    /**
     * 日付を YYYY-MM-DD 形式の文字列に変換
     * @param {Date} date - 日付オブジェクト
     * @returns {string} フォーマットされた日付文字列
     */
    static formatDateString(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    /**
     * 年月キーを生成 (YYYY-MM形式)
     * @param {number} year - 年
     * @param {number} month - 月
     * @returns {string} 年月キー
     */
    static getMonthKey(year, month) {
        return `${year}-${String(month).padStart(2, '0')}`;
    }

    /**
     * 今日の日付文字列を取得
     * @returns {string} YYYY-MM-DD形式の今日の日付
     */
    static getTodayString() {
        return this.formatDateString(new Date());
    }

    /**
     * モーダルを表示
     * @param {string} modalId - モーダル要素のID
     */
    static showModal(modalId) {
        document.getElementById(modalId)?.classList.add('show');
    }

    /**
     * モーダルを非表示
     * @param {string} modalId - モーダル要素のID
     */
    static closeModal(modalId) {
        document.getElementById(modalId)?.classList.remove('show');
    }

    /**
     * 要素の表示/非表示を切り替え
     * @param {string} elementId - 要素のID
     * @param {boolean} visible - 表示するかどうか
     */
    static setVisible(elementId, visible) {
        const el = document.getElementById(elementId);
        if (el) el.style.display = visible ? 'block' : 'none';
    }

    /**
     * 金額をフォーマット（カンマ区切り）
     * @param {number} amount - 金額
     * @returns {string} フォーマットされた金額
     */
    static formatCurrency(amount) {
        return amount.toLocaleString();
    }

    /**
     * 深いコピーを作成
     * @param {Object} obj - コピー元オブジェクト
     * @returns {Object} コピーされたオブジェクト
     */
    static deepCopy(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    /**
     * 一意のIDを生成
     * @returns {number} ユニークID
     */
    static generateId() {
        return Date.now() + Math.random();
    }
}
