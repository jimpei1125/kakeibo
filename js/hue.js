import { Utils } from './utils.js';

// Philips Hueã‚¯ãƒ©ã‚¹ï¼ˆRemote APIå¯¾å¿œï¼‰
export class PhilipsHue {
    constructor() {
        this.clientId = '1dadb03c-47a7-40f6-af51-bf8ccde0fb1b';
        this.proxyUrl = 'https://hue-proxy.zinnpei11251818.workers.dev';
        this.callbackUrl = 'https://jimpei1125.github.io/kakeibo/callback.html';
        this.groups = {};
        this.lights = {};
        this.currentGroupId = null;
        this.isConnected = false;
        this.username = null;
    }

    get accessToken() {
        return localStorage.getItem('hue_access_token');
    }

    get refreshToken() {
        return localStorage.getItem('hue_refresh_token');
    }

    get tokenExpires() {
        return parseInt(localStorage.getItem('hue_token_expires') || '0');
    }

    isTokenValid() {
        return this.accessToken && Date.now() < this.tokenExpires;
    }

    async init() {
        const loadingEl = document.getElementById('hueLoading');
        const listEl = document.getElementById('hueLightList');
        
        if (!this.accessToken) {
            if (loadingEl) loadingEl.style.display = 'none';
            if (listEl) {
                listEl.innerHTML = `
                    <div class="hue-auth-prompt" style="grid-column: 1 / -1; text-align: center; padding: 30px;">
                        <p style="margin-bottom: 15px; color: rgba(255,255,255,0.7);">Philips Hueã‚¢ã‚«ã‚¦ãƒ³ãƒˆã¨ã®é€£æºãŒå¿…è¦ã§ã™</p>
                        <button onclick="app.hue.startAuth()" style="padding: 14px 28px; background: linear-gradient(135deg, #f39c12 0%, #e67e22 100%); color: white; border: none; border-radius: 10px; font-size: 15px; font-weight: bold; cursor: pointer;">
                            ðŸ”— Hueã‚¢ã‚«ã‚¦ãƒ³ãƒˆã‚’é€£æº
                        </button>
                    </div>
                `;
            }
            return;
        }
        
        if (!this.isTokenValid()) {
            await this.refreshAccessToken();
        }
        
        if (!this.username) {
            await this.getUsername();
        }
        
        await this.loadGroups();
        await this.loadLights();
    }

    startAuth() {
        const authUrl = `https://api.meethue.com/v2/oauth2/authorize?client_id=${this.clientId}&response_type=code&redirect_uri=${encodeURIComponent(this.callbackUrl)}`;
        
        const authWindow = window.open(authUrl, '_blank', 'noopener,noreferrer');
        
        if (!authWindow) {
            window.location.href = authUrl;
        }
    }

