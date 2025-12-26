import { Utils } from './utils.js';
import { BudgetManager, Calculator, CSVExporter } from './budget.js';
import { HolidayCalendar } from './calendar.js';
import { ShoppingList } from './shopping.js';
import { SmartHome } from './smarthome.js';
import { PhilipsHue } from './hue.js';

// アプリケーションクラス
class KakeiboApp {
    constructor() {
        this.budget = new BudgetManager();
        this.calculator = new Calculator();
        this.csv = new CSVExporter(this.budget);
        this.holidayCalendar = new HolidayCalendar();
        this.shopping = new ShoppingList(this.budget);
        this.smartHome = new SmartHome();
        this.hue = new PhilipsHue();
    }

    toggleMenu() {
        document.getElementById('sideMenu').classList.toggle('open');
        document.getElementById('menuOverlay').classList.toggle('show');
    }

    closeMenu() {
        document.getElementById('sideMenu').classList.remove('open');
        document.getElementById('menuOverlay').classList.remove('show');
    }

    showBudget() {
        document.getElementById('calendarSection').style.display = 'none';
        document.getElementById('shoppingSection').style.display = 'none';
        document.getElementById('smartHomeSection').style.display = 'none';
        document.getElementById('budgetSection').style.display = 'block';
        document.querySelector('.footer').style.display = 'block';
        document.getElementById('menuCalendar').style.display = 'block';
        document.getElementById('menuBudget').style.display = 'none';
        document.getElementById('menuShopping').style.display = 'block';
        document.getElementById('menuSmartHome').style.display = 'block';
        
        const jstDate = Utils.getJSTDate();
        this.budget.currentYear = jstDate.getFullYear();
        this.budget.currentMonth = jstDate.getMonth() + 1;
        this.budget.updateDisplay();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    showCalendar() {
        document.getElementById('budgetSection').style.display = 'none';
        document.getElementById('shoppingSection').style.display = 'none';
        document.getElementById('smartHomeSection').style.display = 'none';
        document.getElementById('calendarSection').style.display = 'block';
        document.querySelector('.footer').style.display = 'none';
        document.getElementById('menuCalendar').style.display = 'none';
        document.getElementById('menuBudget').style.display = 'block';
        document.getElementById('menuShopping').style.display = 'block';
        document.getElementById('menuSmartHome').style.display = 'block';
        
        const jstDate = Utils.getJSTDate();
        this.holidayCalendar.currentYear = jstDate.getFullYear();
        this.holidayCalendar.currentMonth = jstDate.getMonth() + 1;
        this.holidayCalendar.renderCalendar();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    showShopping() {
        document.getElementById('budgetSection').style.display = 'none';
        document.getElementById('calendarSection').style.display = 'none';
        document.getElementById('smartHomeSection').style.display = 'none';
        document.getElementById('shoppingSection').style.display = 'block';
        document.querySelector('.footer').style.display = 'none';
        document.getElementById('menuCalendar').style.display = 'block';
        document.getElementById('menuBudget').style.display = 'block';
        document.getElementById('menuShopping').style.display = 'none';
        document.getElementById('menuSmartHome').style.display = 'block';
        
        this.shopping.renderList();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    showSmartHome() {
        document.getElementById('budgetSection').style.display = 'none';
        document.getElementById('calendarSection').style.display = 'none';
        document.getElementById('shoppingSection').style.display = 'none';
        document.getElementById('smartHomeSection').style.display = 'block';
        document.querySelector('.footer').style.display = 'none';
        document.getElementById('menuCalendar').style.display = 'block';
        document.getElementById('menuBudget').style.display = 'block';
        document.getElementById('menuShopping').style.display = 'block';
        document.getElementById('menuSmartHome').style.display = 'none';
        
        this.smartHome.init();
        this.hue.init();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    showSection(section) {
        document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
        event.target.classList.add('active');
        
        if (section === 'budget') {
            this.showBudget();
        }
    }

    init() {
        this.budget.showSyncStatus('syncing', '接続中...');
        this.budget.loadFromFirestore();
        this.budget.updateDisplay();
        this.holidayCalendar.init();
        this.shopping.init();
    }
}

// グローバルインスタンス
const app = new KakeiboApp();
window.app = app;

// 初期化
app.init();
