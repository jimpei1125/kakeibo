/**
 * スマートホームモジュール
 * SwitchBot API連携によるデバイス制御を提供
 */

import { Utils } from './utils.js';
import { Icons } from './icons.js';
import { Dialog } from './dialog.js';

// ============================================================
// 定数定義
// ============================================================

/** SwitchBot API プロキシURL */
const SWITCHBOT_PROXY_URL = 'https://switchbot-proxy.zinnpei11251818.workers.dev/v1.1';

/** デバイスタイプ別アイコン */
const DEVICE_ICONS = {
    'Air Conditioner': '❄️', 'Fan': '🌀', 'Light': '💡', 'TV': '📺',
    'Hub Mini': '📡', 'Hub 2': '📡', 'Bot': '🤖', 'Plug': '🔌',
    'Meter': '🌡️', 'Motion Sensor': '👁️', 'Contact Sensor': '🚪', 'default': '📱'
};

/** エアコンのデフォルト設定 */
const DEFAULT_AC_SETTINGS = { temperature: 26, mode: 2, fanSpeed: 1, power: 'on' };

/** 温湿度（status APIから気温・湿度を追加取得する）対象のデバイスタイプ */
const METER_DEVICE_TYPES = ['Meter', 'MeterPlus', 'Hub 2', 'WoIOSensor'];

// ============================================================
// スマートホームクラス
// ============================================================

export class SmartHome {
    constructor() {
        this.token = localStorage.getItem('switchbot_token') || '';
        this.secret = localStorage.getItem('switchbot_secret') || '';
        this.devices = [];
        this.infraredDevices = [];
        /** @type {Object<string, {temperature: number, humidity: number}>} 温湿度計デバイスID→気温湿度 */
        this.meterStatus = {};
        this.currentAcDevice = null;
        this.acSettings = { ...DEFAULT_AC_SETTINGS };
        this.deviceIcons = DEVICE_ICONS;
    }

    // ==================== 初期化 ====================

    init() {
        if (this.token && this.secret) {
            this.showDevicesView();
            this.loadDevices();
        } else {
            this.showSetupView();
        }
    }

    showSetupView() {
        Utils.setVisible('smartHomeSetup', true);
        Utils.setVisible('smartHomeDevices', false);
    }

    showDevicesView() {
        Utils.setVisible('smartHomeSetup', false);
        Utils.setVisible('smartHomeDevices', true);
    }

    // ==================== トークン管理 ====================

    /**
     * トークン・シークレットを保持し、localStorageへ保存
     * @param {string} token
     * @param {string} secret
     */
    _saveCredentials(token, secret) {
        this.token = token;
        this.secret = secret;
        localStorage.setItem('switchbot_token', token);
        localStorage.setItem('switchbot_secret', secret);
        Utils.showToast('保存しました');
    }

    async saveToken() {
        const token = document.getElementById('switchbotToken')?.value.trim();
        const secret = document.getElementById('switchbotSecret')?.value.trim();

        if (!token || !secret) return Utils.showToast('トークンとシークレットを入力してください');

        this._saveCredentials(token, secret);
        this.showDevicesView();
        await this.loadDevices();
    }

    showSettings() {
        document.getElementById('settingsSwitchbotToken').value = this.token;
        document.getElementById('settingsSwitchbotSecret').value = this.secret;
        Utils.showModal('smartHomeSettingsModal');
    }

    closeSettings() { Utils.closeModal('smartHomeSettingsModal'); }

    updateToken() {
        const token = document.getElementById('settingsSwitchbotToken')?.value.trim();
        const secret = document.getElementById('settingsSwitchbotSecret')?.value.trim();
        
        if (!token || !secret) return Utils.showToast('トークンとシークレットを入力してください');

        this._saveCredentials(token, secret);
        this.closeSettings();
        this.loadDevices();
    }

