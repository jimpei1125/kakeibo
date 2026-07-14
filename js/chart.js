/**
 * チャートモジュール
 * カテゴリ別支出の内訳を3D風の円グラフ（インラインSVG）で描画する。
 * 外部ライブラリ非依存。
 */

import { Utils } from './utils.js';

/**
 * カテゴリ別配色（ダークサーフェス向けに検証済みのカテゴリカル8色）
 * 金額の多い順に固定で割り当てる（順序自体がCVD識別性の担保）。
 * dataviz スキルの検証済みパレット（dark）。
 */
export const CATEGORY_COLORS = [
    '#3987e5', // 1 blue
    '#199e70', // 2 aqua
    '#c98500', // 3 yellow
    '#008300', // 4 green
    '#9085e9', // 5 violet
    '#e66767', // 6 red
    '#d55181', // 7 magenta
    '#d95926', // 8 orange
];

/** 「その他」に集約したスライスの色（中立グレー・系列色と衝突しない） */
export const OTHER_COLOR = '#9a9aa5';

// 円グラフの寸法（viewBox基準）
const CX = 120;
const CY = 95;
const RX = 95;
const RY = 57;   // ≈ RX * 0.6（浅めの傾き＝手前スライスが誇張されにくい）
const DEPTH = 18;
const START = -Math.PI / 2; // 12時方向から時計回り

/**
 * 16進カラーを暗くする（側面の陰影用）
 * @param {string} hex
 * @param {number} f - 明度係数（0-1）
 * @returns {string}
 */
function darken(hex, f = 0.55) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.round(((n >> 16) & 255) * f);
    const g = Math.round(((n >> 8) & 255) * f);
    const b = Math.round((n & 255) * f);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/** 楕円周上の点 */
function pt(ang, dy = 0) {
    return [CX + RX * Math.cos(ang), CY + RY * Math.sin(ang) + dy];
}

const f2 = (n) => n.toFixed(2);

/**
 * カテゴリ別内訳から3D風円グラフのSVG＋凡例HTMLを生成
 * @param {Array<{name: string, amount: number, color: string}>} breakdown - 金額降順のカテゴリ配列
 * @param {number} total - 合計金額
 * @returns {{svg: string, legend: string}}
 */
export function buildPie(breakdown, total) {
    if (!breakdown.length || total <= 0) {
        return { svg: '', legend: '' };
    }

    // 各スライスの角度を算出
    let acc = START;
    const slices = breakdown.map(item => {
        const frac = item.amount / total;
        const a0 = acc;
        const a1 = acc + frac * Math.PI * 2;
        acc = a1;
        return { ...item, frac, a0, a1, mid: (a0 + a1) / 2 };
    });

    // 側面（手前側の半周だけ描く）。奥→手前の順に重ねるため mid の sin 昇順で描画
    const sideSlices = [...slices].sort((s1, s2) => Math.sin(s1.mid) - Math.sin(s2.mid));
    let sides = '';
    for (const s of sideSlices) {
        // スライスの弧を手前側 [0, π]（画面下半分）にクランプ
        const fs = Math.max(s.a0, 0);
        const fe = Math.min(s.a1, Math.PI);
        if (fs >= fe) continue;
        const [x1, y1] = pt(fs);
        const [x2, y2] = pt(fe);
        const large = (fe - fs) > Math.PI ? 1 : 0;
        sides += `<path d="M${f2(x1)},${f2(y1)} A${RX},${RY} 0 ${large} 1 ${f2(x2)},${f2(y2)} `
            + `L${f2(x2)},${f2(y2 + DEPTH)} A${RX},${RY} 0 ${large} 0 ${f2(x1)},${f2(y1 + DEPTH)} Z" `
            + `fill="${darken(s.color)}"/>`;
    }

    // 上面（扇形）＋ 直接ラベル（5%以上）
    let tops = '';
    let labels = '';
    const isFull = slices.length === 1;
    for (const s of slices) {
        if (isFull) {
            tops += `<ellipse cx="${CX}" cy="${CY}" rx="${RX}" ry="${RY}" fill="${s.color}" `
                + `stroke="#0d0d0d" stroke-width="1.5"/>`;
        } else {
            const [x1, y1] = pt(s.a0);
            const [x2, y2] = pt(s.a1);
            const large = (s.a1 - s.a0) > Math.PI ? 1 : 0;
            tops += `<path d="M${CX},${CY} L${f2(x1)},${f2(y1)} A${RX},${RY} 0 ${large} 1 ${f2(x2)},${f2(y2)} Z" `
                + `fill="${s.color}" stroke="#0d0d0d" stroke-width="1.5"/>`;
        }
        // 5%以上のスライスに%ラベル（上面中央寄り、白文字＋暗い縁取り）
        if (s.frac >= 0.05) {
            const lx = CX + RX * 0.62 * Math.cos(s.mid);
            const ly = CY + RY * 0.62 * Math.sin(s.mid);
            labels += `<text x="${f2(lx)}" y="${f2(ly)}" text-anchor="middle" dominant-baseline="central" `
                + `font-size="12" font-weight="700" fill="#ffffff" `
                + `style="paint-order:stroke;stroke:rgba(0,0,0,0.55);stroke-width:3px;">`
                + `${Math.round(s.frac * 100)}%</text>`;
        }
    }

    const svg = `<svg viewBox="0 0 240 190" class="pie-svg" role="img" aria-label="カテゴリ別支出の円グラフ" `
        + `xmlns="http://www.w3.org/2000/svg">${sides}${tops}${labels}</svg>`;

    // 凡例（色チップ＋カテゴリ名＋金額＋%）— 全項目、正確な数値はここで読める
    const legend = breakdown.map(item => {
        const pct = Math.round((item.amount / total) * 100);
        return `<div class="pie-legend-item flex items-center gap-2 py-0.5 text-left">
            <span class="pie-legend-chip h-3 w-3 shrink-0 rounded-sm" style="background:${item.color}"></span>
            <span class="min-w-0 flex-1 truncate text-xs text-zinc-300">${Utils.escapeHtml(item.name)}</span>
            <span class="shrink-0 text-xs font-semibold text-zinc-100">¥${Utils.formatCurrency(item.amount)}</span>
            <span class="w-9 shrink-0 text-right text-xs text-zinc-500">${pct}%</span>
        </div>`;
    }).join('');

    return { svg, legend };
}
