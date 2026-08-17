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
     * @param {'success'|'error'} [type='success'] - 種類（errorで赤系表示）
     */
    static showToast(message, type = 'success') {
        const toast = document.getElementById('toast');
        if (!toast) return;

        toast.textContent = message;
        toast.classList.toggle('toast-error', type === 'error');
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
     * 年月をdeltaヶ月ずらす（年またぎを正規化）
     * @param {number} year - 年
     * @param {number} month - 月（1-12）
     * @param {number} delta - 増減月数（負値で過去方向）
     * @returns {{year: number, month: number}}
     */
    static shiftMonth(year, month, delta) {
        const index = year * 12 + (month - 1) + delta;
        return { year: Math.floor(index / 12), month: (index % 12 + 12) % 12 + 1 };
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
        const value = Number(amount);
        return Number.isFinite(value) ? value.toLocaleString() : '0';
    }

    /**
     * 値がundefinedのフィールドを再帰的に取り除いたコピーを返す
     *
     * Firestoreはundefinedのフィールドを受け付けず、1つでも含まれると
     * 書き込み全体が「Unsupported field value: undefined」で失敗する。
     * undefinedは「フィールドを持たない」と同義なので、保存前に取り除く。
     *
     * プレーンなオブジェクトと配列のみ再帰し、Dateなどのインスタンスは
     * そのまま返す（Firestoreが解釈できる形を壊さないため）。
     * 配列内のundefined要素は、詰めると添字がずれて別の壊れ方をするため
     * あえて残す（この場合はFirestore側のエラーで気づけるようにする）。
     *
     * @param {*} value - 対象の値
     * @returns {*} undefinedのフィールドを除いた値
     */
    static stripUndefined(value) {
        if (Array.isArray(value)) return value.map(item => Utils.stripUndefined(item));

        const proto = value === null ? null : Object.getPrototypeOf(value);
        if (typeof value === 'object' && value !== null && (proto === Object.prototype || proto === null)) {
            const result = {};
            for (const [key, item] of Object.entries(value)) {
                if (item !== undefined) result[key] = Utils.stripUndefined(item);
            }
            return result;
        }

        return value;
    }

    /**
     * HTMLエスケープ（XSS対策）
     * ユーザー入力をinnerHTMLに埋め込む前に必ず通すこと
     * @param {*} value - エスケープする値
     * @returns {string} エスケープ済み文字列
     */
    static escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * onclick属性内のJS文字列引数として安全な形にエスケープする
     * （JS文字列リテラル化 → HTML属性用エスケープの二段階）
     * @param {*} value - エスケープする値
     * @returns {string} 属性内に埋め込めるJS文字列リテラル
     */
    static escapeJsArg(value) {
        return Utils.escapeHtml(JSON.stringify(String(value ?? '')));
    }

    /**
     * 指定IDの入力フィールドを空にする
     * @param {string[]} fieldIds - フィールドID配列
     */
    static clearInputs(fieldIds) {
        fieldIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
    }

    /** @type {number} ID生成用の連番カウンター */
    static _idCounter = 0;

    /**
     * 一意のIDを生成
     * 同一ミリ秒内の連続生成でも衝突しないよう連番を付加する
     * @returns {number} ユニークID（整数）
     */
    static generateId() {
        Utils._idCounter = (Utils._idCounter + 1) % 1000;
        return Date.now() * 1000 + Utils._idCounter;
    }
}
