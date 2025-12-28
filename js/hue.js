/**
 * Philips Hueモジュール
 * Hue Remote APIによる照明制御を提供
 */

import { Utils } from './utils.js';

// ============================================================
// 定数定義
// ============================================================

const HUE_CONFIG = {
    clientId: '1dadb03c-47a7-40f6-af51-bf8ccde0fb1b',
    proxyUrl: 'https://hue-proxy.zinnpei11251818.workers.dev',
    callbackUrl: 'https://jimpei1125.github.io/kakeibo/callback.html'
};

/** 明るさの最大値（Hue API） */
const MAX_BRIGHTNESS = 254;

// ============================================================
// Philips Hueクラス
// ============================================================

export class PhilipsHue {
    constructor() {
        this.groups = {};
        this.lights = {};
        this.currentGroupId = null;
        this.isConnected = false;
        this.username = null;
    }

    // ==================== トークン管理 ====================

    get accessToken() { return localStorage.getItem('hue_access_token'); }
    get refreshToken() { return localStorage.getItem('hue_refresh_token'); }
    get tokenExpires() { return parseInt(localStorage.getItem('hue_token_expires') || '0'); }
    isTokenValid() { return this.accessToken && Date.now() < this.tokenExpires; }

    // ==================== 初期化 ====================

    async init() {
        const loadingEl = document.getElementById('hueLoading');
        const listEl = document.getElementById('hueLightList');
        
        // 未認証の場合
        if (!this.accessToken) {
            if (loadingEl) loadingEl.style.display = 'none';
            if (listEl) listEl.innerHTML = this._renderAuthPrompt();
            return;
        }
        
        // トークン更新が必要な場合
        if (!this.isTokenValid()) await this.refreshAccessToken();
        
        // ユーザー名取得
        if (!this.username) await this.getUsername();
        
        await this.loadGroups();
        await this.loadLights();
    }

    _renderAuthPrompt() {
        return `
            <div class="hue-auth-prompt" style="grid-column:1/-1;text-align:center;padding:30px;">
                <p style="margin-bottom:15px;color:rgba(255,255,255,0.7);">Philips Hueアカウントとの連携が必要です</p>
                <button onclick="app.hue.startAuth()" style="padding:14px 28px;background:linear-gradient(135deg,#f39c12,#e67e22);color:white;border:none;border-radius:10px;font-size:15px;font-weight:bold;cursor:pointer;">
                    🔗 Hueアカウントを連携
                </button>
            </div>
        `;
    }

    // ==================== 認証 ====================

    startAuth() {
        const authUrl = `https://api.meethue.com/v2/oauth2/authorize?client_id=${HUE_CONFIG.clientId}&response_type=code&redirect_uri=${encodeURIComponent(HUE_CONFIG.callbackUrl)}`;
        const authWindow = window.open(authUrl, '_blank', 'noopener,noreferrer');
        if (!authWindow) window.location.href = authUrl;
    }

