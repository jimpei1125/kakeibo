import { Utils } from './utils.js';

// スマートホームクラス
export class SmartHome {
    constructor() {
        this.token = localStorage.getItem('switchbot_token') || '';
        this.secret = localStorage.getItem('switchbot_secret') || '';
        this.devices = [];
        this.infraredDevices = [];
        this.currentAcDevice = null;
        this.acSettings = {
            temperature: 26,
            mode: 2,
            fanSpeed: 1,
            power: 'on'
        };
        
        this.deviceIcons = {
            'Air Conditioner': '❄️',
            'Fan': '🌀',
            'Light': '💡',
            'TV': '📺',
            'Hub Mini': '📡',
            'Hub 2': '📡',
            'Bot': '🤖',
            'Plug': '🔌',
            'Meter': '🌡️',
            'Motion Sensor': '👁️',
            'Contact Sensor': '🚪',
            'default': '📱'
        };
    }

    init() {
        if (this.token && this.secret) {
            this.showDevicesView();
            this.loadDevices();
        } else {
            this.showSetupView();
        }
    }

    showSetupView() {
        document.getElementById('smartHomeSetup').style.display = 'block';
        document.getElementById('smartHomeDevices').style.display = 'none';
    }

    showDevicesView() {
        document.getElementById('smartHomeSetup').style.display = 'none';
        document.getElementById('smartHomeDevices').style.display = 'block';
    }

    async saveToken() {
        const token = document.getElementById('switchbotToken').value.trim();
        const secret = document.getElementById('switchbotSecret').value.trim();
        
        if (!token || !secret) {
            Utils.showToast('トークンとシークレットを入力してください');
            return;
        }
        
        this.token = token;
        this.secret = secret;
        localStorage.setItem('switchbot_token', token);
        localStorage.setItem('switchbot_secret', secret);
        
        Utils.showToast('保存しました');
        this.showDevicesView();
        await this.loadDevices();
    }

    generateSignature() {
        const t = Date.now();
        const nonce = Math.random().toString(36).substring(2, 15);
        const data = this.token + t + nonce;
        
        return { t, nonce, sign: null };
    }

