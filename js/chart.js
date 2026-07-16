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

// 積み上げ棒グラフの寸法（viewBox基準）
const TREND_WIDTH = 320;
const TREND_HEIGHT = 200;
const TREND_TOP_PAD = 28;   // 金額ラベル用の上部余白
const TREND_BOTTOM_PAD = 24; // 月ラベル用の下部余白
const TREND_BAR_GAP = 10;

/**
 * 直近6ヶ月の月別カテゴリ内訳から積み上げ棒グラフのSVG＋凡例HTMLを生成
 * @param {Object} trendData
 * @param {Array<{key: string, label: string, total: number, values: number[]}>} trendData.months - 古い順の月別データ
 * @param {Array<{name: string, color: string}>} trendData.categories - valuesと同じ順のカテゴリ（上位5＋その他）
 * @param {string} trendData.currentMonthKey - 表示中の月キー（ハイライト対象）
 * @returns {{svg: string, legend: string}}
 */
export function buildTrendChart(trendData) {
    const { months, categories, currentMonthKey } = trendData;
    const maxTotal = Math.max(...months.map(m => m.total), 0);

    if (!months.length || maxTotal <= 0) {
        return { svg: '', legend: '' };
    }

    const plotHeight = TREND_HEIGHT - TREND_TOP_PAD - TREND_BOTTOM_PAD;
    const barWidth = (TREND_WIDTH - TREND_BAR_GAP * (months.length + 1)) / months.length;

    let bars = '';
    months.forEach((month, i) => {
        const x = TREND_BAR_GAP + i * (barWidth + TREND_BAR_GAP);
        const isCurrent = month.key === currentMonthKey;
        const barHeight = maxTotal > 0 ? (month.total / maxTotal) * plotHeight : 0;
        let y = TREND_HEIGHT - TREND_BOTTOM_PAD - barHeight;
        const barTop = y;

        // 下から積み上げる（カテゴリ配列の先頭＝上位カテゴリを下段に）
        let stackY = TREND_HEIGHT - TREND_BOTTOM_PAD;
        let segments = '';
        month.values.forEach((value, ci) => {
            if (value <= 0) return;
            const segHeight = (value / maxTotal) * plotHeight;
            stackY -= segHeight;
            segments += `<rect x="${f2(x)}" y="${f2(stackY)}" width="${f2(barWidth)}" height="${f2(segHeight)}" `
                + `fill="${categories[ci].color}"/>`;
        });

        const highlightStroke = isCurrent
            ? `<rect x="${f2(x - 1.5)}" y="${f2(barTop - 1.5)}" width="${f2(barWidth + 3)}" height="${f2(barHeight + 3)}" `
                + `fill="none" stroke="#ffffff" stroke-width="2" rx="3"/>`
            : '';

        const totalLabel = month.total > 0
            ? `<text x="${f2(x + barWidth / 2)}" y="${f2(Math.max(barTop - 8, 10))}" text-anchor="middle" `
                + `font-size="10" font-weight="700" fill="${isCurrent ? '#ffffff' : '#d4d4d8'}">`
                + `¥${Utils.formatCurrency(month.total)}</text>`
            : '';

        const monthLabel = `<text x="${f2(x + barWidth / 2)}" y="${f2(TREND_HEIGHT - 6)}" text-anchor="middle" `
            + `font-size="11" font-weight="${isCurrent ? '700' : '400'}" fill="${isCurrent ? '#ffffff' : '#a1a1aa'}">`
            + `${Utils.escapeHtml(month.label)}</text>`;

        bars += segments + highlightStroke + totalLabel + monthLabel;
    });

    const svg = `<svg viewBox="0 0 ${TREND_WIDTH} ${TREND_HEIGHT}" class="trend-svg" role="img" `
        + `aria-label="月別支出の推移グラフ" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;

    const legend = categories.map(cat => `
        <div class="trend-legend-item flex items-center gap-1.5">
            <span class="trend-legend-chip h-3 w-3 shrink-0 rounded-sm" style="background:${cat.color}"></span>
            <span class="text-xs text-zinc-300">${Utils.escapeHtml(cat.name)}</span>
        </div>
    `).join('');

    return { svg, legend };
}
