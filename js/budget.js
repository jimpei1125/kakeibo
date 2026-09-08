/**
 * 家計簿モジュール
 * 予算管理（BudgetManager）を提供。
 * 計算機・CSV出力・明細読み込み・月間コピーはそれぞれ別モジュールに分割済み
 * （calculator.js / csv-export.js / statement-import.js / copy-month.js）
 */

import { db, doc, getDoc, setDoc, onSnapshot, collection } from './firebase-config.js';
import { Utils } from './utils.js';
import { Icons } from './icons.js';
import { Dialog } from './dialog.js';
import { buildPie, buildTrendChart, CATEGORY_COLORS, OTHER_COLOR } from './chart.js';

// ============================================================
// 定数定義
// ============================================================

/** 同期ステータスの自動非表示時間（ミリ秒） */
const SYNC_STATUS_HIDE_DELAY = 2000;

/** 同期ステータスの種類 */
const SYNC_STATUS = {
    SYNCING: 'syncing',
    SYNCED: 'synced',
    ERROR: 'error'
};

/**
 * カテゴリの表示金額を計算する
 * 小カテゴリーを持つ場合はその合計、持たない場合はカテゴリ直接の金額
 * @param {{amount?: number, subcategories?: Array<{amount?: number}>}} category
 * @returns {number}
 */
export function categoryDisplayAmount(category) {
    return category.subcategories?.length > 0
        ? category.subcategories.reduce((sum, sub) => sum + (sub.amount || 0), 0)
        : (category.amount || 0);
}

// ============================================================
// 予算管理クラス
// ============================================================

/**
 * 家計簿の予算管理を行うメインクラス
 */
export class BudgetManager {
    constructor() {
        const now = new Date();
        /** @type {number} 現在表示中の年 */
        this.currentYear = now.getFullYear();
        /** @type {number} 現在表示中の月 */
        this.currentMonth = now.getMonth() + 1;
        /** @type {Object} 全予算データ（月キー→月データ） */
        this.data = {};
        /** @type {boolean} 初回読み込みフラグ */
        this.isInitialLoad = true;
        /** @type {boolean} クイック入力モード */
        this.quickInputMode = false;
        /** @type {boolean} 旧形式データの移行チェック済みフラグ */
        this._migrationChecked = false;
        /** @type {boolean} 合計カードが円グラフ面を表示中か */
        this.totalFlipped = false;
        /** @type {'pie'|'trend'} 合計カード裏面のタブ（内訳／推移） */
        this.breakdownTab = 'pie';
        /** @type {import('./recurring.js').RecurringManager|null} 固定費マネージャー（app.jsから注入） */
        this.recurringManager = null;
        /** @type {Set<string>} 固定費自動記帳を試行済みの月キー（セッション内で1回のみ） */
        this._autoEntryAttempted = new Set();
        /** @type {boolean} 明細のドラッグ並び替え中か（同期による再描画をスキップする） */
        this._reordering = false;
        /** @type {boolean} テキスト出力を詳細（全小カテゴリー展開）にするか。false=概要（上位のみ圧縮） */
        this.outputDetailMode = this._loadOutputDetailMode();
    }

    /**
     * テキスト出力モードの保存値を復元する（デフォルトは概要）
     * @private
     * @returns {boolean}
     */
    _loadOutputDetailMode() {
        try {
            return localStorage.getItem('budgetOutputDetailMode') === 'detail';
        } catch {
            return false;
        }
    }

    // ----------------------------------------
    // クイック入力モード
    // ----------------------------------------

    /**
     * クイック入力モードを切り替え
     */
    toggleQuickInputMode() {
        this.quickInputMode = !this.quickInputMode;
        
        // モード終了時は全体を再描画して最新状態に
        this.updateDisplay();
        
        // フッターのボタン状態を更新
        const footerBtn = document.getElementById('footerQuickInput');
        if (footerBtn) {
            footerBtn.classList.toggle('active', this.quickInputMode);
            // アイコンは維持し、ラベルのみ差し替え
            const label = footerBtn.querySelector('.nav-label');
            if (label) label.textContent = this.quickInputMode ? 'ON' : 'クイック入力';
        }
        
        if (this.quickInputMode) {
            Utils.showToast('クイック入力モード ON');
            // 最初の入力欄にフォーカス
            setTimeout(() => {
                const firstInput = document.querySelector('.quick-input-field');
                if (firstInput) firstInput.focus();
            }, 100);
        } else {
            Utils.showToast('クイック入力モード OFF');
        }
    }

    /**
     * クイック入力のフォームsubmit処理
     * @param {string} categoryIdStr - カテゴリID（安全な文字列形式）
     * @param {string|null} subIdStr - サブカテゴリID（安全な文字列形式）
     * @param {Event} event - submitイベント
     * @returns {boolean} false（フォーム送信を防止）
     */
    quickInputSubmit(categoryIdStr, subIdStr, event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        this.quickAddAmount(categoryIdStr, subIdStr);
        return false;
    }

    /**
     * クイック入力で金額を追加
     * @param {string} categoryIdStr - カテゴリID（安全な文字列形式、ハイフン区切り）
     * @param {string|null} subIdStr - サブカテゴリID（安全な文字列形式）
     */
    quickAddAmount(categoryIdStr, subIdStr = null) {
        // 安全な文字列IDから元のIDを復元（ハイフンを小数点に戻す）
        const categoryId = parseFloat(String(categoryIdStr).replaceAll('-', '.'));
        const subId = subIdStr ? parseFloat(String(subIdStr).replaceAll('-', '.')) : null;

        const inputId = subIdStr ? `quick-sub-${categoryIdStr}-${subIdStr}` : `quick-${categoryIdStr}`;
        const input = document.getElementById(inputId);

        if (!input) {
            Utils.showToast('エラー: 入力欄が見つかりません');
            return;
        }

        const amount = parseFloat(input.value);
        if (!amount || isNaN(amount)) {
            Utils.showToast('金額を入力してください');
            return;
        }

        const category = this._findCategory(categoryId);
        if (!category) {
            Utils.showToast('エラー: カテゴリが見つかりません');
            return;
        }

        if (subId) {
            const sub = category.subcategories.find(s => s.id === subId);
            if (sub) {
                sub.amount = (sub.amount || 0) + amount;
                // サブカテゴリの金額表示を部分更新
                const subAmountInput = document.getElementById(`subamount-${categoryId}-${subId}`);
                if (subAmountInput) subAmountInput.value = sub.amount;
            }
        } else {
            category.amount = (category.amount || 0) + amount;
            // カテゴリの金額表示を部分更新
            const amountInput = document.getElementById(`amount-${categoryId}`);
            if (amountInput) amountInput.value = category.amount;
        }

        // サマリーと合計の表示を部分更新（DOM全体は再描画しない＝フォーカス維持）
        this._updateCategorySummaryAmount(categoryId);
        this._updateTotalDisplay();

        // 入力欄をクリア（フォーカスは維持）
        input.value = '';

        // 成功フィードバック
        input.classList.add('quick-input-success');
        setTimeout(() => input.classList.remove('quick-input-success'), 300);

        Utils.showToast(`+¥${Utils.formatCurrency(amount)} 追加`);

        // Firestoreに保存（スナップショット受信時の再描画はクイック入力中スキップされる）
        this.saveToFirestore();
    }
    
    /**
     * カテゴリサマリーの金額表示を更新
     * @private
     */
    _updateCategorySummaryAmount(categoryId) {
        const category = this._findCategory(categoryId);
        if (!category) return;

        const displayAmount = categoryDisplayAmount(category);

        // icon要素からサマリー行を取得（getElementByIdは小数点を含むIDでも動作）
        const iconEl = document.getElementById(`icon-${categoryId}`);
        if (iconEl) {
            const summaryEl = iconEl.closest('.category-summary');
            if (summaryEl) {
                const amountEl = summaryEl.querySelector('.category-summary-amount');
                if (amountEl) {
                    amountEl.textContent = `${Utils.formatCurrency(displayAmount)}円`;
                }
            }
        }
    }
    
