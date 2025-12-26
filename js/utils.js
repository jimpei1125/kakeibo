// ユーティリティクラス
export class Utils {
    static showToast(message) {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2000);
    }

    static getJSTDate() {
        const today = new Date();
        const jstOffset = 9 * 60;
        return new Date(today.getTime() + (today.getTimezoneOffset() + jstOffset) * 60000);
    }
}
