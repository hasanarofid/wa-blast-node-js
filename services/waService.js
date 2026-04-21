const axios = require('axios');
const fs = require('fs');
const path = require('path');

const EVO_URL = process.env.EVO_URL || 'http://evolution:8080';
const EVO_KEY = process.env.EVO_KEY || 'setorwasecret123';

/**
 * Evolution API Service (v16 Revolution)
 */

const instances = {}; // cache of instance status

async function createInstance(sessionId, userId, io, pairingNumber = null) {
    try {
        console.log(`[EVO] Initializing instance for ${sessionId}...`);
        
        // 1. Attempt to create (will fail if exists, which is fine)
        try {
            const payload = {
                instanceName: sessionId,
                token: EVO_KEY,
                pairingCode: !!pairingNumber
            };
            if (pairingNumber) payload.number = pairingNumber;

            await axios.post(`${EVO_URL}/instance/create`, payload, { 
                headers: { 'apikey': EVO_KEY } 
            });
            console.log(`[EVO] Instance ${sessionId} initialized.`);
        } catch (e) {
            console.log(`[EVO] Instance ${sessionId} already exists or create skipped.`);
        }

        // 2. Immediate Initial Check
        const fetchConnect = async () => {
            try {
                const res = await axios.get(`${EVO_URL}/instance/connect/${sessionId}`, {
                    headers: { 'apikey': EVO_KEY }
                });
                if (res.data && res.data.base64) {
                    if (io) io.to(userId).emit("qr", res.data.base64);
                }
                if (pairingNumber && res.data && res.data.code) {
                     if (io) io.to(userId).emit("pairing_code", res.data.code);
                     return true;
                }
            } catch (e) {}
            return false;
        };

        await fetchConnect();

        // 3. Robust Polling (Every 1s for first 10s, then 2s)
        if (pairingNumber) {
            let pairAttempts = 0;
            const pairInterval = setInterval(async () => {
                pairAttempts++;
                try {
                    const pairRes = await axios.get(`${EVO_URL}/instance/pairingCode/${sessionId}?number=${pairingNumber}`, {
                        headers: { 'apikey': EVO_KEY }
                    });
                    if (pairRes.data && pairRes.data.code) {
                        if (io) io.to(userId).emit("pairing_code", pairRes.data.code);
                        clearInterval(pairInterval);
                    }
                } catch (e) {
                    if (pairAttempts > 60) clearInterval(pairInterval);
                }
            }, 1000);
        } else {
            const qrInterval = setInterval(async () => {
                try {
                    await fetchConnect();
                    const stateRes = await axios.get(`${EVO_URL}/instance/connectionState/${sessionId}`, {
                        headers: { 'apikey': EVO_KEY }
                    });
                    if (stateRes.data?.instance?.state === 'open') {
                        clearInterval(qrInterval);
                        if (io) io.to(userId).emit("status", "connected");
                        if (io) io.to(userId).emit("wa_list_update");
                    }
                } catch (e) {
                    clearInterval(qrInterval);
                }
            }, 1500);
        }

        return { success: true };
    } catch (error) {
        console.error('[EVO] Critical Error:', error.message);
        return { success: false, error: error.message };
    }
}

async function getWaList(userId) {
    // In Evolution API, we look for instances starting with our prefix or simple match
    // For this simple app, we just check the specific sessionId derived from userId
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
        // Try logout first, but don't fail if it's already disconnected
        try {
            await axios.delete(`${EVO_URL}/instance/logout/${sessionId}`, {
                headers: { 'apikey': EVO_KEY }
            });
        } catch (e) {}
        
        // Force delete the instance
        await axios.delete(`${EVO_URL}/instance/delete/${sessionId}`, {
            headers: { 'apikey': EVO_KEY }
        });
        return { success: true };
    } catch (error) {
        console.error('[EVO] Disconnect Error:', error.message);
        return { success: false, error: error.message };
    }
}

// Blast function using Evolution API
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
