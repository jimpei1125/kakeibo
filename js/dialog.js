/**
 * ダイアログモジュール
 * ブラウザ標準の confirm()/prompt() を置き換える、アプリのテーマに沿った
 * モーダルダイアログを提供する（Promiseベース）。
 *
 * ブラウザ標準ダイアログは端末ごとに見た目がバラバラでキャンセル動線も
 * 分かりにくいため、アプリ内で完結する統一デザインのダイアログに置き換える。
 */

/** 通常のcontent modal(z-[1500])より前面、トースト(z-[2000])より背面に表示 */
const Z_INDEX = 1800;

const VARIANT_CLASS = {
    primary: 'bg-indigo-500 hover:bg-indigo-400 text-white',
    danger: 'bg-rose-500 hover:bg-rose-400 text-white',
    neutral: 'bg-white/10 hover:bg-white/15 text-zinc-100',
};

export class Dialog {
    /** @type {HTMLElement|null} */
    static _root = null;
    /** @type {Array<{config: Object, resolve: Function}>} */
    static _queue = [];
    /** @type {boolean} */
    static _busy = false;

    /**
     * 確認ダイアログ（はい/いいえ）
     * @param {string} message
     * @param {{okLabel?: string, cancelLabel?: string, danger?: boolean}} [options]
     * @returns {Promise<boolean>} OKならtrue、キャンセルならfalse
     */
    static confirm(message, options = {}) {
        return this._show({
            message,
            input: false,
            buttons: [
                { label: options.cancelLabel || 'キャンセル', value: false, variant: 'neutral' },
                { label: options.okLabel || 'OK', value: true, variant: options.danger ? 'danger' : 'primary' },
            ]
        });
    }

    /**
     * テキスト入力ダイアログ
     * @param {string} message
     * @param {string} [defaultValue]
     * @returns {Promise<string|null>} 入力文字列、キャンセルならnull
     */
    static prompt(message, defaultValue = '') {
        return this._show({
            message,
            input: true,
            defaultValue,
            buttons: [
                { label: 'キャンセル', value: null, variant: 'neutral' },
                { label: 'OK', value: '__INPUT__', variant: 'primary' },
            ]
        });
    }

    /**
     * 3択以上の選択ダイアログ
     * @param {string} message
     * @param {Array<{label: string, value: any, variant?: 'primary'|'danger'|'neutral'}>} buttons
     * @returns {Promise<any>} 選んだボタンのvalue
     */
    static choose(message, buttons) {
        return this._show({ message, input: false, buttons });
    }

    /**
     * ダイアログ用DOMを初回のみ生成
     * @private
     * @returns {HTMLElement}
     */
    static _ensureRoot() {
        if (this._root) return this._root;

        const root = document.createElement('div');
        root.id = 'appDialogRoot';
        root.innerHTML = `
            <div class="dialog-backdrop fixed inset-0 bg-black/60 opacity-0 transition-opacity" style="z-index:${Z_INDEX};"></div>
            <div class="dialog-panel fixed left-1/2 top-1/2 w-[88%] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-zinc-900 p-5 opacity-0 shadow-2xl ring-1 ring-white/10 transition-opacity" style="z-index:${Z_INDEX + 1};">
                <p class="dialog-message whitespace-pre-wrap text-sm leading-relaxed text-zinc-100"></p>
                <div class="dialog-input-wrap mt-3" style="display:none;">
                    <input type="text" class="dialog-input w-full rounded-lg bg-white/5 px-3 py-2.5 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none focus:ring-2 focus:ring-indigo-500">
                </div>
                <div class="dialog-buttons mt-4 flex gap-2.5"></div>
            </div>
        `;
        document.body.appendChild(root);
        this._root = root;
        return root;
    }

    /**
     * ダイアログ表示をキューに積んで処理
     * @private
     */
    static _show(config) {
        return new Promise(resolve => {
            this._queue.push({ config, resolve });
            this._processQueue();
        });
    }

    /**
     * キューの先頭を表示（前のダイアログが閉じてから次を開く）
     * @private
     */
    static _processQueue() {
        if (this._busy || this._queue.length === 0) return;
        this._busy = true;

        const { config, resolve } = this._queue.shift();
        const root = this._ensureRoot();
        const backdrop = root.querySelector('.dialog-backdrop');
        const panel = root.querySelector('.dialog-panel');
        const messageEl = panel.querySelector('.dialog-message');
        const inputWrap = panel.querySelector('.dialog-input-wrap');
        const input = panel.querySelector('.dialog-input');
        const buttonsEl = panel.querySelector('.dialog-buttons');

        messageEl.textContent = config.message;
        inputWrap.style.display = config.input ? 'block' : 'none';
        if (config.input) input.value = config.defaultValue || '';

        buttonsEl.innerHTML = '';
        config.buttons.forEach(btn => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = `flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold transition ${VARIANT_CLASS[btn.variant] || VARIANT_CLASS.neutral}`;
            el.textContent = btn.label;
            el.onclick = () => finish(btn.value === '__INPUT__' ? input.value : btn.value);
            buttonsEl.appendChild(el);
        });

        const onKeydown = (e) => {
            if (e.key === 'Escape') {
                const cancelBtn = config.buttons.find(b => b.value === false || b.value === null) || config.buttons[0];
                finish(cancelBtn.value === '__INPUT__' ? null : cancelBtn.value);
            } else if (e.key === 'Enter' && config.input) {
                finish(input.value);
            }
        };

        const close = () => {
            backdrop.classList.remove('show');
            panel.classList.remove('show');
            document.removeEventListener('keydown', onKeydown);
        };

        const finish = (value) => {
            close();
            resolve(value);
            this._busy = false;
            this._processQueue();
        };

        document.addEventListener('keydown', onKeydown);
        backdrop.classList.add('show');
        panel.classList.add('show');

        if (config.input) {
            setTimeout(() => { input.focus(); input.select(); }, 50);
        }
    }
}