    /**
     * 合計金額の表示を更新
     * @private
     */
    _updateTotalDisplay() {
        const total = this.calculateTotal();
        const settlement = this.calculateSettlement();

        const totalEl = document.getElementById('totalAmount');
        const breakdownEl = document.getElementById('settlementBreakdown');
        const settlementEl = document.getElementById('settlementAmount');
        const outputEl = document.getElementById('outputText');

        if (totalEl) totalEl.textContent = `¥${Utils.formatCurrency(total)}`;
        if (breakdownEl) {
            breakdownEl.textContent = `夫払い ¥${Utils.formatCurrency(settlement.husband)} / 妻払い ¥${Utils.formatCurrency(settlement.wife)}`;
        }
        if (settlementEl) settlementEl.textContent = `精算: ${this._formatSettlementLabel(settlement)}`;
        if (outputEl) outputEl.textContent = this.generateOutput();
        this._updateOutputModeToggle();

        // ミニヘッダーの合計額も追従
        const miniTotalEl = document.getElementById('miniHeaderTotal');
        if (miniTotalEl) miniTotalEl.textContent = `¥${Utils.formatCurrency(total)}`;

        // 円グラフ面を表示中ならグラフも更新
        if (this.totalFlipped) this.renderPie();
    }

    // ----------------------------------------
    // データアクセス
    // ----------------------------------------

    /**
     * 現在の年月キーを取得
     * @returns {string} YYYY-MM形式
     */
    getCurrentMonthKey() {
        return Utils.getMonthKey(this.currentYear, this.currentMonth);
    }

    /**
     * 指定した月のデータを取得（なければ初期化）
     * @param {string} monthKey - YYYY-MM形式の月キー
     * @returns {Object} 月データ
     */
    getMonthData(monthKey) {
        if (!this.data[monthKey]) {
            this.data[monthKey] = { categories: [] };
        }
        return this.data[monthKey];
    }

    /**
     * 現在の月のデータを取得（なければ初期化）
     * @returns {Object} 月データ
     */
    getCurrentMonthData() {
        return this.getMonthData(this.getCurrentMonthKey());
    }

    // ----------------------------------------
    // 同期ステータス
    // ----------------------------------------

    /**
     * 同期ステータスを表示
     * @param {string} status - syncing|synced|error
     * @param {string} message - 表示メッセージ
     */
    showSyncStatus(status, message) {
        const statusEl = document.getElementById('syncStatus');
        if (!statusEl) return;
        
        statusEl.className = `sync-status ${status}`;
        statusEl.textContent = message;
        statusEl.style.display = 'block';
    }

    /**
     * 同期ステータスを自動で非表示に
     * @private
     */
    _hideSyncStatusAfterDelay() {
        setTimeout(() => {
            const statusEl = document.getElementById('syncStatus');
            if (statusEl?.textContent === '✓ 同期完了') {
                statusEl.style.display = 'none';
            }
        }, SYNC_STATUS_HIDE_DELAY);
    }

    // ----------------------------------------
    // Firestore操作
    // ----------------------------------------

    /**
     * Firestoreにデータを保存（現在表示中の月のドキュメントのみ）
     *
     * 全月を1ドキュメントに一括保存する旧方式は、複数端末の同時編集や
     * 古い端末からの保存で他の月のデータまで巻き戻る危険があったため、
     * 編集対象の月だけを budgetMonths/{YYYY-MM} に保存する方式に変更。
     */
    async saveToFirestore() {
        const monthKey = this.getCurrentMonthKey();
        const monthData = this.data[monthKey] || { categories: [] };
        try {
            await setDoc(doc(db, 'budgetMonths', monthKey), monthData);
            this.showSyncStatus(SYNC_STATUS.SYNCED, '✓ 同期完了');
            this._hideSyncStatusAfterDelay();
        } catch (error) {
            console.error('Firestore保存エラー:', error);
            this.showSyncStatus(SYNC_STATUS.ERROR, `✗ 同期エラー: ${error.message}`);
        }
    }

    /**
     * Firestoreからデータをリアルタイム購読（budgetMonthsコレクション全体）
     */
    loadFromFirestore() {
        onSnapshot(
            collection(db, 'budgetMonths'),
            (snap) => this._handleMonthsSnapshot(snap),
            (error) => {
                console.error('Firestore読み込みエラー:', error);
                this.showSyncStatus(SYNC_STATUS.ERROR, `✗ 接続エラー: ${error.message}`);
            }
        );
    }

    /**
     * 月コレクションのスナップショット受信時の処理
     * @private
     * @param {Object} snap - QuerySnapshot
     */
    _handleMonthsSnapshot(snap) {
        // コレクション全体から月データを再構築
        const newData = {};
        snap.forEach(docSnap => {
            newData[docSnap.id] = docSnap.data();
        });
        this.data = newData;

        // 初回かつ空 → 旧形式（budgetData/data）からの移行を試みる
        if (this.isInitialLoad && snap.empty && !this._migrationChecked) {
            this._migrationChecked = true;
            this._migrateLegacyData();
            return; // 移行後にsnapshotが再発火するのでここでは描画しない
        }

        // クイック入力中・ドラッグ並び替え中はDOM再描画をスキップ
        // （フォーカス維持／ドラッグ中の行が消えるのを防ぐ）
        if (!this.quickInputMode && !this._reordering) {
            this.updateDisplay();
        }

        if (this.isInitialLoad) {
            // isInitialLoad解除を先に行う（updateDisplay内の固定費自動記帳判定が
            // 「初回読み込み未完了」を理由にスキップされないようにするため）
            this._finishInitialLoad('✓ データ読み込み完了');
            this.updateDisplay(); // 初回は必ず描画
        }
    }

    /**
     * 旧形式データ（budgetData/data の全月一括ドキュメント）を
     * 月別ドキュメント（budgetMonths/{YYYY-MM}）へ移行する（初回のみ）
     * @private
     */
    async _migrateLegacyData() {
        const legacyRef = doc(db, 'budgetData', 'data');
        try {
            const legacy = await getDoc(legacyRef);

            // 既に移行済みマークがあれば何もしない（削除済みデータの復活を防ぐ）
            if (legacy.exists() && legacy.data().migrated) {
                this._finishInitialLoad('✓ 接続完了');
                return;
            }

            const legacyMonths = legacy.exists() ? legacy.data().data : null;
            if (legacyMonths && Object.keys(legacyMonths).length > 0) {
                // 各月を個別ドキュメントとして書き込み
                for (const monthKey of Object.keys(legacyMonths)) {
                    await setDoc(doc(db, 'budgetMonths', monthKey), legacyMonths[monthKey]);
                }
                // 再移行を防ぐマークを付与（元データはバックアップとして残す）
                await setDoc(legacyRef, { migrated: true }, { merge: true });
                Utils.showToast('データを新形式に移行しました');
                // 書き込みによりコレクションのsnapshotが再発火し、そこで描画される
            } else {
                // 移行元データなし → マークだけ付けて空表示
                if (legacy.exists()) {
                    await setDoc(legacyRef, { migrated: true }, { merge: true });
                }
                this._finishInitialLoad('✓ 接続完了（データなし）');
            }
        } catch (error) {
            console.error('データ移行エラー:', error);
            // 移行に失敗しても空データで初期表示は完了させる
            this._finishInitialLoad('✓ 接続完了');
        }
    }

    /**
     * 初回読み込み完了処理（同期ステータス表示と自動非表示）
     * @private
     * @param {string} message - 表示メッセージ
     */
    _finishInitialLoad(message) {
        this.showSyncStatus(SYNC_STATUS.SYNCED, message);
        this.isInitialLoad = false;
        setTimeout(() => {
            const statusEl = document.getElementById('syncStatus');
            if (statusEl) statusEl.style.display = 'none';
        }, SYNC_STATUS_HIDE_DELAY);
    }

