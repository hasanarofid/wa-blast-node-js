const axios = require('axios');
const fs = require('fs');
const path = require('path');

const EVO_URL = process.env.EVO_URL || 'http://evolution:8080';
const EVO_KEY = process.env.EVO_KEY || 'setorwasecret123';

/**
 * Evolution API Service (v16.22 - Fixed Pairing POST endpoint)
 */

async function createInstance(sessionId, userId, io, pairingNumber = null) {
    try {
        console.log(`[EVO] Starting fresh instance for ${sessionId}...`);
        
        // 1. Force cleanup existing
        try {
            await axios.delete(`${EVO_URL}/instance/logout/${sessionId}`, { headers: { 'apikey': EVO_KEY } });
            await axios.delete(`${EVO_URL}/instance/delete/${sessionId}`, { headers: { 'apikey': EVO_KEY } });
            console.log(`[EVO] Old instance cleaned.`);
        } catch (e) { /* no old instance */ }

        // 2. Create Fresh Instance
        const payload = { instanceName: sessionId, token: EVO_KEY };
        if (pairingNumber) {
            payload.number = pairingNumber;
            payload.pairingCode = true;
        }

        const createRes = await axios.post(`${EVO_URL}/instance/create`, payload, {
            headers: { 'apikey': EVO_KEY }
        });
        console.log(`[EVO] Instance created:`, JSON.stringify(createRes.data));

        // 3. Wait for WA engine handshake
        await new Promise(r => setTimeout(r, 2000));

        if (pairingNumber) {
            // ---- PAIRING CODE MODE ----
            // Evolution API v1.8.2: Uses POST /instance/pairingCode/{instanceName}
            let attempts = 0;
            const pairInterval = setInterval(async () => {
                attempts++;
                try {
                    const pairRes = await axios.post(
                        `${EVO_URL}/instance/pairingCode/${sessionId}`,
                        { number: pairingNumber },
                        { headers: { 'apikey': EVO_KEY } }
                    );
                    console.log(`[EVO] Pairing attempt ${attempts} response:`, JSON.stringify(pairRes.data));

                    const code = pairRes.data?.code || pairRes.data?.pairingCode;
                    if (code && typeof code === 'string' && code.length >= 6 && code.length <= 20) {
                        console.log(`[EVO] Got pairing code: ${code}`);
                        if (io) io.to(userId).emit("pairing_code", code);
                        clearInterval(pairInterval);
                    }
                } catch (e) {
                    console.log(`[EVO] Pairing attempt ${attempts} error:`, e.response?.data || e.message);
                    if (attempts >= 20) {
                        clearInterval(pairInterval);
                        if (io) io.to(userId).emit("pairing_error", "Gagal mendapatkan kode pairing");
                    }
                }
            }, 2000);

        } else {
            // ---- QR CODE MODE ----
            let attempts = 0;
            const qrInterval = setInterval(async () => {
                attempts++;
                try {
                    const connectRes = await axios.get(`${EVO_URL}/instance/connect/${sessionId}`, {
                        headers: { 'apikey': EVO_KEY }
                    });
                    console.log(`[EVO] QR attempt ${attempts} keys:`, Object.keys(connectRes.data || {}));

                    if (connectRes.data?.base64) {
                        console.log(`[EVO] Got QR, emitting...`);
                        if (io) io.to(userId).emit("qr", connectRes.data.base64);
                    }

                    // Check if already connected
                    const stateRes = await axios.get(`${EVO_URL}/instance/connectionState/${sessionId}`, {
                        headers: { 'apikey': EVO_KEY }
                    });
                    if (stateRes.data?.instance?.state === 'open') {
                        clearInterval(qrInterval);
                        if (io) io.to(userId).emit("status", "connected");
                        if (io) io.to(userId).emit("wa_list_update");
                    }
                } catch (e) {
                    console.log(`[EVO] QR attempt ${attempts} error:`, e.response?.data || e.message);
                    if (attempts >= 30) clearInterval(qrInterval);
                }
            }, 2000);
        }

        return { success: true };
    } catch (error) {
        console.error('[EVO] Critical Error:', error.response?.data || error.message);
        return { success: false, error: error.message };
    }
}

async function getWaList(userId) {
    const sessionId = `session_${userId}`;
    try {
        const res = await axios.get(`${EVO_URL}/instance/connectionState/${sessionId}`, {
            headers: { 'apikey': EVO_KEY }
        });
        
        if (res.data && res.data.instance) {
            return [{
                sessionId,
                phone: res.data.instance.owner || 'WhatsApp',
                status: res.data.instance.state === 'open' ? 'connected' : 'disconnected'
            }];
        }
        return [];
    } catch (e) {
        return [];
    }
}

async function disconnectSession(sessionId) {
    try {
        try {
            await axios.delete(`${EVO_URL}/instance/logout/${sessionId}`, {
                headers: { 'apikey': EVO_KEY }
            });
        } catch (e) {}
        
        await axios.delete(`${EVO_URL}/instance/delete/${sessionId}`, {
            headers: { 'apikey': EVO_KEY }
        });
        return { success: true };
    } catch (error) {
        console.error('[EVO] Disconnect Error:', error.message);
        return { success: false, error: error.message };
    }
}

async function sendMessage(sessionId, to, message, mediaUrl = null) {
    try {
        let endpoint = `${EVO_URL}/message/sendText/${sessionId}`;
        let payload = {
            number: to,
            options: { delay: 1200, presence: "composing" },
            textMessage: { text: message }
        };

        if (mediaUrl) {
            endpoint = `${EVO_URL}/message/sendMedia/${sessionId}`;
            payload = {
                number: to,
                mediaMessage: {
                    mediatype: "image",
                    caption: message,
                    media: mediaUrl
                }
            };
        }

        const res = await axios.post(endpoint, payload, {
            headers: { 'apikey': EVO_KEY }
        });
        return res.data;
    } catch (error) {
        console.error(`[EVO] Failed to send to ${to}:`, error.response?.data || error.message);
        throw error;
    }
}

async function isUserConnected(userId) {
    const list = await getWaList(userId);
    return list.length > 0 && list[0].status === 'connected';
}

module.exports = {
    createInstance,
    getWaList,
    disconnectSession,
    sendMessage,
    isUserConnected
};
