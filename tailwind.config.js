/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './callback.html',
    './js/**/*.js',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Noto Sans JP"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // 金額・日付などの数字用（レシートの印字のように桁をそろえる）。和文はsansにフォールバック
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', '"Noto Sans JP"', 'monospace'],
      },
      colors: {
        // unslop の graphite ランプ（docs/design.md 参照）。面・枠・文字はこの無彩色だけで組む
        graphite: {
          deep: '#0f0f10',   // サイドメニュー・フッターなど一番奥の面
          page: '#141415',   // ページの背景
          card: '#19191b',   // カード
          raised: '#232325', // 入力欄・選択中の行など一段上の面
        },
        // レシートの紙とインク（合計カードだけに使う見せ場）
        paper: {
          DEFAULT: '#f3eee3',
          edge: '#e6dfd0',
          ink: '#1f1b16',
          muted: '#6b6256',
          accent: '#8a4b08',
        },
      },
    },
  },
  plugins: [],
};