    // ----------------------------------------
    // 月切り替え
    // ----------------------------------------

    /**
     * 月を変更
     * @param {number} delta - 増減値（-1: 前月, 1: 翌月）
     */
    changeMonth(delta) {
        const { year, month } = Utils.shiftMonth(this.currentYear, this.currentMonth, delta);
        this.currentYear = year;
        this.currentMonth = month;

        // 月を切り替えたら合計カードは表（合計金額）に戻す
        this._resetTotalView();
        this._animateMonthChange();
    }

    /**
     * 月切り替え時のアニメーション
     * @private
     */
    _animateMonthChange() {
        const monthDisplay = document.getElementById('currentMonth');
        if (!monthDisplay) return;
        
        monthDisplay.style.opacity = '0';
        monthDisplay.style.transform = 'scale(0.9)';
        
        setTimeout(() => {
            this.updateDisplay();
            monthDisplay.style.transition = 'all 0.3s ease';
            monthDisplay.style.opacity = '1';
            monthDisplay.style.transform = 'scale(1)';
        }, 150);
    }

    // ----------------------------------------
    // カテゴリ操作
    // ----------------------------------------

    /**
     * カテゴリー追加シートを表示
     */
    showAddCategorySheet() {
        Utils.showModal('addCategorySheet');
        // シートのスライドインが終わる頃に名前欄へフォーカス（即入力できるように）
        setTimeout(() => document.getElementById('newCategoryName')?.focus(), 150);
    }

    /**
     * カテゴリー追加シートを閉じる
     */
    closeAddCategorySheet() {
        Utils.closeModal('addCategorySheet');
        Utils.clearInputs(['newCategoryName', 'newCategoryAmount', 'newCategoryBudget', 'newCategoryNote']);
    }

    /**
     * 新規カテゴリを追加
     */
    addCategory() {
        const name = document.getElementById('newCategoryName')?.value.trim();
        const amount = document.getElementById('newCategoryAmount')?.value;
        const budget = document.getElementById('newCategoryBudget')?.value;
        const note = document.getElementById('newCategoryNote')?.value.trim();

        if (!name) {
            Utils.showToast('カテゴリー名を入力してください', 'error');
            return;
        }

        this.getCurrentMonthData().categories.push({
            id: Utils.generateId(),
            name,
            amount: amount ? parseFloat(amount) : 0,
            budget: budget ? parseFloat(budget) : 0,
            note: note || '',
            subcategories: []
        });

        this.closeAddCategorySheet();
        this.saveWithStatus();
    }

    /**
     * カテゴリを削除
     * @param {number} categoryId - カテゴリID
     */
    async deleteCategory(categoryId) {
        const confirmed = await Dialog.confirm('このカテゴリーを削除しますか？', { okLabel: '削除', danger: true });
        if (!confirmed) return;

        const monthData = this.getCurrentMonthData();
        monthData.categories = monthData.categories.filter(c => c.id !== categoryId);
        this.saveWithStatus();
    }

    /**
     * カテゴリ名を編集
     * @param {number} categoryId - カテゴリID
     */
    async editCategory(categoryId) {
        const category = this._findCategory(categoryId);
        if (!category) return;

        const newName = await Dialog.prompt('カテゴリー名を入力:', category.name);
        if (newName?.trim()) {
            category.name = newName.trim();
            this.saveWithStatus();
        }
    }

    // ----------------------------------------
    // サブカテゴリ操作
    // ----------------------------------------

    /**
     * サブカテゴリを追加
     * @param {number} categoryId - 親カテゴリID
     */
    addSubcategory(categoryId) {
        const name = document.getElementById(`subname-${categoryId}`)?.value.trim();
        const amount = document.getElementById(`subamount-${categoryId}`)?.value;
        const note = document.getElementById(`subnote-${categoryId}`)?.value.trim();

        if (!name) {
            Utils.showToast('項目名を入力してください', 'error');
            return;
        }

        const category = this._findCategory(categoryId);
        if (!category) return;
        
        category.subcategories.push({
            id: Utils.generateId(),
            name,
            amount: amount ? parseFloat(amount) : 0,
            note: note || ''
        });

        Utils.clearInputs([
            `subname-${categoryId}`,
            `subamount-${categoryId}`,
            `subnote-${categoryId}`
        ]);
        this.saveWithStatus();

        // 続けて次の明細を入力できるよう、名前欄へフォーカスを戻す
        // （保存による再描画後もupdateDisplayのフォーカス復元で維持される）
        document.getElementById(`subname-${categoryId}`)?.focus({ preventScroll: true });
    }

    /**
     * サブカテゴリを削除
     * @param {number} categoryId - 親カテゴリID
     * @param {number} subcategoryId - サブカテゴリID
     */
    async deleteSubcategory(categoryId, subcategoryId) {
        const confirmed = await Dialog.confirm('この項目を削除しますか？', { okLabel: '削除', danger: true });
        if (!confirmed) return;

        const category = this._findCategory(categoryId);
        if (!category) return;

        category.subcategories = category.subcategories.filter(s => s.id !== subcategoryId);
        this.saveWithStatus();
    }

    /**
     * サブカテゴリ名を編集
     * @param {number} categoryId - 親カテゴリID
     * @param {number} subcategoryId - サブカテゴリID
     */
    async editSubcategory(categoryId, subcategoryId) {
        const category = this._findCategory(categoryId);
        const subcategory = category?.subcategories.find(s => s.id === subcategoryId);
        if (!subcategory) return;

        const newName = await Dialog.prompt('項目名を入力:', subcategory.name);
        if (newName?.trim()) {
            subcategory.name = newName.trim();
            this.saveWithStatus();
        }
    }

    // ----------------------------------------
    // 金額・備考の更新
    // ----------------------------------------

    /**
     * 金額を更新
     * @param {number} categoryId - カテゴリID
     * @param {number|null} subcategoryId - サブカテゴリID（カテゴリ直接の場合はnull）
     */
    updateAmount(categoryId, subcategoryId) {
        const category = this._findCategory(categoryId);
        if (!category) return;

        if (subcategoryId === null) {
            const input = document.getElementById(`amount-${categoryId}`);
            category.amount = parseFloat(input?.value) || 0;
        } else {
            const subcategory = category.subcategories.find(s => s.id === subcategoryId);
            if (subcategory) {
                const input = document.getElementById(`subamount-${categoryId}-${subcategoryId}`);
                subcategory.amount = parseFloat(input?.value) || 0;
            }
        }
        this.saveWithStatus();
        Utils.showToast('保存しました');
    }

    /**
     * カテゴリの予算額を更新
     * @param {number} categoryId - カテゴリID
     */
    updateBudget(categoryId) {
        const category = this._findCategory(categoryId);
        if (!category) return;

        const input = document.getElementById(`budget-${categoryId}`);
        category.budget = parseFloat(input?.value) || 0;

        this.saveWithStatus();
        Utils.showToast('保存しました');
    }

    /**
     * 備考を更新
     * @param {number} categoryId - カテゴリID
     * @param {number|null} subcategoryId - サブカテゴリID
     */
    updateNote(categoryId, subcategoryId) {
        const category = this._findCategory(categoryId);
        if (!category) return;

        if (subcategoryId === null) {
            const input = document.getElementById(`note-${categoryId}`);
            category.note = input?.value.trim() || '';
        } else {
            const subcategory = category.subcategories.find(s => s.id === subcategoryId);
            if (subcategory) {
                const input = document.getElementById(`subnote-edit-${categoryId}-${subcategoryId}`);
                subcategory.note = input?.value.trim() || '';
            }
        }
        this.saveWithStatus();
        Utils.showToast('保存しました');
    }