    async makeRequest(endpoint, method = 'GET', body = null) {
        const t = Date.now().toString();
        const nonce = Math.random().toString(36).substring(2, 15);
        
        const stringToSign = this.token + t + nonce;
        const encoder = new TextEncoder();
        const keyData = encoder.encode(this.secret);
        const messageData = encoder.encode(stringToSign);
        
        const key = await crypto.subtle.importKey(
            'raw',
            keyData,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        
        const signature = await crypto.subtle.sign('HMAC', key, messageData);
        const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
        
        const headers = {
            'Authorization': this.token,
            'sign': signatureBase64,
            't': t,
            'nonce': nonce,
            'Content-Type': 'application/json'
        };
        
        const options = {
            method,
            headers
        };
        
        if (body) {
            options.body = JSON.stringify(body);
        }
        
        const response = await fetch(`https://switchbot-proxy.zinnpei11251818.workers.dev/v1.1${endpoint}`, options);
        return await response.json();
    }

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
            } else {
                statusEl.textContent = 'エラー: ' + result.message;
                Utils.showToast('デバイス取得に失敗しました');
            }
        } catch (error) {
            console.error('デバイス取得エラー:', error);
            statusEl.textContent = '接続エラー';
            Utils.showToast('接続に失敗しました');
        }
    }

    renderDevices() {
        const irListEl = document.getElementById('irDeviceList');
        const physicalListEl = document.getElementById('physicalDeviceList');
        
        if (this.infraredDevices.length === 0) {
            irListEl.innerHTML = '<div class="no-devices">赤外線デバイスがありません</div>';
        } else {
            let html = '';
            this.infraredDevices.forEach(device => {
                const icon = this.deviceIcons[device.remoteType] || this.deviceIcons['default'];
                html += `
                    <div class="device-card" onclick="app.smartHome.controlDevice('${device.deviceId}', '${device.remoteType}', '${device.deviceName}')">
                        <div class="device-icon">${icon}</div>
                        <div class="device-name">${device.deviceName}</div>
                        <div class="device-type">${device.remoteType}</div>
                    </div>
                `;
            });
            irListEl.innerHTML = html;
        }
        
        if (this.devices.length === 0) {
            physicalListEl.innerHTML = '<div class="no-devices">SwitchBotデバイスがありません</div>';
        } else {
            let html = '';
            this.devices.forEach(device => {
                const icon = this.deviceIcons[device.deviceType] || this.deviceIcons['default'];
                html += `
                    <div class="device-card" onclick="app.smartHome.controlPhysicalDevice('${device.deviceId}', '${device.deviceType}', '${device.deviceName}')">
                        <div class="device-icon">${icon}</div>
                        <div class="device-name">${device.deviceName}</div>
                        <div class="device-type">${device.deviceType}</div>
                    </div>
                `;
            });
            physicalListEl.innerHTML = html;
        }
    }

    controlDevice(deviceId, deviceType, deviceName) {
        if (deviceType === 'Air Conditioner') {
            this.showAcControl(deviceId, deviceName);
        } else if (deviceType === 'Fan') {
            this.showFanControl(deviceId, deviceName);
        } else if (deviceType === 'Light') {
            this.toggleLight(deviceId, deviceName);
        } else if (deviceType === 'TV') {
            this.toggleTV(deviceId, deviceName);
        } else {
            this.sendCommand(deviceId, 'turnOn');
        }
    }

    controlPhysicalDevice(deviceId, deviceType, deviceName) {
        if (deviceType === 'Bot') {
            this.sendCommand(deviceId, 'press');
            Utils.showToast(`${deviceName}を押しました`);
        } else if (deviceType === 'Plug' || deviceType === 'Plug Mini (US)' || deviceType === 'Plug Mini (JP)') {
            this.togglePlug(deviceId, deviceName);
        } else {
            Utils.showToast(`${deviceName}は直接操作できません`);
        }
    }

    showAcControl(deviceId, deviceName) {
        this.currentAcDevice = { id: deviceId, name: deviceName };
        document.getElementById('acControlTitle').textContent = `❄️ ${deviceName}`;
        document.getElementById('acTempDisplay').textContent = this.acSettings.temperature + '°C';
        
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.remove('active');
            if (parseInt(btn.dataset.mode) === this.acSettings.mode) {
                btn.classList.add('active');
            }
        });
        
        document.querySelectorAll('.fan-btn').forEach(btn => {
            btn.classList.remove('active');
            if (parseInt(btn.dataset.fan) === this.acSettings.fanSpeed) {
                btn.classList.add('active');
            }
        });
        
        document.getElementById('acControlModal').classList.add('show');
    }

    closeAcControl() {
        document.getElementById('acControlModal').classList.remove('show');
        this.currentAcDevice = null;
    }

    adjustTemp(delta) {
        this.acSettings.temperature = Math.max(16, Math.min(30, this.acSettings.temperature + delta));
        document.getElementById('acTempDisplay').textContent = this.acSettings.temperature + '°C';
    }

    setAcMode(mode) {
        this.acSettings.mode = mode;
        document.querySelectorAll('.mode-btn').forEach(btn => {
            btn.classList.remove('active');
            if (parseInt(btn.dataset.mode) === mode) {
                btn.classList.add('active');
            }
        });
    }

    setAcFan(fan) {
        this.acSettings.fanSpeed = fan;
        document.querySelectorAll('.fan-btn').forEach(btn => {
            btn.classList.remove('active');
            if (parseInt(btn.dataset.fan) === fan) {
                btn.classList.add('active');
            }
        });
    }

    async acCommand(command) {
        if (!this.currentAcDevice) return;
        
        Utils.showToast('送信中...');
        
        try {
            const result = await this.makeRequest(
                `/devices/${this.currentAcDevice.id}/commands`,
                'POST',
                {
                    command: command,
                    commandType: 'command'
                }
            );
            
            if (result.statusCode === 100) {
                Utils.showToast(command === 'turnOn' ? 'ONにしました' : 'OFFにしました');
            } else {
                Utils.showToast('エラー: ' + result.message);
            }
        } catch (error) {
            console.error('コマンドエラー:', error);
            Utils.showToast('送信に失敗しました');
        }
    }

    async applyAcSettings() {
        if (!this.currentAcDevice) return;
        
        Utils.showToast('設定を送信中...');
        
        try {
            const result = await this.makeRequest(
                `/devices/${this.currentAcDevice.id}/commands`,
                'POST',
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
                Utils.showToast('エラー: ' + result.message);
            }
        } catch (error) {
            console.error('設定エラー:', error);
            Utils.showToast('送信に失敗しました');
        }
    }

    async showFanControl(deviceId, deviceName) {
        const action = confirm(`${deviceName}\n\nON/OFFを切り替えますか？\n\nOK = ON\nキャンセル = OFF`);
        
        Utils.showToast('送信中...');
        
        try {
            const result = await this.makeRequest(
                `/devices/${deviceId}/commands`,
                'POST',
                {
                    command: action ? 'turnOn' : 'turnOff',
                    commandType: 'command'
                }
            );
            
            if (result.statusCode === 100) {
                Utils.showToast(action ? 'ONにしました' : 'OFFにしました');
            } else {
                Utils.showToast('エラー: ' + result.message);
            }
        } catch (error) {
            console.error('コマンドエラー:', error);
            Utils.showToast('送信に失敗しました');
        }
    }

    async toggleLight(deviceId, deviceName) {
        const action = confirm(`${deviceName}\n\nON/OFFを切り替えますか？\n\nOK = ON\nキャンセル = OFF`);
        await this.sendCommand(deviceId, action ? 'turnOn' : 'turnOff');
        Utils.showToast(action ? 'ONにしました' : 'OFFにしました');
    }

    async toggleTV(deviceId, deviceName) {
        const action = confirm(`${deviceName}\n\nON/OFFを切り替えますか？\n\nOK = ON\nキャンセル = OFF`);
        await this.sendCommand(deviceId, action ? 'turnOn' : 'turnOff');
        Utils.showToast(action ? 'ONにしました' : 'OFFにしました');
    }

    async togglePlug(deviceId, deviceName) {
        const action = confirm(`${deviceName}\n\nON/OFFを切り替えますか？\n\nOK = ON\nキャンセル = OFF`);
        await this.sendCommand(deviceId, action ? 'turnOn' : 'turnOff');
        Utils.showToast(action ? 'ONにしました' : 'OFFにしました');
    }

    async sendCommand(deviceId, command, parameter = 'default') {
        try {
            const result = await this.makeRequest(
                `/devices/${deviceId}/commands`,
                'POST',
                {
                    command: command,
                    commandType: 'command',
                    parameter: parameter
                }
            );
            
            if (result.statusCode !== 100) {
                console.error('コマンドエラー:', result.message);
            }
            
            return result;
        } catch (error) {
            console.error('送信エラー:', error);
            throw error;
        }
    }

    showSettings() {
        document.getElementById('settingsSwitchbotToken').value = this.token;
        document.getElementById('settingsSwitchbotSecret').value = this.secret;
        document.getElementById('smartHomeSettingsModal').classList.add('show');
    }

    closeSettings() {
        document.getElementById('smartHomeSettingsModal').classList.remove('show');
    }

    updateToken() {
        const token = document.getElementById('settingsSwitchbotToken').value.trim();
        const secret = document.getElementById('settingsSwitchbotSecret').value.trim();
        
        if (!token || !secret) {
            Utils.showToast('トークンとシークレットを入力してください');
            return;
        }
        
        this.token = token;
        this.secret = secret;
        localStorage.setItem('switchbot_token', token);
        localStorage.setItem('switchbot_secret', secret);
        
        Utils.showToast('保存しました');
        this.closeSettings();
        this.loadDevices();
    }

    clearToken() {
        if (!confirm('APIトークンを削除しますか？')) return;
        
        localStorage.removeItem('switchbot_token');
        localStorage.removeItem('switchbot_secret');
        this.token = '';
        this.secret = '';
        
        Utils.showToast('削除しました');
        this.closeSettings();
        this.showSetupView();
    }
}