    async refreshAccessToken() {
        if (!this.refreshToken) {
            this.logout();
            return;
        }
        
        try {
            const response = await fetch(`${this.proxyUrl}/refresh`, {
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
        } catch (error) {
            console.error('Token refresh error:', error);
            this.logout();
        }
    }

    async getUsername() {
        try {
            const response = await fetch(`${this.proxyUrl}/api/route/api/0/config`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ linkbutton: true })
            });
            
            const createResponse = await fetch(`${this.proxyUrl}/api/route/api`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ devicetype: 'family_app#browser' })
            });
            
            const createData = await createResponse.json();
            
            if (createData[0]?.success?.username) {
                this.username = createData[0].success.username;
                localStorage.setItem('hue_username', this.username);
            } else {
                this.username = localStorage.getItem('hue_username');
            }
        } catch (error) {
            console.error('Get username error:', error);
            this.username = localStorage.getItem('hue_username');
        }
    }

    logout() {
        localStorage.removeItem('hue_access_token');
        localStorage.removeItem('hue_refresh_token');
        localStorage.removeItem('hue_token_expires');
        localStorage.removeItem('hue_username');
        this.username = null;
        this.isConnected = false;
        Utils.showToast('Hueã‹ã‚‰ãƒ­ã‚°ã‚¢ã‚¦ãƒˆã—ã¾ã—ãŸ');
        this.init();
    }

    async apiRequest(endpoint, method = 'GET', body = null) {
        if (!this.isTokenValid()) {
            await this.refreshAccessToken();
        }
        
        const options = {
            method,
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            }
        };
        
        if (body) {
            options.body = JSON.stringify(body);
        }
        
        const response = await fetch(`${this.proxyUrl}/api/route/clip/v2${endpoint}`, options);
        return await response.json();
    }

    async apiRequestV1(endpoint, method = 'GET', body = null) {
        if (!this.isTokenValid()) {
            await this.refreshAccessToken();
        }
        
        const options = {
            method,
            headers: {
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            }
        };
        
        if (body) {
            options.body = JSON.stringify(body);
        }
        
        const response = await fetch(`${this.proxyUrl}/api/route/api/${this.username}${endpoint}`, options);
        return await response.json();
    }

    async loadLights() {
        try {
            const data = await this.apiRequestV1('/lights');
            if (data && !data.error) {
                this.lights = data;
            }
        } catch (error) {
            console.error('ãƒ©ã‚¤ãƒˆå–å¾—ã‚¨ãƒ©ãƒ¼:', error);
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
                throw new Error(data?.error?.description || 'æŽ¥ç¶šå¤±æ•—');
            }
        } catch (error) {
            console.error('HueæŽ¥ç¶šã‚¨ãƒ©ãƒ¼:', error);
            this.isConnected = false;
            
            if (loadingEl) loadingEl.style.display = 'none';
            if (listEl) {
                listEl.innerHTML = `
                    <div class="hue-error" style="grid-column: 1 / -1; text-align: center;">
                        <p>ðŸ˜¢ Hueã«æŽ¥ç¶šã§ãã¾ã›ã‚“</p>
                        <p style="font-size: 12px; margin-top: 8px; opacity: 0.7;">${error.message}</p>
                        <button onclick="app.hue.logout()" style="margin-top: 15px; padding: 10px 20px; background: rgba(255,255,255,0.1); color: #e0e0e0; border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; cursor: pointer;">
                            å†èªè¨¼ã™ã‚‹
                        </button>
                    </div>
                `;
            }
        }
    }

    renderGroups() {
        const listEl = document.getElementById('hueLightList');
        if (!listEl) return;
        
        const groupIds = Object.keys(this.groups);
        
        const roomGroups = groupIds.filter(id => {
            const type = this.groups[id].type;
            return type === 'Room' || type === 'Zone';
        });
        
        if (roomGroups.length === 0) {
            listEl.innerHTML = '<div class="no-devices">ã‚°ãƒ«ãƒ¼ãƒ—ãŒè¦‹ã¤ã‹ã‚Šã¾ã›ã‚“</div>';
            return;
        }
        
        let html = '';
        roomGroups.forEach(id => {
            const group = this.groups[id];
            const isOn = group.state && group.state.any_on;
            const allOn = group.state && group.state.all_on;
            const lightCount = group.lights ? group.lights.length : 0;
            
            const icon = group.type === 'Zone' ? 'ðŸ·ï¸' : 'ðŸ ';
            
            html += `
                <div class="hue-light-card ${isOn ? 'on' : 'off'}" onclick="app.hue.showControl('${id}')">
                    <div class="hue-light-status ${allOn ? 'all-on' : ''}"></div>
                    <div class="hue-light-icon">${icon}</div>
                    <div class="hue-light-name">${group.name}</div>
                    <div class="hue-light-brightness">${isOn ? (allOn ? 'å…¨ç‚¹ç¯' : 'ä¸€éƒ¨ç‚¹ç¯') : 'OFF'}</div>
                    <div class="hue-light-count">${lightCount}å°</div>
                </div>
            `;
        });
        
        listEl.innerHTML = html;
    }

    showControl(groupId) {
        this.currentGroupId = groupId;
        const group = this.groups[groupId];
        
        document.getElementById('hueControlTitle').textContent = `ðŸ’¡ ${group.name}`;
        
        const brightness = group.action && group.action.bri ? Math.round((group.action.bri / 254) * 100) : 100;
        document.getElementById('hueBrightnessSlider').value = brightness;
        document.getElementById('hueBrightnessValue').textContent = brightness;
        
        this.renderIndividualLights(group.lights || []);
        
        document.getElementById('hueControlModal').classList.add('show');
    }

    renderIndividualLights(lightIds) {
        const container = document.getElementById('hueIndividualLights');
        if (!container) return;
        
        if (lightIds.length === 0) {
            container.innerHTML = '<div style="color: rgba(255,255,255,0.5); text-align: center; padding: 10px;">ãƒ©ã‚¤ãƒˆãŒã‚ã‚Šã¾ã›ã‚“</div>';
            return;
        }
        
        let html = '';
        lightIds.forEach(id => {
            const light = this.lights[id];
            if (!light) return;
            
            const isOn = light.state && light.state.on;
            const brightness = light.state && light.state.bri ? Math.round((light.state.bri / 254) * 100) : 100;
            
            html += `
                <div class="hue-individual-light ${isOn ? 'on' : 'off'}">
                    <button class="hue-individual-toggle ${isOn ? 'on' : 'off'}" onclick="app.hue.toggleIndividualLight('${id}')">
                        ${isOn ? 'ðŸ’¡' : 'ðŸŒ™'}
                    </button>
                    <div class="hue-individual-info">
                        <div class="hue-individual-name">${light.name}</div>
                        <input type="range" class="hue-individual-slider" 
                            min="1" max="100" value="${brightness}" 
                            onchange="app.hue.setIndividualBrightness('${id}', this.value)">
                    </div>
                    <div class="hue-individual-brightness">${brightness}%</div>
                </div>
            `;
        });
        
        container.innerHTML = html;
    }

    async toggleIndividualLight(lightId) {
        const light = this.lights[lightId];
        if (!light) return;
        
        const newState = !light.state.on;
        
        try {
            await this.apiRequestV1(`/lights/${lightId}/state`, 'PUT', { on: newState });
            
            light.state.on = newState;
            const group = this.groups[this.currentGroupId];
            this.renderIndividualLights(group.lights || []);
            await this.loadGroups();
            Utils.showToast(newState ? `${light.name}ã‚’ç‚¹ç¯` : `${light.name}ã‚’æ¶ˆç¯`);
        } catch (error) {
            console.error('ãƒ©ã‚¤ãƒˆæ“ä½œã‚¨ãƒ©ãƒ¼:', error);
            Utils.showToast('æ“ä½œã«å¤±æ•—ã—ã¾ã—ãŸ');
        }
    }

    async setIndividualBrightness(lightId, brightness) {
        const light = this.lights[lightId];
        if (!light) return;
        
        const bri = Math.round((parseInt(brightness) / 100) * 254);
        
        try {
            await this.apiRequestV1(`/lights/${lightId}/state`, 'PUT', { on: true, bri: bri });
            light.state.on = true;
            light.state.bri = bri;
        } catch (error) {
            console.error('æ˜Žã‚‹ã•å¤‰æ›´ã‚¨ãƒ©ãƒ¼:', error);
        }
    }

    closeControl() {
        document.getElementById('hueControlModal').classList.remove('show');
        this.currentGroupId = null;
    }

    updateBrightnessLabel() {
        const value = document.getElementById('hueBrightnessSlider').value;
        document.getElementById('hueBrightnessValue').textContent = value;
    }

    async setPower(on) {
        if (!this.currentGroupId) return;
        
        const group = this.groups[this.currentGroupId];
        Utils.showToast(on ? `${group.name}ã‚’ç‚¹ç¯ä¸­...` : `${group.name}ã‚’æ¶ˆç¯ä¸­...`);
        
        try {
            await this.apiRequestV1(`/groups/${this.currentGroupId}/action`, 'PUT', { on: on });
            
            if (this.groups[this.currentGroupId].state) {
                this.groups[this.currentGroupId].state.any_on = on;
                this.groups[this.currentGroupId].state.all_on = on;
            }
            this.renderGroups();
            Utils.showToast(on ? 'ç‚¹ç¯ã—ã¾ã—ãŸ' : 'æ¶ˆç¯ã—ã¾ã—ãŸ');
            this.closeControl();
        } catch (error) {
            console.error('Hueæ“ä½œã‚¨ãƒ©ãƒ¼:', error);
            Utils.showToast('æŽ¥ç¶šã‚¨ãƒ©ãƒ¼');
        }
    }

    async applyBrightness() {
        if (!this.currentGroupId) return;
        
        const brightness = parseInt(document.getElementById('hueBrightnessSlider').value);
        const bri = Math.round((brightness / 100) * 254);
        
        Utils.showToast('æ˜Žã‚‹ã•ã‚’å¤‰æ›´ä¸­...');
        
        try {
            await this.apiRequestV1(`/groups/${this.currentGroupId}/action`, 'PUT', { on: true, bri: bri });
            
            if (this.groups[this.currentGroupId].action) {
                this.groups[this.currentGroupId].action.bri = bri;
            }
            if (this.groups[this.currentGroupId].state) {
                this.groups[this.currentGroupId].state.any_on = true;
                this.groups[this.currentGroupId].state.all_on = true;
            }
            this.renderGroups();
            this.closeControl();
            Utils.showToast('æ˜Žã‚‹ã•ã‚’å¤‰æ›´ã—ã¾ã—ãŸ');
        } catch (error) {
            console.error('Hueæ“ä½œã‚¨ãƒ©ãƒ¼:', error);
            Utils.showToast('æŽ¥ç¶šã‚¨ãƒ©ãƒ¼');
        }
    }

    async allLightsOn() {
        Utils.showToast('å…¨ã‚°ãƒ«ãƒ¼ãƒ—ç‚¹ç¯ä¸­...');
        
        try {
            const groupIds = Object.keys(this.groups).filter(id => {
                const type = this.groups[id].type;
                return type === 'Room' || type === 'Zone';
            });
            
            for (const id of groupIds) {
                await this.apiRequestV1(`/groups/${id}/action`, 'PUT', { on: true });
                if (this.groups[id].state) {
                    this.groups[id].state.any_on = true;
                    this.groups[id].state.all_on = true;
                }
            }
            
            this.renderGroups();
            Utils.showToast('å…¨ã‚°ãƒ«ãƒ¼ãƒ—ç‚¹ç¯ã—ã¾ã—ãŸ');
        } catch (error) {
            console.error('Hueæ“ä½œã‚¨ãƒ©ãƒ¼:', error);
            Utils.showToast('æŽ¥ç¶šã‚¨ãƒ©ãƒ¼');
        }
    }

    async allLightsOff() {
        Utils.showToast('å…¨ã‚°ãƒ«ãƒ¼ãƒ—æ¶ˆç¯ä¸­...');
        
        try {
            const groupIds = Object.keys(this.groups).filter(id => {
                const type = this.groups[id].type;
                return type === 'Room' || type === 'Zone';
            });
            
            for (const id of groupIds) {
                await this.apiRequestV1(`/groups/${id}/action`, 'PUT', { on: false });
                if (this.groups[id].state) {
                    this.groups[id].state.any_on = false;
                    this.groups[id].state.all_on = false;
                }
            }
            
            this.renderGroups();
            Utils.showToast('å…¨ã‚°ãƒ«ãƒ¼ãƒ—æ¶ˆç¯ã—ã¾ã—ãŸ');
        } catch (error) {
            console.error('Hueæ“ä½œã‚¨ãƒ©ãƒ¼:', error);
            Utils.showToast('æŽ¥ç¶šã‚¨ãƒ©ãƒ¼');
        }
    }
}