    /**
     * 支払者（夫／妻）を切り替える
     * @param {number} categoryId - カテゴリID
     * @param {number|null} subcategoryId - サブカテゴリID（カテゴリ直接の場合はnull）
     */
    togglePayer(categoryId, subcategoryId) {
        const category = this._findCategory(categoryId);
        if (!category) return;

        const target = subcategoryId === null
            ? category
            : category.subcategories.find(s => s.id === subcategoryId);
        if (!target) return;

        // 夫払いに戻すときはキーごと削除する（undefinedを代入するとFirestoreの保存が失敗する）
        if (target.payer === 'wife') {
            delete target.payer;
        } else {
            target.payer = 'wife';
        }
        const isWife = target.payer === 'wife';

        // チップの見た目を即時更新（DOM全体は再描画しない＝アコーディオンの開閉状態を維持）
        const chipId = subcategoryId === null ? `payer-${categoryId}` : `payer-${categoryId}-${subcategoryId}`;
        const chip = document.getElementById(chipId);
        if (chip) {
            chip.textContent = isWife ? '妻' : '夫';
            chip.classList.toggle('bg-pink-500/15', isWife);
            chip.classList.toggle('text-pink-300', isWife);
            chip.classList.toggle('ring-pink-500/30', isWife);
            chip.classList.toggle('bg-white/10', !isWife);
            chip.classList.toggle('text-zinc-300', !isWife);
            chip.classList.toggle('ring-white/10', !isWife);
        }

        this._updateTotalDisplay();
        this.saveWithStatus();
    }

    // ----------------------------------------
    // アコーディオン
    // ----------------------------------------

    /**
     * アコーディオンの開閉を切り替え
     * @param {number} categoryId - カテゴリID
     */
    toggleAccordion(categoryId) {
        const details = document.getElementById(`details-${categoryId}`);
        const icon = document.getElementById(`icon-${categoryId}`);

        details?.classList.toggle('open');
        icon?.classList.toggle('open');
    }

    // ----------------------------------------
    // 明細の並び替え（ドラッグハンドル）
    // ----------------------------------------

    /**
     * 大カテゴリーの並び替えドラッグを開始
     * @param {PointerEvent} event
     * @param {number} categoryId
     */
    startCategoryDrag(event, categoryId) {
        const container = document.getElementById('categoryList');
        const item = container?.querySelector(`.category-item[data-cat-id="${categoryId}"]`);
        if (!container || !item) return;

        // ドラッグ開始時は全アコーディオンを閉じて高さを揃える（並び替え中の見た目を安定させるため）
        container.querySelectorAll('.category-details.open').forEach(el => el.classList.remove('open'));
        container.querySelectorAll('.accordion-icon.open').forEach(el => el.classList.remove('open'));

        this._beginDrag(event, {
            container,
            item,
            itemSelector: '.category-item',
            onDrop: (fromIndex, toIndex) => {
                const monthData = this.getCurrentMonthData();
                const [moved] = monthData.categories.splice(fromIndex, 1);
                monthData.categories.splice(toIndex, 0, moved);
                this.updateDisplay();
                this.saveWithStatus();
            }
        });
    }

    /**
     * 小カテゴリーの並び替えドラッグを開始
     * @param {PointerEvent} event
     * @param {number} categoryId - 親カテゴリID
     * @param {number} subId - 小カテゴリID
     */
    startSubcategoryDrag(event, categoryId, subId) {
        const container = document.getElementById(`sublist-${categoryId}`);
        const item = container?.querySelector(`.subcategory-item[data-sub-id="${subId}"]`);
        if (!container || !item) return;

        this._beginDrag(event, {
            container,
            item,
            itemSelector: '.subcategory-item',
            onDrop: (fromIndex, toIndex) => {
                const category = this._findCategory(categoryId);
                if (!category) return;
                const [moved] = category.subcategories.splice(fromIndex, 1);
                category.subcategories.splice(toIndex, 0, moved);
                // 親カテゴリの開閉状態を保ったまま、サブカテゴリ一覧だけ再描画
                container.innerHTML = this._renderSubcategoryItems(category);
                this.saveWithStatus();
            }
        });
    }

    /**
     * ポインタードラッグによる並び替えの汎用エンジン
     * グリップ（onpointerdown）から呼ばれ、ポインター移動に追従して対象要素を
     * 視覚的に移動させ、通過した兄弟要素をtransformで滑らかに詰める。
     * 指を離した時点の順序を onDrop(fromIndex, toIndex) に渡す。
     * @private
     * @param {PointerEvent} event
     * @param {{container: HTMLElement, item: HTMLElement, itemSelector: string, onDrop: Function}} config
     */
    _beginDrag(event, { container, item, itemSelector, onDrop }) {
        event.preventDefault();
        const grip = event.currentTarget;
        const pointerId = event.pointerId;

        const items = Array.from(container.querySelectorAll(`:scope > ${itemSelector}`));
        const fromIndex = items.indexOf(item);
        if (fromIndex === -1) return;

        const rects = items.map(el => el.getBoundingClientRect());
        const step = items.length > 1
            ? rects[1].top - rects[0].top
            : rects[0].height + 10;

        this._reordering = true;
        item.classList.add('dragging');
        document.body.classList.add('reorder-active');

        const startY = event.clientY;
        let currentIndex = fromIndex;

        const move = (e) => {
            const dy = e.clientY - startY;
            item.style.transform = `translateY(${dy}px)`;

            const rawIndex = fromIndex + Math.round(dy / step);
            const newIndex = Math.max(0, Math.min(items.length - 1, rawIndex));
            if (newIndex === currentIndex) return;

            items.forEach((el, i) => {
                if (el === item) return;
                let shift = 0;
                if (newIndex > fromIndex && i > fromIndex && i <= newIndex) {
                    shift = -step; // 下方向へドラッグ：通過した項目は1つ前に詰める
                } else if (newIndex < fromIndex && i >= newIndex && i < fromIndex) {
                    shift = step; // 上方向へドラッグ：通過した項目は1つ後ろへ
                }
                el.style.transform = shift ? `translateY(${shift}px)` : '';
            });

            currentIndex = newIndex;
        };

        const finish = () => {
            grip.releasePointerCapture(pointerId);
            grip.removeEventListener('pointermove', move);
            grip.removeEventListener('pointerup', finish);
            grip.removeEventListener('pointercancel', finish);

            item.classList.remove('dragging');
            item.style.transform = '';
            items.forEach(el => { if (el !== item) el.style.transform = ''; });
            document.body.classList.remove('reorder-active');
            this._reordering = false;

            if (currentIndex !== fromIndex) {
                onDrop(fromIndex, currentIndex);
            }
        };

        grip.setPointerCapture(pointerId);
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', finish);
        grip.addEventListener('pointercancel', finish);
    }

    // ----------------------------------------
    // 計算
    // ----------------------------------------

    /**
     * 合計金額を計算
     * @returns {number} 合計金額
     */
    calculateTotal() {
        return this.getCurrentMonthData().categories
            .reduce((total, category) => total + categoryDisplayAmount(category), 0);
    }

    /**
     * 立替精算を計算（夫払い・妻払いの内訳と精算額・方向）
     * payerフィールドが'wife'の項目のみ妻払い、それ以外（未設定含む）は夫払い扱い。
     * @returns {{husband: number, wife: number, total: number, settlementAmount: number, direction: 'wife-to-husband'|'husband-to-wife'|'none'}}
     */
    calculateSettlement() {
        const monthData = this.getCurrentMonthData();
        let husband = 0;
        let wife = 0;

        monthData.categories.forEach(category => {
            if (category.subcategories.length > 0) {
                category.subcategories.forEach(sub => {
                    if (sub.payer === 'wife') wife += (sub.amount || 0);
                    else husband += (sub.amount || 0);
                });
            } else if (category.payer === 'wife') {
                wife += (category.amount || 0);
            } else {
                husband += (category.amount || 0);
            }
        });

        const total = husband + wife;
        const diff = husband - wife;
        const settlementAmount = Math.round(Math.abs(diff) / 2);
        const direction = diff > 0 ? 'wife-to-husband' : (diff < 0 ? 'husband-to-wife' : 'none');

        return { husband, wife, total, settlementAmount, direction };
    }

