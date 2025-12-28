/**
 * 家計簿アプリケーション メインモジュール
 * 各機能モジュールを統合し、アプリケーション全体を管理
 */

import { Utils } from './utils.js';
import { BudgetManager, Calculator, CSVExporter } from './budget.js';
import { HolidayCalendar } from './calendar.js';
import { ShoppingList } from './shopping.js';
import { SmartHome } from './smarthome.js';
import { PhilipsHue } from './hue.js';

// ============================================================
// 定数定義
// ============================================================

/** セクションID一覧 */
const SECTIONS = {
    BUDGET: 'budgetSection',
    CALENDAR: 'calendarSection',
    SHOPPING: 'shoppingSection',
    SMART_HOME: 'smartHomeSection'
};

/** メニュー項目ID一覧 */
const MENU_ITEMS = {
    BUDGET: 'menuBudget',
    CALENDAR: 'menuCalendar',
    SHOPPING: 'menuShopping',
    SMART_HOME: 'menuSmartHome'
};

// ============================================================
// アプリケーションクラス
// ============================================================

/**
 * 家計簿アプリケーションのメインクラス
 * 各機能モジュールのインスタンスを管理し、ナビゲーションを制御
 */
class KakeiboApp {
    constructor() {
        // 各機能モジュールのインスタンス化
        this.budget = new BudgetManager();
        this.calculator = new Calculator();
        this.csv = new CSVExporter(this.budget);
        this.holidayCalendar = new HolidayCalendar();
        this.shopping = new ShoppingList(this.budget);
        this.smartHome = new SmartHome();
        this.hue = new PhilipsHue();
    }

    // ==================== メニュー制御 ====================

    /**
     * サイドメニューの開閉を切り替え
     */
    toggleMenu() {
        document.getElementById('sideMenu')?.classList.toggle('open');
        document.getElementById('menuOverlay')?.classList.toggle('show');
    }

    /**
     * サイドメニューを閉じる
     */
    closeMenu() {
        document.getElementById('sideMenu')?.classList.remove('open');
        document.getElementById('menuOverlay')?.classList.remove('show');
    }

    // ==================== セクション表示制御 ====================

    /**
     * 指定されたセクションを表示し、他を非表示に
     * @private
     * @param {string} activeSection - 表示するセクションのキー
     * @param {string} hiddenMenuItem - 非表示にするメニュー項目のキー
     * @param {boolean} showFooter - フッターを表示するか
     */
    _showSection(activeSection, hiddenMenuItem, showFooter = false) {
        // 全セクションを非表示
        Object.values(SECTIONS).forEach(id => Utils.setVisible(id, false));
        
        // 対象セクションを表示
        Utils.setVisible(activeSection, true);
        
        // フッター制御
        const footer = document.querySelector('.footer');
        if (footer) footer.style.display = showFooter ? 'block' : 'none';
        
        // メニュー項目の表示制御
        Object.values(MENU_ITEMS).forEach(id => Utils.setVisible(id, true));
        Utils.setVisible(hiddenMenuItem, false);
        
        // ページトップにスクロール
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    /**
     * 家計簿セクションを表示
     */
    showBudget() {
        this._showSection(SECTIONS.BUDGET, MENU_ITEMS.BUDGET, true);
        
        // 現在の日付に設定
        const jstDate = Utils.getJSTDate();
        this.budget.currentYear = jstDate.getFullYear();
        this.budget.currentMonth = jstDate.getMonth() + 1;
        this.budget.updateDisplay();
    }

    /**
     * カレンダーセクションを表示
     */
    showCalendar() {
        this._showSection(SECTIONS.CALENDAR, MENU_ITEMS.CALENDAR);
        
        // 現在の日付に設定
        const jstDate = Utils.getJSTDate();
        this.holidayCalendar.currentYear = jstDate.getFullYear();
        this.holidayCalendar.currentMonth = jstDate.getMonth() + 1;
        this.holidayCalendar.renderCalendar();
    }

    /**
     * 買い物リストセクションを表示
     */
    showShopping() {
        this._showSection(SECTIONS.SHOPPING, MENU_ITEMS.SHOPPING);
        this.shopping.renderList();
    }

    /**
     * スマートホームセクションを表示
     */
    showSmartHome() {
        this._showSection(SECTIONS.SMART_HOME, MENU_ITEMS.SMART_HOME);
        this.smartHome.init();
        this.hue.init();
    }

    /**
     * セクションを表示（ナビボタン用）
     * @param {string} section - セクション名
     */
    showSection(section) {
        // ナビボタンのアクティブ状態を更新
        document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
        event?.target?.classList.add('active');
        
        if (section === 'budget') this.showBudget();
    }

    // ==================== 初期化 ====================

    /**
     * アプリケーションを初期化
     */
    init() {
        // 同期ステータスを表示
        this.budget.showSyncStatus('syncing', '接続中...');
        
        // データ読み込み
        this.budget.loadFromFirestore();
        this.budget.updateDisplay();
        
        // 各モジュールの初期化
        this.holidayCalendar.init();
        this.shopping.init();
    }
}

// ============================================================
// グローバル初期化
// ============================================================

// アプリケーションインスタンスを作成しグローバルに公開
const app = new KakeiboApp();
window.app = app;

// アプリケーションを初期化
app.init();
