/**
 * 計算機モジュール
 * 「その他の機能」シートから開く四則演算の電卓（evalは使わない安全な評価器）
 */

import { Utils } from './utils.js';


/**
 * 電卓機能を提供するクラス
 */
export class Calculator {
    constructor() {
        /** @type {string} 現在の計算式 */
        this.expression = '';
    }

    /**
     * 計算機モーダルを表示
     */
    show() {
        Utils.showModal('calculatorModal');
        this.clear();
    }

    /**
     * 計算機モーダルを閉じる
     */
    close() {
        Utils.closeModal('calculatorModal');
    }

    /**
     * 計算式をクリア
     */
    clear() {
        this.expression = '';
        this._updateDisplay('0');
    }

    /**
     * 数字または演算子を追加
     * @param {string} value - 追加する値
     */
    append(value) {
        // 初期状態またはエラー時は入力値で置換
        this.expression = (this.expression === '0' || this.expression === 'エラー') 
            ? value 
            : this.expression + value;
        this._updateDisplay(this.expression);
    }

    /**
     * 計算を実行
     */
    calculate() {
        try {
            const result = Math.round(Calculator.evaluate(this.expression) * 100) / 100;
            this.expression = result.toString();
            this._updateDisplay(result);
        } catch {
            this._updateDisplay('エラー');
            this.expression = 'エラー';
        }
    }

    /**
     * 四則演算式を安全に評価する（evalは使わない）
     * 対応: + - × ÷ * / 括弧 小数 単項マイナス
     * @param {string} expression - 計算式
     * @returns {number} 計算結果
     * @throws {Error} 不正な式の場合
     */
    static evaluate(expression) {
        const tokens = expression
            .replace(/×/g, '*')
            .replace(/÷/g, '/')
            .match(/(?:\d+\.?\d*|\.\d+)|[+\-*/()]/g);
        if (!tokens) throw new Error('式が空です');

        let pos = 0;
        const peek = () => tokens[pos];
        const next = () => tokens[pos++];

        const parseFactor = () => {
            const token = next();
            if (token === '(') {
                const value = parseExpression();
                if (next() !== ')') throw new Error('括弧が閉じられていません');
                return value;
            }
            if (token === '-') return -parseFactor();
            if (token === '+') return parseFactor();
            const num = parseFloat(token);
            if (Number.isNaN(num)) throw new Error('不正なトークン');
            return num;
        };

        const parseTerm = () => {
            let value = parseFactor();
            while (peek() === '*' || peek() === '/') {
                value = next() === '*' ? value * parseFactor() : value / parseFactor();
            }
            return value;
        };

        const parseExpression = () => {
            let value = parseTerm();
            while (peek() === '+' || peek() === '-') {
                value = next() === '+' ? value + parseTerm() : value - parseTerm();
            }
            return value;
        };

        const result = parseExpression();
        if (pos < tokens.length || !Number.isFinite(result)) throw new Error('不正な式');
        return result;
    }

    /**
     * 計算結果をクリップボードにコピー
     */
    copyResult() {
        const result = document.getElementById('calcDisplay')?.textContent;
        if (!result || result === '0' || result === 'エラー') return;
        
        this._copyToClipboard(result)
            .then(() => Utils.showToast('コピーしました！'))
            .catch(() => Utils.showToast('コピーに失敗しました'));
    }

    /**
     * ディスプレイを更新
     * @private
     * @param {string|number} value - 表示する値
     */
    _updateDisplay(value) {
        const display = document.getElementById('calcDisplay');
        if (display) display.textContent = value;
    }

    /**
     * テキストをクリップボードにコピー（レガシーブラウザ対応）
     * @private
     * @param {string} text - コピーするテキスト
     * @returns {Promise<void>}
     */
    async _copyToClipboard(text) {
        // モダンブラウザ
        if (navigator.clipboard?.writeText) {
            return navigator.clipboard.writeText(text);
        }
        // レガシーブラウザ用フォールバック
        const textarea = document.createElement('textarea');
        textarea.value = text;
        Object.assign(textarea.style, { position: 'fixed', opacity: '0' });
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
    }
}