    /**
     * 精算表示用のラベルを生成（例: 「妻→夫 ¥3,000」）
     * @private
     * @param {{settlementAmount: number, direction: string}} settlement
     * @returns {string}
     */
    _formatSettlementLabel(settlement) {
        if (settlement.direction === 'none') return 'なし';
        const arrow = settlement.direction === 'wife-to-husband' ? '妻→夫' : '夫→妻';
        return `${arrow} ¥${Utils.formatCurrency(settlement.settlementAmount)}`;
    }

    // ----------------------------------------
    // 固定費の自動記帳
    // ----------------------------------------

    /**
     * 固定費セットを自動記帳する（誤爆防止のため以下すべてを満たす時のみ）
     * - 固定費データ・月データとも初回読み込みが完了している
     * - 表示中の月が実際の今月と一致する
     * - この月への自動記帳をこのセッションでまだ試みていない
     * - その月のデータがまだ1件も存在しない
     * 上記を満たさない場合は何もしない（過去月・未来月・データがある月には触れない）。
     */
    maybeAutoEntry() {
        if (!this.recurringManager?.loaded || this.isInitialLoad) return;

        const viewingKey = this.getCurrentMonthKey();
        const jstDate = Utils.getJSTDate();
        const todayKey = Utils.getMonthKey(jstDate.getFullYear(), jstDate.getMonth() + 1);
        if (viewingKey !== todayKey) return;

        if (this._autoEntryAttempted.has(viewingKey)) return;
        this._autoEntryAttempted.add(viewingKey);

        const hasData = !!(this.data[viewingKey]?.categories?.length > 0);
        if (hasData) return;

        const items = this.recurringManager.items;
        if (!items.length) return;

        const monthData = this.getMonthData(viewingKey);
        items.forEach(item => {
            monthData.categories.push({
                id: Utils.generateId(),
                name: item.name,
                amount: item.amount || 0,
                ...(item.payer ? { payer: item.payer } : {}),
                note: item.note || '',
                subcategories: []
            });
        });

        // 呼び出し元がupdateDisplay()経由なら続く描画で新しい項目が反映される。
        // Firestore保存後、自分自身の書き込みでbudgetMonthsスナップショットが
        // 再発火し、そこでも再描画される。
        this.saveWithStatus();
        Utils.showToast(`固定費${items.length}件を自動記帳しました`);
    }

    // ----------------------------------------
    // 出力テキスト生成
    // ----------------------------------------

    /**
     * 家計簿の出力テキストを生成
     * @returns {string} フォーマットされた出力テキスト
     */
    generateOutput() {
        const monthData = this.getCurrentMonthData();
        const { year, month } = this._parseMonthKey(this.getCurrentMonthKey());
        
        let output = '━━━━━━━━━━━━━━━━\n';
        output += `📅 ${year}年${month}月 家計簿\n`;
        output += '━━━━━━━━━━━━━━━━\n\n';
        
        monthData.categories.forEach((category, index) => {
            output += this._formatCategoryOutput(category);
            if (index < monthData.categories.length - 1) output += '\n';
        });
        
        const total = this.calculateTotal();
        const settlement = this.calculateSettlement();
        output += '\n━━━━━━━━━━━━━━━━\n';
        output += `💰 Total：${Utils.formatCurrency(total)}円\n`;
        output += `👤 夫払い：${Utils.formatCurrency(settlement.husband)}円 / 妻払い：${Utils.formatCurrency(settlement.wife)}円\n`;
        output += `🔄 精算：${this._formatSettlementLabel(settlement)}\n`;
        output += '━━━━━━━━━━━━━━━━';
        
        return output;
    }

    /**
     * 年月キーをパース
     * @private
     * @param {string} monthKey - YYYY-MM形式
     * @returns {{year: string, month: number}}
     */
    _parseMonthKey(monthKey) {
        const [year, month] = monthKey.split('-');
        return { year, month: parseInt(month) };
    }

    /**
     * カテゴリの出力文字列を生成
     * @private
     * @param {Object} category - カテゴリデータ
     * @returns {string}
     */
    _formatCategoryOutput(category) {
        if (category.subcategories.length === 0) {
            return `■ ${category.name}：${Utils.formatCurrency(category.amount)}円\n`;
        }

        let output = `■ ${category.name}：${Utils.formatCurrency(categoryDisplayAmount(category))}円\n`;

        // 表示する小カテゴリー行を決定する。
        // 概要モードで小カテゴリーが多い場合は、金額上位のみ残して残りを「ほか」に集約し、
        // 明細取込などで出力が長くなりすぎないようにする。詳細モードは全件展開。
        const TOP_N = 3;          // 概要モードで個別表示する上位件数
        const COLLAPSE_FROM = 5;  // この件数以上のときだけ圧縮（4件以下は「ほか1件」を避けて全表示）
        const lines = [];
        if (!this.outputDetailMode && category.subcategories.length >= COLLAPSE_FROM) {
            const sorted = [...category.subcategories].sort((a, b) => (b.amount || 0) - (a.amount || 0));
            const top = sorted.slice(0, TOP_N);
            const rest = sorted.slice(TOP_N);
            top.forEach(sub => lines.push({ name: sub.name, amount: sub.amount }));
            const restSum = rest.reduce((sum, sub) => sum + (sub.amount || 0), 0);
            lines.push({ name: `ほか${rest.length}件`, amount: restSum });
        } else {
            category.subcategories.forEach(sub => lines.push({ name: sub.name, amount: sub.amount }));
        }

        lines.forEach((line, index) => {
            const isLast = index === lines.length - 1;
            const prefix = isLast ? '  └ ' : '  ├ ';
            output += `${prefix}${line.name}：${Utils.formatCurrency(line.amount)}円\n`;
        });

        return output;
    }

    /**
     * テキスト出力の概要／詳細モードを切り替える
     * @param {'summary'|'detail'} mode
     */
    setOutputMode(mode) {
        this.outputDetailMode = mode === 'detail';
        try {
            localStorage.setItem('budgetOutputDetailMode', mode === 'detail' ? 'detail' : 'summary');
        } catch {
            // localStorage不可でも動作は継続
        }

        const outputEl = document.getElementById('outputText');
        if (outputEl) outputEl.textContent = this.generateOutput();
        this._updateOutputModeToggle();
    }

    /**
     * 概要／詳細トグルのアクティブ表示を更新する
     * @private
     */
    _updateOutputModeToggle() {
        const summaryBtn = document.getElementById('outputModeSummary');
        const detailBtn = document.getElementById('outputModeDetail');
        if (!summaryBtn || !detailBtn) return;
        const active = 'bg-white/15 text-white';
        const inactive = 'text-zinc-400';
        summaryBtn.className = `output-mode-btn rounded-md px-2.5 py-1 text-xs font-semibold transition ${this.outputDetailMode ? inactive : active}`;
        detailBtn.className = `output-mode-btn rounded-md px-2.5 py-1 text-xs font-semibold transition ${this.outputDetailMode ? active : inactive}`;
    }

    // ----------------------------------------
    // 表示更新
    // ----------------------------------------