    async clearToken() {
        const confirmed = await Dialog.confirm('APIトークンを削除しますか？', { okLabel: '削除', danger: true });
        if (!confirmed) return;


        localStorage.removeItem('switchbot_token');
        localStorage.removeItem('switchbot_secret');
        this.token = '';
        this.secret = '';
        
        Utils.showToast('削除しました');
        this.closeSettings();
        this.showSetupView();
    }

    // ==================== API通信 ====================

    /**
     * SwitchBot APIリクエストを送信
     * @param {string} endpoint - APIエンドポイント
     * @param {string} method - HTTPメソッド
     * @param {Object|null} body - リクエストボディ
     * @returns {Promise<Object>}
     */
    async makeRequest(endpoint, method = 'GET', body = null) {
        // 署名生成
        const t = Date.now().toString();
        const nonce = Math.random().toString(36).substring(2, 15);
        const stringToSign = this.token + t + nonce;
        
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
            'raw', encoder.encode(this.secret),
            { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        );
        const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(stringToSign));
        const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
        
        const options = {
            method,
            headers: {
                'Authorization': this.token,
                'sign': signatureBase64,
                't': t,
                'nonce': nonce,
                'Content-Type': 'application/json'
            }
        };
        
        if (body) options.body = JSON.stringify(body);
        