    async refreshAccessToken() {
        if (!this.refreshToken) { this.logout(); return; }
        
        try {
            const response = await fetch(`${HUE_CONFIG.proxyUrl}/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: this.refreshToken })
            });
            
            const data = await response.json();
            
            if (data.access_token) {
                localStorage.setItem('hue_access_token', data.access_token);
                localStorage.setItem('hue_refresh_token', data.refresh_token);
                localStorage.setItem('hue_token_expires', Date.now() + (data.expires_in * 1000));
            } else {
                this.logout();
            }
        } catch (err) {
            console.error('Token refresh error:', err);
            this.logout();
        }
    }

    async getUsername() {
        try {
            // Link buttonを有効化
            await fetch(`${HUE_CONFIG.proxyUrl}/api/route/api/0/config`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ linkbutton: true })
            });
            
            // ユーザー作成
            const response = await fetch(`${HUE_CONFIG.proxyUrl}/api/route/api`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ devicetype: 'family_app#browser' })
            });
            
            const data = await response.json();
            this.username = data[0]?.success?.username || localStorage.getItem('hue_username');
            if (this.username) localStorage.setItem('hue_username', this.username);
        } catch (err) {
            console.error('Get username error:', err);
            this.username = localStorage.getItem('hue_username');
        }
    }

    logout() {
        ['hue_access_token', 'hue_refresh_token', 'hue_token_expires', 'hue_username']
            .forEach(key => localStorage.removeItem(key));
        this.username = null;
        this.isConnected = false;
        Utils.showToast('Hueからログアウトしました');
        this.init();
    }

    // ==================== API通信 ====================

    async apiRequestV1(endpoint, method = 'GET', body = null) {
        if (!this.isTokenValid()) await this.refreshAccessToken();
        
        const options = {
            method,
            headers: { 'Authorization': `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' }
        };
        if (body) options.body = JSON.stringify(body);
        
        const response = await fetch(`${HUE_CONFIG.proxyUrl}/api/route/api/${this.username}${endpoint}`, options);
        return response.json();
    }

    // ==================== データ読み込み ====================

    async loadLights() {
        try {
            const data = await this.apiRequestV1('/lights');
            if (data && !data.error) this.lights = data;
        } catch (err) {
            console.error('ライト取得エラー:', err);
        }
    }

    async loadGroups() {
        const loadingEl = document.getElementById('hueLoading');
        const listEl = document.getElementById('hueLightList');
        
        if (loadingEl) loadingEl.style.display = 'block';
        if (listEl) listEl.innerHTML = '';
        
        try {
            const data = await this.apiRequestV1('/groups');
            
            if (data && !data.error) {
                this.groups = data;
                this.isConnected = true;
                if (loadingEl) loadingEl.style.display = 'none';
                this.renderGroups();
            } else {
                throw new Error(data?.error?.description || '接続失敗');
            }
        } catch (err) {
            console.error('Hue接続エラー:', err);
            this.isConnected = false;
            if (loadingEl) loadingEl.style.display = 'none';
            if (listEl) listEl.innerHTML = this._renderConnectionError(err.message);
        }
    }

    _renderConnectionError(message) {
        return `
            <div class="hue-error" style="grid-column:1/-1;text-align:center;">
                <p>😢 Hueに接続できません</p>
                <p style="font-size:12px;margin-top:8px;opacity:0.7;">${message}</p>
                <button onclick="app.hue.logout()" style="margin-top:15px;padding:10px 20px;background:rgba(255,255,255,0.1);color:#e0e0e0;border:1px solid rgba(255,255,255,0.2);border-radius:8px;cursor:pointer;">
                    再認証する
                </button>
            </div>
        `;
    }

    // ==================== 描画 ====================

    renderGroups() {
        const listEl = document.getElementById('hueLightList');
        if (!listEl) return;
        
        const roomGroups = Object.keys(this.groups).filter(id => 
            ['Room', 'Zone'].includes(this.groups[id].type)
        );
        
        if (roomGroups.length === 0) {
            listEl.innerHTML = '<div class="no-devices">グループが見つかりません</div>';
            return;
        }
        
        listEl.innerHTML = roomGroups.map(id => {
            const g = this.groups[id];
            const isOn = g.state?.any_on;
            const allOn = g.state?.all_on;
            const icon = g.type === 'Zone' ? '🏷️' : '🏠';
            
            return `
                <div class="hue-light-card ${isOn ? 'on' : 'off'}" onclick="app.hue.showControl('${id}')">
                    <div class="hue-light-status ${allOn ? 'all-on' : ''}"></div>
                    <div class="hue-light-icon">${icon}</div>
                    <div class="hue-light-name">${g.name}</div>
                    <div class="hue-light-brightness">${isOn ? (allOn ? '全点灯' : '一部点灯') : 'OFF'}</div>
                    <div class="hue-light-count">${g.lights?.length || 0}台</div>
                </div>
            `;
        }).join('');
    }

    // ==================== グループ制御 ====================

    showControl(groupId) {
        this.currentGroupId = groupId;
        const group = this.groups[groupId];
        
        document.getElementById('hueControlTitle').textContent = `💡 ${group.name}`;
        
        const brightness = group.action?.bri ? Math.round((group.action.bri / MAX_BRIGHTNESS) * 100) : 100;
        document.getElementById('hueBrightnessSlider').value = brightness;
        document.getElementById('hueBrightnessValue').textContent = brightness;
        
        this.renderIndividualLights(group.lights || []);
        Utils.showModal('hueControlModal');
    }

    closeControl() {
        Utils.closeModal('hueControlModal');
        this.currentGroupId = null;
    }

    renderIndividualLights(lightIds) {
        const container = document.getElementById('hueIndividualLights');
        if (!container) return;
        
        if (lightIds.length === 0) {
            container.innerHTML = '<div style="color:rgba(255,255,255,0.5);text-align:center;padding:10px;">ライトがありません</div>';
            return;
        }
        
        container.innerHTML = lightIds.map(id => {
            const light = this.lights[id];
            if (!light) return '';
            
            const isOn = light.state?.on;
            const brightness = light.state?.bri ? Math.round((light.state.bri / MAX_BRIGHTNESS) * 100) : 100;
            
            return `
                <div class="hue-individual-light ${isOn ? 'on' : 'off'}">
                    <button class="hue-individual-toggle ${isOn ? 'on' : 'off'}" onclick="app.hue.toggleIndividualLight('${id}')">
                        ${isOn ? '💡' : '🌙'}
                    </button>
                    <div class="hue-individual-info">
                        <div class="hue-individual-name">${light.name}</div>
                        <input type="range" class="hue-individual-slider" min="1" max="100" value="${brightness}" 
                            onchange="app.hue.setIndividualBrightness('${id}',this.value)">
                    </div>
                    <div class="hue-individual-brightness">${brightness}%</div>
                </div>
            `;
        }).join('');
    }

    // ==================== 個別ライト制御 ====================

    async toggleIndividualLight(lightId) {
        const light = this.lights[lightId];
        if (!light) return;
        
        const newState = !light.state.on;
        
        try {
            await this.apiRequestV1(`/lights/${lightId}/state`, 'PUT', { on: newState });
            light.state.on = newState;
            this.renderIndividualLights(this.groups[this.currentGroupId]?.lights || []);
            await this.loadGroups();
            Utils.showToast(newState ? `${light.name}を点灯` : `${light.name}を消灯`);
        } catch (err) {
            console.error('ライト操作エラー:', err);
            Utils.showToast('操作に失敗しました');
        }
    }

    async setIndividualBrightness(lightId, brightness) {
        const light = this.lights[lightId];
        if (!light) return;
        
        const bri = Math.round((parseInt(brightness) / 100) * MAX_BRIGHTNESS);
        
        try {
            await this.apiRequestV1(`/lights/${lightId}/state`, 'PUT', { on: true, bri });
            light.state.on = true;
            light.state.bri = bri;
        } catch (err) {
            console.error('明るさ変更エラー:', err);
        }
    }

    updateBrightnessLabel() {
        const value = document.getElementById('hueBrightnessSlider')?.value;
        document.getElementById('hueBrightnessValue').textContent = value;
    }

    // ==================== グループ一括制御 ====================

    async setPower(on) {
        if (!this.currentGroupId) return;
        
        const group = this.groups[this.currentGroupId];
        Utils.showToast(on ? `${group.name}を点灯中...` : `${group.name}を消灯中...`);
        
        try {
            await this.apiRequestV1(`/groups/${this.currentGroupId}/action`, 'PUT', { on });
            
            if (this.groups[this.currentGroupId].state) {
                this.groups[this.currentGroupId].state.any_on = on;
                this.groups[this.currentGroupId].state.all_on = on;
            }
            this.renderGroups();
            this.closeControl();
            Utils.showToast(on ? '点灯しました' : '消灯しました');
        } catch (err) {
            console.error('Hue操作エラー:', err);
            Utils.showToast('接続エラー');
        }
    }

    async applyBrightness() {
        if (!this.currentGroupId) return;
        
        const brightness = parseInt(document.getElementById('hueBrightnessSlider')?.value);
        const bri = Math.round((brightness / 100) * MAX_BRIGHTNESS);
        
        Utils.showToast('明るさを変更中...');
        
        try {
            await this.apiRequestV1(`/groups/${this.currentGroupId}/action`, 'PUT', { on: true, bri });
            
            if (this.groups[this.currentGroupId].action) {
                this.groups[this.currentGroupId].action.bri = bri;
            }
            if (this.groups[this.currentGroupId].state) {
                this.groups[this.currentGroupId].state.any_on = true;
                this.groups[this.currentGroupId].state.all_on = true;
            }
            this.renderGroups();
            this.closeControl();
            Utils.showToast('明るさを変更しました');
        } catch (err) {
            console.error('Hue操作エラー:', err);
            Utils.showToast('接続エラー');
        }
    }

    // ==================== 全体制御 ====================

    async allLightsOn() {
        await this._controlAllGroups(true, '全グループ点灯');
    }

    async allLightsOff() {
        await this._controlAllGroups(false, '全グループ消灯');
    }

    async _controlAllGroups(on, message) {
        Utils.showToast(`${message}中...`);
        
        try {
            const groupIds = Object.keys(this.groups).filter(id => 
                ['Room', 'Zone'].includes(this.groups[id].type)
            );
            
            for (const id of groupIds) {
                await this.apiRequestV1(`/groups/${id}/action`, 'PUT', { on });
                if (this.groups[id].state) {
                    this.groups[id].state.any_on = on;
                    this.groups[id].state.all_on = on;
                }
            }
            
            this.renderGroups();
            Utils.showToast(`${message}しました`);
        } catch (err) {
            console.error('Hue操作エラー:', err);
            Utils.showToast('接続エラー');
        }
    }
}