    /**
     * 画面表示を更新
     */
    updateDisplay() {
        // 固定費の自動記帳判定（今月かつ空月の場合のみthis.dataに追加される）
        this.maybeAutoEntry();

        // 月表示
        const monthLabel = `${this.currentYear}年 ${this.currentMonth}月`;
        document.getElementById('currentMonth').textContent = monthLabel;

        const miniMonthEl = document.getElementById('miniHeaderMonth');
        if (miniMonthEl) miniMonthEl.textContent = monthLabel;

        // innerHTMLの丸ごと再構築で失われる画面状態を退避する。
        // 保存のたびに自分の書き込みでスナップショットが再発火して再描画されるため、
        // これがないと小カテゴリー追加などのたびにアコーディオンが全部閉じ、
        // ページ高さが縮んでスクロール位置が上に飛んでしまう。
        const listEl = document.getElementById('categoryList');
        const openIds = listEl
            ? [...listEl.querySelectorAll('.category-details.open')].map(el => el.id.replace('details-', ''))
            : [];
        const focusedId = document.activeElement?.id || null;
        const scrollY = window.scrollY;

        // カテゴリリスト
        const monthData = this.getCurrentMonthData();
        if (listEl) {
            listEl.innerHTML = monthData.categories.map(cat => this._renderCategory(cat)).join('');
        }

        // 開いていたカテゴリを復元（カテゴリ削除で消えた場合はスキップされる）
        openIds.forEach(id => {
            document.getElementById(`details-${id}`)?.classList.add('open');
            document.getElementById(`icon-${id}`)?.classList.add('open');
        });

        // 入力フォーカスを復元（再構築で要素が作り直されたときだけ。IDは安定している）
        if (focusedId && document.activeElement?.id !== focusedId) {
            document.getElementById(focusedId)?.focus({ preventScroll: true });
        }

        // 高さ復元後にスクロール位置を戻す（再構築中のクランプ対策）
        window.scrollTo(0, scrollY);

        // 合計表示
        this._updateTotalDisplay();
    }

    /**
     * 家計簿ミニヘッダーの表示制御を初期化
     * 月セレクタ（#monthSelector）がスクロールで画面外に出たら
     * 画面上部にミニヘッダー（月送り・合計金額）を表示する
     */
    initMiniHeader() {
        const target = document.getElementById('monthSelector');
        const miniHeader = document.getElementById('miniHeader');
        if (!target || !miniHeader || this._miniHeaderObserver) return;

        this._miniHeaderObserver = new IntersectionObserver(
            (entries) => {
                const budgetSection = document.getElementById('budgetSection');
                const onBudgetPage = budgetSection && getComputedStyle(budgetSection).display !== 'none';
                miniHeader.classList.toggle('show', onBudgetPage && !entries[0].isIntersecting);
            },
            { threshold: 0 }
        );
        this._miniHeaderObserver.observe(target);
    }

    /**
     * カテゴリのHTMLを生成
     * @private
     * @param {Object} category - カテゴリデータ
     * @returns {string} HTML文字列
     */
    _renderCategory(category) {
        const displayAmount = categoryDisplayAmount(category);

        return `
            <div class="category-item overflow-hidden rounded-xl bg-white/5 ring-1 ring-white/10" data-cat-id="${category.id}">
                ${this._renderCategorySummary(category, displayAmount)}
                ${this._renderCategoryDetails(category, displayAmount)}
            </div>
        `;
    }

    /**
     * カテゴリサマリー行のHTMLを生成
     * @private
     */
    _renderCategorySummary(category, displayAmount) {
        // IDを安全な文字列に変換（小数点をハイフンに置換）
        const safeId = String(category.id).replaceAll('.', '-');

        const quickInput = this.quickInputMode ? `
            <form class="quick-input-wrapper flex items-center gap-1.5" onsubmit="return app.budget.quickInputSubmit('${safeId}', null, event)">
                <input type="number" class="quick-input-field w-24 rounded-lg bg-white/5 px-2.5 py-1.5 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500" id="quick-${safeId}"
                    placeholder="金額" inputmode="decimal" enterkeyhint="go"
                    onclick="event.stopPropagation()">
                <button type="submit" class="quick-add-btn flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500 font-bold text-white transition hover:bg-indigo-400" onclick="event.stopPropagation()">+</button>
            </form>
        ` : '';

        return `
            <div class="category-summary cursor-pointer px-4 py-3 transition hover:bg-white/5" onclick="app.budget.toggleAccordion(${category.id})">
                <div class="flex items-center justify-between gap-3">
                    <div class="category-summary-left flex min-w-0 items-center gap-2.5">
                        <span class="accordion-icon text-xs text-zinc-500" id="icon-${category.id}">${Icons.svg('chevron-right')}</span>
                        <span class="category-summary-name truncate text-sm font-semibold text-zinc-100">${Utils.escapeHtml(category.name)}</span>
                    </div>
                    <div class="category-summary-right flex shrink-0 items-center gap-2">
                        ${quickInput}
                        <span class="category-summary-amount whitespace-nowrap text-sm font-bold text-white">${Utils.formatCurrency(displayAmount)}円</span>
                        <span class="drag-handle flex h-8 w-8 shrink-0 cursor-grab items-center justify-center text-lg text-zinc-500 transition hover:text-zinc-300 active:cursor-grabbing"
                            onpointerdown="app.budget.startCategoryDrag(event, ${category.id})" onclick="event.stopPropagation()">${Icons.svg('grip')}</span>
                    </div>
                </div>
                ${this._renderBudgetBar(displayAmount, category.budget)}
            </div>
        `;
    }

    /**
     * 予算バーのHTMLを生成（予算が未設定・0の場合は非表示）
     * @private
     * @param {number} displayAmount - 現在の使用金額
     * @param {number} budget - 予算額
     * @returns {string}
     */
    _renderBudgetBar(displayAmount, budget) {
        if (!budget || budget <= 0) return '';

        const ratio = displayAmount / budget;
        const percent = Math.round(ratio * 100);
        const widthPercent = Math.min(100, Math.max(0, ratio * 100));
        const barColor = ratio >= 1 ? 'bg-rose-500' : (ratio >= 0.8 ? 'bg-amber-400' : 'bg-emerald-500');
        const textColor = ratio >= 1 ? 'text-rose-300' : (ratio >= 0.8 ? 'text-amber-300' : 'text-emerald-300');

        return `
            <div class="budget-bar mt-2 flex items-center gap-2">
                <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
                    <div class="h-full rounded-full ${barColor} transition-[width]" style="width: ${widthPercent}%"></div>
                </div>
                <span class="shrink-0 whitespace-nowrap text-[11px] font-semibold ${textColor}">${percent}% / 予算${Utils.formatCurrency(budget)}円</span>
            </div>
        `;
    }

    /**
     * カテゴリ詳細のHTMLを生成
     * @private
     */
    _renderCategoryDetails(category, displayAmount) {
        const hasSubcategories = category.subcategories.length > 0;

        return `
            <div class="category-details border-t border-white/10 px-4 pb-4 pt-3" id="details-${category.id}">
                ${this._renderCategoryHeader(category, displayAmount, hasSubcategories)}
                ${!hasSubcategories ? this._renderCategoryNote(category) : ''}
                ${hasSubcategories ? this._renderSubcategories(category) : ''}
                ${this._renderAddSubcategoryForm(category.id)}
            </div>
        `;
    }