        const response = await fetch(`${SWITCHBOT_PROXY_URL}${endpoint}`, options);
        return response.json();
    }

    // ==================== デバイス読み込み ====================

    async loadDevices() {
        const statusEl = document.getElementById('devicesStatus');
        statusEl.textContent = '読み込み中...';
        
        try {
            const result = await this.makeRequest('/devices');
            
            if (result.statusCode === 100) {
                this.devices = result.body.deviceList || [];
                this.infraredDevices = result.body.infraredRemoteList || [];
                this.renderDevices();
                statusEl.textContent = `${this.devices.length + this.infraredDevices.length}台のデバイス`;
                this._loadMeterStatuses();
            } else {
                statusEl.textContent = `エラー: ${result.message}`;
                Utils.showToast('デバイス取得に失敗しました');
            }
        } catch (err) {
            console.error('デバイス取得エラー:', err);
            statusEl.textContent = '接続エラー';
            Utils.showToast('接続に失敗しました');
        }
    }

    /**
     * 温湿度計系デバイス（Meter/MeterPlus/Hub 2/防水温湿度計）のstatusを追加取得し、
     * 取得できたものからデバイスカードに反映する
     */
    async _loadMeterStatuses() {
        const meterDevices = this.devices.filter(d => METER_DEVICE_TYPES.includes(d.deviceType));
        if (meterDevices.length === 0) return;

        await Promise.all(meterDevices.map(async (device) => {
            try {
                const result = await this.makeRequest(`/devices/${device.deviceId}/status`);
                if (result.statusCode === 100 && result.body) {
                    this.meterStatus[device.deviceId] = {
                        temperature: result.body.temperature,
                        humidity: result.body.humidity
                    };
                }
            } catch (err) {
                console.error(`温湿度取得エラー(${device.deviceName}):`, err);
            }
        }));

        this.renderDevices();
    }

    renderDevices() {
        const irListEl = document.getElementById('irDeviceList');
        const physicalListEl = document.getElementById('physicalDeviceList');

        // 赤外線デバイス
        irListEl.innerHTML = this.infraredDevices.length === 0
            ? this._renderNoDevices('赤外線デバイスがありません')
            : this.infraredDevices.map(d => this._renderDeviceCard(d, 'remoteType')).join('');

        // 物理デバイス
        physicalListEl.innerHTML = this.devices.length === 0
            ? this._renderNoDevices('SwitchBotデバイスがありません')
            : this.devices.map(d => this._renderDeviceCard(d, 'deviceType', true)).join('');
    }

    _renderNoDevices(message) {
        return `<div class="no-devices col-span-full py-6 text-center text-sm text-zinc-500">${Utils.escapeHtml(message)}</div>`;
    }

    _renderDeviceCard(device, typeKey, isPhysical = false) {
        const type = device[typeKey];
        const icon = this.deviceIcons[type] || this.deviceIcons['default'];
        const method = isPhysical ? 'controlPhysicalDevice' : 'controlDevice';
        // 引数をJS文字列リテラル化した上でHTML属性用にエスケープ（XSS対策）
        const args = [device.deviceId, type, device.deviceName]
            .map(v => JSON.stringify(String(v ?? '')))
            .join(',');
        const onclick = Utils.escapeHtml(`app.smartHome.${method}(${args})`);
        const meterInfo = isPhysical ? this._renderMeterInfo(device.deviceId) : '';

        return `
            <div class="device-card cursor-pointer rounded-xl bg-white/5 p-4 text-center ring-1 ring-white/10 transition hover:bg-white/10" onclick="${onclick}">
                <div class="device-icon mb-2 text-3xl">${icon}</div>
                <div class="device-name truncate text-sm font-bold text-zinc-100">${Utils.escapeHtml(device.deviceName)}</div>
                <div class="device-type mt-1 text-[11px] text-zinc-500">${Utils.escapeHtml(type)}</div>
                ${meterInfo}
            </div>
        `;
    }

    /**
     * 温湿度計デバイスの気温・湿度表示HTMLを生成（未取得ならなにも表示しない）
     * @private
     * @param {string} deviceId
     * @returns {string}
     */
    _renderMeterInfo(deviceId) {
        const meter = this.meterStatus[deviceId];
        if (!meter || meter.temperature == null || meter.humidity == null) return '';

        const temperature = Number(meter.temperature).toFixed(1);
        const humidity = Math.round(meter.humidity);

        return `
            <div class="device-meter mt-2 flex items-center justify-center gap-2.5 text-xs font-semibold text-zinc-300">
                <span>🌡 ${temperature}℃</span>
                <span>💧 ${humidity}%</span>
            </div>
        `;
    }

    // ==================== デバイス制御 ====================

    controlDevice(deviceId, deviceType, deviceName) {
        switch (deviceType) {
            case 'Air Conditioner': this.showAcControl(deviceId, deviceName); break;
            case 'Fan': this.showFanControl(deviceId, deviceName); break;
            case 'Light': this.toggleLight(deviceId, deviceName); break;
            case 'TV': this.toggleTV(deviceId, deviceName); break;
            default: this.sendCommand(deviceId, 'turnOn');
        }
    }

    controlPhysicalDevice(deviceId, deviceType, deviceName) {
        if (deviceType === 'Bot') {
            this.sendCommand(deviceId, 'press');
            Utils.showToast(`${deviceName}を押しました`);
        } else if (deviceType.includes('Plug')) {
            this.togglePlug(deviceId, deviceName);
        } else {
            Utils.showToast(`${deviceName}は直接操作できません`);
        }
    }

    // ==================== エアコン制御 ====================

    showAcControl(deviceId, deviceName) {
        this.currentAcDevice = { id: deviceId, name: deviceName };
        document.getElementById('acControlTitle').innerHTML = `${Icons.svg('snowflake')} ${Utils.escapeHtml(deviceName)}`;
        document.getElementById('acTempDisplay').textContent = `${this.acSettings.temperature}°C`;
        
        this._updateButtonSelection('.mode-btn', 'mode', this.acSettings.mode);
        this._updateButtonSelection('.fan-btn', 'fan', this.acSettings.fanSpeed);
        
        Utils.showModal('acControlModal');
    }

    closeAcControl() {
        Utils.closeModal('acControlModal');
        this.currentAcDevice = null;
    }

    adjustTemp(delta) {
        this.acSettings.temperature = Math.max(16, Math.min(30, this.acSettings.temperature + delta));
        document.getElementById('acTempDisplay').textContent = `${this.acSettings.temperature}°C`;
    }

    setAcMode(mode) {
        this.acSettings.mode = mode;
        this._updateButtonSelection('.mode-btn', 'mode', mode);
    }

    setAcFan(fan) {
        this.acSettings.fanSpeed = fan;
        this._updateButtonSelection('.fan-btn', 'fan', fan);
    }

    _updateButtonSelection(selector, dataKey, value) {
        document.querySelectorAll(selector).forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset[dataKey]) === value);
        });
    }

    async acCommand(command) {
        if (!this.currentAcDevice) return;
        
        Utils.showToast('送信中...');
        
        try {
            const result = await this.makeRequest(
                `/devices/${this.currentAcDevice.id}/commands`, 'POST',
                { command, commandType: 'command' }
            );
            
            Utils.showToast(result.statusCode === 100
                ? (command === 'turnOn' ? 'ONにしました' : 'OFFにしました')
                : `エラー: ${result.message}`
            );
        } catch (err) {
            console.error('コマンドエラー:', err);
            Utils.showToast('送信に失敗しました');
        }
    }

    async applyAcSettings() {
        if (!this.currentAcDevice) return;
        
        Utils.showToast('設定を送信中...');
        
        try {
            const result = await this.makeRequest(
                `/devices/${this.currentAcDevice.id}/commands`, 'POST',
                {
                    command: 'setAll',
                    commandType: 'command',
                    parameter: `${this.acSettings.temperature},${this.acSettings.mode},${this.acSettings.fanSpeed},on`
                }
            );
            
            if (result.statusCode === 100) {
                Utils.showToast('設定を適用しました');
                this.closeAcControl();
            } else {
                Utils.showToast(`エラー: ${result.message}`);
            }
        } catch (err) {
            console.error('設定エラー:', err);
            Utils.showToast('送信に失敗しました');
        }
    }

    // ==================== 他デバイス制御 ====================

    async showFanControl(deviceId, deviceName) {
        await this._toggleDevice(deviceId, deviceName, 'ON/OFFを切り替えますか？');
    }

    async toggleLight(deviceId, deviceName) {
        await this._toggleDevice(deviceId, deviceName, 'ON/OFFを切り替えますか？');
    }

    async toggleTV(deviceId, deviceName) {
        await this._toggleDevice(deviceId, deviceName, 'ON/OFFを切り替えますか？');
    }

    async togglePlug(deviceId, deviceName) {
        await this._toggleDevice(deviceId, deviceName, 'ON/OFFを切り替えますか？');
    }

    async _toggleDevice(deviceId, deviceName, message) {
        const action = await Dialog.choose(`${deviceName}\n\n${message}`, [
            { label: 'キャンセル', value: null, variant: 'neutral' },
            { label: 'OFFにする', value: false, variant: 'neutral' },
            { label: 'ONにする', value: true, variant: 'primary' },
        ]);
        if (action === null) return;

        Utils.showToast('送信中...');
        
        try {
            const result = await this.makeRequest(
                `/devices/${deviceId}/commands`, 'POST',
                { command: action ? 'turnOn' : 'turnOff', commandType: 'command' }
            );
            
            Utils.showToast(result.statusCode === 100
                ? (action ? 'ONにしました' : 'OFFにしました')
                : `エラー: ${result.message}`
            );
        } catch (err) {
            console.error('コマンドエラー:', err);
            Utils.showToast('送信に失敗しました');
        }
    }

    async sendCommand(deviceId, command, parameter = 'default') {
        try {
            const result = await this.makeRequest(
                `/devices/${deviceId}/commands`, 'POST',
                { command, commandType: 'command', parameter }
            );
            
            if (result.statusCode !== 100) {
                console.error('コマンドエラー:', result.message);
            }
            return result;
        } catch (err) {
            console.error('送信エラー:', err);
            throw err;
        }
    }
}
