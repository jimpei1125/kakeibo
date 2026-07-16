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

// ============================================================
// 月次推移グラフ（積み上げ棒グラフ）
// ============================================================

const TREND_VIEW_W = 300;
const TREND_VIEW_H = 200;
const TREND_PAD_TOP = 26;
const TREND_PAD_BOTTOM = 22;
const TREND_PAD_SIDE = 10;
const TREND_BAR_GAP = 10;
const TREND_SEG_GAP = 2; // 積み上げセグメント間の隙間（2px相当）

/**
 * 金額を軸ラベル用にコンパクト表記（1万円以上は「○.○万」）
 * @param {number} amount
 * @returns {string}
 */
function formatCompact(amount) {
    if (amount >= 10000) return `${Math.round(amount / 1000) / 10}万`;
    return Utils.formatCurrency(amount);
}

/**
 * 直近複数ヶ月の合計金額を積み上げ棒グラフで描画
 * カテゴリの色・積み上げ順は呼び出し側（BudgetManager._getTrendData）で
 * 全期間を通して固定済みのものを渡す前提（月をまたいで同じ色を維持するため）
 * @param {Array<{monthKey: string, label: string, segments: Array<{name:string, amount:number, color:string}>, total: number}>} months
 * @param {string} highlightMonthKey - 現在表示中の月（バーを強調表示）
 * @returns {{svg: string, legend: string}}
 */
export function buildTrendChart(months, highlightMonthKey) {
    if (!months.length || !months.some(m => m.total > 0)) {
        return { svg: '', legend: '' };
    }

    const maxTotal = Math.max(...months.map(m => m.total), 1);
    const chartH = TREND_VIEW_H - TREND_PAD_TOP - TREND_PAD_BOTTOM;
    const chartW = TREND_VIEW_W - TREND_PAD_SIDE * 2;
    const n = months.length;
    const barW = (chartW - TREND_BAR_GAP * (n - 1)) / n;
    const baselineY = TREND_VIEW_H - TREND_PAD_BOTTOM;

    let bars = '';
    let totalLabels = '';
    let monthLabels = '';

    months.forEach((month, i) => {
        const x = TREND_PAD_SIDE + i * (barW + TREND_BAR_GAP);
        const isCurrent = month.monthKey === highlightMonthKey;
        const barTotalH = (month.total / maxTotal) * chartH;
        const activeSegments = month.segments.filter(s => s.amount > 0);

        // セグメントを下から積み上げ（隣接セグメント間に2pxの隙間）
        let cursorY = baselineY;
        activeSegments.forEach((seg) => {
            const rawH = (seg.amount / maxTotal) * chartH;
            const segH = Math.max(0, rawH - (activeSegments.length > 1 ? TREND_SEG_GAP : 0));
            const y = cursorY - segH;
            if (segH > 0) {
                bars += `<rect x="${f2(x)}" y="${f2(y)}" width="${f2(barW)}" height="${f2(segH)}" rx="2" fill="${seg.color}"${isCurrent ? '' : ' opacity="0.82"'}/>`;
            }
            cursorY = y - TREND_SEG_GAP;
        });

        // 合計ラベル（現在月は白太字、他の月は控えめなグレー）
        const labelY = Math.max(baselineY - barTotalH - 8, 10);
        const totalLabelAttrs = isCurrent
            ? `font-size="11" font-weight="700" fill="#ffffff"`
            : `font-size="9" font-weight="600" fill="#a1a1aa"`;
        totalLabels += `<text x="${f2(x + barW / 2)}" y="${f2(labelY)}" text-anchor="middle" ${totalLabelAttrs}>${formatCompact(month.total)}</text>`;

        // 月ラベル（現在月を強調）
        const monthLabelAttrs = isCurrent ? `fill="#ffffff" font-weight="700"` : `fill="#71717a"`;
        monthLabels += `<text x="${f2(x + barW / 2)}" y="${f2(TREND_VIEW_H - 6)}" text-anchor="middle" font-size="10" ${monthLabelAttrs}>${Utils.escapeHtml(month.label)}</text>`;
    });

    const baseline = `<line x1="${TREND_PAD_SIDE}" y1="${baselineY}" x2="${TREND_VIEW_W - TREND_PAD_SIDE}" y2="${baselineY}" stroke="#3f3f46" stroke-width="1"/>`;

    const svg = `<svg viewBox="0 0 ${TREND_VIEW_W} ${TREND_VIEW_H}" class="trend-svg" role="img" aria-label="月次推移グラフ" `
        + `xmlns="http://www.w3.org/2000/svg">${baseline}${bars}${totalLabels}${monthLabels}</svg>`;

    // 凡例: 出現したカテゴリを初出順に（色チップ＋名前のみ。金額は棒の直接ラベルで代用）
    const seen = new Set();
    const legendItems = [];
    months.forEach(month => month.segments.forEach(seg => {
        if (seg.amount > 0 && !seen.has(seg.name)) {
            seen.add(seg.name);
            legendItems.push(seg);
        }
    }));

    const legend = legendItems.map(item => `
        <span class="trend-legend-item inline-flex items-center gap-1.5 text-xs text-zinc-300">
            <span class="trend-legend-chip h-2.5 w-2.5 shrink-0 rounded-sm" style="background:${item.color}"></span>${Utils.escapeHtml(item.name)}
        </span>
    `).join('');

    return { svg, legend };
}