    /**
     * カテゴリヘッダーのHTMLを生成
     * @private
     */
    _renderCategoryHeader(category, displayAmount, hasSubcategories) {
        const amountSection = hasSubcategories
            ? `<span class="text-base font-bold text-white">合計: ${Utils.formatCurrency(displayAmount)}円</span>`
            : `<input type="number" id="amount-${category.id}" value="${category.amount ?? 0}" onchange="app.budget.updateAmount(${category.id}, null)" class="w-28 rounded-lg bg-white/5 px-2.5 py-1.5 text-right text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none focus:ring-2 focus:ring-indigo-500"><span class="text-sm text-zinc-400">円</span>`;

        return `
            <div class="category-header flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                    <span class="category-name text-sm font-bold text-white">${Utils.escapeHtml(category.name)}</span>
                    ${category.note ? `<div class="note-text mt-0.5 text-xs text-zinc-500">備考: ${Utils.escapeHtml(category.note)}</div>` : ''}
                </div>
                <div class="category-amount flex items-center gap-2">
                    ${amountSection}
                    <div class="category-actions flex gap-1.5">
                        <button class="edit-btn rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-white/15" onclick="app.budget.editCategory(${category.id})">編集</button>
                        <button class="delete-btn rounded-md bg-rose-500/10 px-2.5 py-1.5 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/20" onclick="app.budget.deleteCategory(${category.id})">削除</button>
                    </div>
                </div>
            </div>
            <div class="category-budget mt-2.5 flex items-center gap-2">
                <span class="text-xs font-semibold text-zinc-400">予算</span>
                <input type="number" id="budget-${category.id}" value="${category.budget || ''}" placeholder="未設定" onchange="app.budget.updateBudget(${category.id})" class="w-28 rounded-lg bg-white/5 px-2.5 py-1.5 text-right text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500">
                <span class="text-sm text-zinc-400">円</span>
            </div>
        `;
    }

    /**
     * カテゴリ備考入力のHTMLを生成
     * @private
     */
    _renderCategoryNote(category) {
        return `
            <div class="mt-3 flex items-center gap-2">
                ${this._renderPayerChip(category.id, null, category.payer)}
                <input type="text" class="note-input min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500" id="note-${category.id}"
                    value="${Utils.escapeHtml(category.note || '')}" placeholder="備考を入力..."
                    onchange="app.budget.updateNote(${category.id}, null)">
            </div>
        `;
    }

    /**
     * 支払者チップのHTMLを生成（夫＝デフォルト／妻＝ピンク系トグル）
     * @private
     * @param {number} categoryId - カテゴリID
     * @param {number|null} subcategoryId - サブカテゴリID（カテゴリ直接の場合はnull）
     * @param {'wife'|undefined} payer - 現在の支払者（'wife'以外は夫扱い）
     * @returns {string}
     */
    _renderPayerChip(categoryId, subcategoryId, payer) {
        const isWife = payer === 'wife';
        const subArg = subcategoryId === null ? 'null' : subcategoryId;
        const chipId = subcategoryId === null ? `payer-${categoryId}` : `payer-${categoryId}-${subcategoryId}`;
        const classes = isWife
            ? 'bg-pink-500/15 text-pink-300 ring-1 ring-inset ring-pink-500/30'
            : 'bg-white/10 text-zinc-300 ring-1 ring-inset ring-white/10';

        return `<button type="button" id="${chipId}" class="payer-chip shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${classes}" onclick="app.budget.togglePayer(${categoryId}, ${subArg})">${isWife ? '妻' : '夫'}</button>`;
    }

    /**
     * サブカテゴリリストのHTMLを生成
     * @private
     */
    _renderSubcategories(category) {
        return `<div class="subcategory-list mt-3 space-y-2" id="sublist-${category.id}">${this._renderSubcategoryItems(category)}</div>`;
    }

    /**
     * サブカテゴリの各行のHTMLを生成（並び替え後の部分更新でも再利用）
     * @private
     */
    _renderSubcategoryItems(category) {
        const safeCatId = String(category.id).replaceAll('.', '-');

        return category.subcategories.map(sub => {
            const safeSubId = String(sub.id).replaceAll('.', '-');

            const quickInput = this.quickInputMode ? `
                <form class="quick-input-wrapper-sub flex items-center gap-1.5" onsubmit="return app.budget.quickInputSubmit('${safeCatId}', '${safeSubId}', event)">
                    <input type="number" class="quick-input-field quick-input-sub w-20 rounded-lg bg-white/5 px-2 py-1.5 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500" id="quick-sub-${safeCatId}-${safeSubId}"
                        placeholder="金額" inputmode="decimal" enterkeyhint="go">
                    <button type="submit" class="quick-add-btn flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-500 font-bold text-white transition hover:bg-indigo-400">+</button>
                </form>
            ` : '';

            return `
                <div class="subcategory-item rounded-lg bg-white/5 p-3 ring-1 ring-inset ring-white/5" data-sub-id="${sub.id}">
                    <div class="sub-row-primary flex items-center gap-2">
                        <span class="subcategory-name min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">${Utils.escapeHtml(sub.name)}</span>
                        ${quickInput}
                        <input type="number" id="subamount-${category.id}-${sub.id}" value="${sub.amount ?? 0}"
                            onchange="app.budget.updateAmount(${category.id}, ${sub.id})" class="w-24 shrink-0 rounded-lg bg-white/5 px-2.5 py-1.5 text-right text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none focus:ring-2 focus:ring-indigo-500">
                        <span class="shrink-0 text-sm text-zinc-400">円</span>
                        <span class="drag-handle flex h-8 w-8 shrink-0 cursor-grab items-center justify-center text-base text-zinc-500 transition hover:text-zinc-300 active:cursor-grabbing"
                            onpointerdown="app.budget.startSubcategoryDrag(event, ${category.id}, ${sub.id})">${Icons.svg('grip')}</span>
                    </div>
                    <div class="sub-row-secondary mt-2 flex items-center gap-2">
                        ${this._renderPayerChip(category.id, sub.id, sub.payer)}
                        <input type="text" class="note-input min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500" id="subnote-edit-${category.id}-${sub.id}"
                            value="${Utils.escapeHtml(sub.note || '')}" placeholder="備考を入力..."
                            onchange="app.budget.updateNote(${category.id}, ${sub.id})">
                        <div class="category-actions flex shrink-0 gap-1.5">
                            <button class="edit-btn rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 transition hover:bg-white/15" onclick="app.budget.editSubcategory(${category.id}, ${sub.id})">編集</button>
                            <button class="delete-btn rounded-md bg-rose-500/10 px-2.5 py-1.5 text-xs font-semibold text-rose-300 transition hover:bg-rose-500/20" onclick="app.budget.deleteSubcategory(${category.id}, ${sub.id})">削除</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    /**
     * サブカテゴリ追加フォームのHTMLを生成
     * @private
     */
    _renderAddSubcategoryForm(categoryId) {
        return `
            <div class="add-subcategory mt-3 rounded-lg bg-white/5 p-3 ring-1 ring-inset ring-white/5">
                <div class="input-group flex flex-col gap-2 sm:flex-row">
                    <input type="text" id="subname-${categoryId}" placeholder="小カテゴリー（例：電気）" class="min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500">
                    <input type="number" id="subamount-${categoryId}" placeholder="金額" class="min-w-0 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500 sm:w-24">
                    <input type="text" id="subnote-${categoryId}" placeholder="備考（任意）" class="min-w-0 flex-1 rounded-lg bg-white/5 px-3 py-2 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 outline-none placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500">
                    <button onclick="app.budget.addSubcategory(${categoryId})" class="shrink-0 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400">追加</button>
                </div>
            </div>
        `;
    }

    // ----------------------------------------
    // コピー機能
    // ----------------------------------------

    /**
     * 出力テキストをクリップボードにコピー
     */
    copyOutput() {
        const text = document.getElementById('outputText')?.textContent;
        if (!text) return;
        
        navigator.clipboard.writeText(text).then(() => {
            const successMsg = document.getElementById('copySuccess');
            if (successMsg) {
                successMsg.style.display = 'block';
                setTimeout(() => successMsg.style.display = 'none', 2000);
            }
        });
    }

    // ----------------------------------------
    // 合計カードのフリップ（内訳円グラフ）
    // ----------------------------------------

    /**
     * 合計カードの表（合計金額）と裏（円グラフ）を切り替える
     */
    toggleTotalView() {
        const flip = document.getElementById('totalFlip');
        const front = document.getElementById('totalFlipFront');
        const back = document.getElementById('totalFlipBack');
        if (!flip || !front || !back) return;

        // 現在の高さを明示的に固定してから遷移（auto→px のジャンプを防ぐ）
        flip.style.height = `${flip.offsetHeight}px`;
        void flip.offsetHeight; // リフローを強制

        this.totalFlipped = !this.totalFlipped;

        if (this.totalFlipped) {
            if (this.breakdownTab === 'trend') this.renderTrend(); else this.renderPie();
            flip.style.height = `${this._measureHeight(back)}px`;
            flip.classList.add('flipped');
        } else {
            flip.style.height = `${this._measureHeight(front)}px`;
            flip.classList.remove('flipped');
        }
    }

    /**
     * 合計カード裏面のタブ（内訳／推移）を切り替える
     * @param {'pie'|'trend'} tab
     */
    setBreakdownTab(tab) {
        this.breakdownTab = tab;

        const pieBtn = document.getElementById('breakdownTabPie');
        const trendBtn = document.getElementById('breakdownTabTrend');
        const pieView = document.getElementById('breakdownPieView');
        const trendView = document.getElementById('breakdownTrendView');
        if (!pieBtn || !trendBtn || !pieView || !trendView) return;

        pieBtn.classList.toggle('active', tab === 'pie');
        trendBtn.classList.toggle('active', tab === 'trend');
        pieView.style.display = tab === 'pie' ? 'block' : 'none';
        trendView.style.display = tab === 'trend' ? 'block' : 'none';

        if (tab === 'trend') this.renderTrend(); else this.renderPie();

        // タブ切替で内容の高さが変わるため、合計カードの高さを再調整
        const flip = document.getElementById('totalFlip');
        const back = document.getElementById('totalFlipBack');
        if (flip && back && this.totalFlipped) {
            flip.style.height = `${this._measureHeight(back)}px`;
        }
    }

    /**
     * 絶対配置された面の自然な高さを測定する
     * @private
     * @param {HTMLElement} el
     * @returns {number}
     */
    _measureHeight(el) {
        const prev = el.style.position;
        el.style.position = 'relative';
        const h = el.offsetHeight;
        el.style.position = prev;
        return h;
    }

    /**
     * 合計カードを表（合計金額）に戻す
     * @private
     */
    _resetTotalView() {
        this.totalFlipped = false;
        const flip = document.getElementById('totalFlip');
        if (flip) {
            flip.classList.remove('flipped');
            flip.style.height = '';
        }
    }

    /**
     * カテゴリ別の内訳を集計（金額降順、7件以上は上位6＋その他に集約）
     * @private
     * @returns {{breakdown: Array<{name: string, amount: number, color: string}>, total: number}}
     */
    _getCategoryBreakdown() {
        const monthData = this.getCurrentMonthData();

        const items = monthData.categories
            .map(cat => ({ name: cat.name, amount: categoryDisplayAmount(cat) }))
            .filter(item => item.amount > 0)
            .sort((a, b) => b.amount - a.amount);

        const total = items.reduce((sum, item) => sum + item.amount, 0);

        // 7件以上は上位6件＋「その他」に集約（円グラフは6分割程度が視認の限界）
        let breakdown = items;
        if (items.length > 7) {
            const top = items.slice(0, 6);
            const otherTotal = items.slice(6).reduce((sum, item) => sum + item.amount, 0);
            breakdown = [...top, { name: 'その他', amount: otherTotal }];
        }

        // 金額順に色を固定割当（「その他」はグレー）
        breakdown = breakdown.map((item, i) => ({
            ...item,
            color: item.name === 'その他' ? OTHER_COLOR : CATEGORY_COLORS[i % CATEGORY_COLORS.length]
        }));

        return { breakdown, total };
    }

    /**
     * 円グラフと凡例を描画
     */
    renderPie() {
        const chartEl = document.getElementById('pieChart');
        const legendEl = document.getElementById('pieLegend');
        if (!chartEl || !legendEl) return;

        const { breakdown, total } = this._getCategoryBreakdown();

        if (!breakdown.length || total <= 0) {
            chartEl.innerHTML = '';
            legendEl.innerHTML = '<p class="py-4 text-center text-sm text-zinc-500">データがありません</p>';
            return;
        }

        const { svg, legend } = buildPie(breakdown, total);
        chartEl.innerHTML = svg;
        legendEl.innerHTML = legend;
    }

    /**
     * 表示中の月を含む直近6ヶ月分のカテゴリ別内訳を集計
     * （購読済みの this.data から集計するのみで追加読み込みは発生しない）
     * @private
     * @returns {{months: Array<{key: string, label: string, total: number, values: number[]}>, categories: Array<{name: string, color: string}>, currentMonthKey: string}}
     */
    _getTrendData() {
        const monthKeys = [];
        for (let i = 0; i < 6; i++) {
            const { year, month } = Utils.shiftMonth(this.currentYear, this.currentMonth, -i);
            monthKeys.unshift(Utils.getMonthKey(year, month));
        }

        const perMonth = monthKeys.map(key => {
            const monthData = this.data[key] || { categories: [] };
            const amounts = {};
            monthData.categories.forEach(cat => {
                const amt = categoryDisplayAmount(cat);
                if (amt > 0) amounts[cat.name] = (amounts[cat.name] || 0) + amt;
            });
            const total = Object.values(amounts).reduce((sum, v) => sum + v, 0);
            return { key, amounts, total };
        });

        // 集計期間全体での合計額からカテゴリの優先順位（上位5件）を決める
        // （月ごとに順位が変わると同じ色が別カテゴリを指してしまうため、期間全体で固定）
        const totals = {};
        perMonth.forEach(({ amounts }) => {
            Object.entries(amounts).forEach(([name, amt]) => {
                totals[name] = (totals[name] || 0) + amt;
            });
        });
        const sortedNames = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
        const topNames = sortedNames.slice(0, 5);
        const hasOther = sortedNames.length > topNames.length;

        const categories = topNames.map((name, i) => ({
            name,
            color: CATEGORY_COLORS[i % CATEGORY_COLORS.length]
        }));
        if (hasOther) categories.push({ name: 'その他', color: OTHER_COLOR });

        const months = perMonth.map(({ key, amounts, total }) => {
            const { month } = this._parseMonthKey(key);
            const values = topNames.map(name => amounts[name] || 0);
            if (hasOther) {
                const topSum = topNames.reduce((sum, name) => sum + (amounts[name] || 0), 0);
                values.push(Math.max(0, total - topSum));
            }
            return { key, label: `${month}月`, total, values };
        });

        return { months, categories, currentMonthKey: this.getCurrentMonthKey() };
    }

    /**
     * 月次推移グラフと凡例を描画
     */
    renderTrend() {
        const chartEl = document.getElementById('trendChart');
        const legendEl = document.getElementById('trendLegend');
        if (!chartEl || !legendEl) return;

        const trendData = this._getTrendData();

        if (!trendData.months.some(m => m.total > 0)) {
            chartEl.innerHTML = '';
            legendEl.innerHTML = '<p class="py-4 text-center text-sm text-zinc-500">データがありません</p>';
            return;
        }

        const { svg, legend } = buildTrendChart(trendData);
        chartEl.innerHTML = svg;
        legendEl.innerHTML = legend;
    }

    // ----------------------------------------
    // ヘルパーメソッド
    // ----------------------------------------

    /**
     * カテゴリを検索
     * @private
     * @param {number} categoryId - カテゴリID
     * @returns {Object|undefined}
     */
    _findCategory(categoryId) {
        return this.getCurrentMonthData().categories.find(c => c.id === categoryId);
    }

    /**
     * 同期ステータスを表示してから保存
     */
    saveWithStatus() {
        this.showSyncStatus(SYNC_STATUS.SYNCING, '同期中...');
        this.saveToFirestore();
    }
}

