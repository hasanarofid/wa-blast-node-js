const axios = require('axios');

const EVO_URL = process.env.EVO_URL || 'http://evolution:8080';
const EVO_KEY = process.env.EVO_KEY || 'setorwasecret123';

/**
 * Evolution API Service (v17 - Evolution API v2.x with Pairing Code support)
 * v2 endpoints:
 *   POST /instance/create              - create instance
 *   GET  /instance/connect/{id}        - get QR (returns base64)
 *   POST /instance/pairing-code/{id}   - request pairing code (returns {code})
 *   GET  /instance/connectionState/{id}- get state
 *   DELETE /instance/logout/{id}       - logout
 *   DELETE /instance/delete/{id}       - delete
 */

// Global polling tracker to prevent multiple intervals for the same session
const activePolls = {};

function stopPolling(sessionId) {
    if (activePolls[sessionId]) {
        console.log(`[EVO v1] Stopping existing poll for ${sessionId}`);
        clearInterval(activePolls[sessionId]);
        delete activePolls[sessionId];
    }
}

async function createInstance(sessionId, userId, io, pairingNumber = null) {
    try {
        console.log(`[EVO v2] Starting fresh for ${sessionId} | pairing=${pairingNumber}`);
        
        // 1. Force cleanup of any existing polling loop
        stopPolling(sessionId);

        // 2. Proactive Clean Slate
        console.log(`[EVO v2] Force cleanup for ${sessionId}...`);
        try {
            await axios.delete(`${EVO_URL}/instance/delete/${sessionId}`, { headers: { 'apikey': EVO_KEY } });
            await new Promise(r => setTimeout(r, 500));
        } catch (e) {}

        // 3. Create fresh instance with v2 payload
        let createSuccess = false;
        const createPayload = {
            instanceName: sessionId,
            token: EVO_KEY,
            integration: 'WHATSAPP-BAILEYS',
            alwaysOnline: true
        };

        try {
            await axios.post(`${EVO_URL}/instance/create`, createPayload, { 
                headers: { 'apikey': EVO_KEY } 
            });
            createSuccess = true;
        } catch (e) {
            console.log(`[EVO v2] Create fail:`, e.response?.data?.message?.[0] || e.message);
        }

        if (!createSuccess) throw new Error("Gagal membuat instance.");

        console.log(`[EVO v2] Instance ready: ${sessionId}`);
        // Ultra-fast wait for v2
        await new Promise(r => setTimeout(r, 1000));

        if (pairingNumber) {
            // PAIRING CODE MODE - v2 uses GET /instance/connect/{id}?number={num}
            console.log(`[EVO v2] Requesting pairing code for ${pairingNumber}...`);
            let pairAttempts = 0;
            activePolls[sessionId] = setInterval(async () => {
                pairAttempts++;
                try {
                    const pairRes = await axios.get(
                        `${EVO_URL}/instance/connect/${sessionId}?number=${String(pairingNumber)}`,
                        { headers: { 'apikey': EVO_KEY } }
                    );
                    
                    console.log(`[EVO v2] Pairing Res [Attempt ${pairAttempts}]:`, JSON.stringify(pairRes.data));

                    const code = pairRes.data?.code || 
                                 pairRes.data?.pairingCode || 
                                 pairRes.data?.instance?.pairingCode;

                    if (code && typeof code === 'string' && code.length >= 6) {
                        console.log(`[EVO v2] DECTECTED Pairing code: ${code}`);
                        if (io) io.to(userId).emit("pairing_code", code);
                        stopPolling(sessionId);
                    }
                } catch (e) {
                    console.log(`[EVO v2] Pairing attempt ${pairAttempts} error:`, e.response?.data?.message?.[0] || e.message);
                    if (pairAttempts >= 30) stopPolling(sessionId);
                }
            }, 2000);

        } else {
            // QR CODE MODE
            let qrAttempts = 0;
            activePolls[sessionId] = setInterval(async () => {
                qrAttempts++;
                try {
                    const connectRes = await axios.get(`${EVO_URL}/instance/connect/${sessionId}`, {
                        headers: { 'apikey': EVO_KEY }
                    });
                    
                    const qrBase64 = connectRes.data?.base64;
                    if (qrBase64) {
                        if (io) io.to(userId).emit("qr", qrBase64);
                    }

                    // Check if open
                    const stateRes = await axios.get(`${EVO_URL}/instance/connectionState/${sessionId}`, {
                        headers: { 'apikey': EVO_KEY }
                    });
                    if (stateRes.data?.instance?.state === 'open') {
                        stopPolling(sessionId);
                        if (io) io.to(userId).emit("status", "connected");
                        if (io) io.to(userId).emit("wa_list_update");
                    }
                } catch (e) {
                    console.log(`[EVO v2] QR attempt ${qrAttempts} error:`, e.message);
                    if (qrAttempts >= 40) stopPolling(sessionId);
                }
            }, 1000); // Super fast QR polling
        }

        return { success: true };
    } catch (error) {
        console.error('[EVO v2] Critical Error:', error.message);
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
            await axios.delete(`${EVO_URL}/instance/logout/${sessionId}`, { headers: { 'apikey': EVO_KEY } });
        } catch (e) {}
        await axios.delete(`${EVO_URL}/instance/delete/${sessionId}`, { headers: { 'apikey': EVO_KEY } });
        return { success: true };
    } catch (error) {
        console.error('[EVO v2] Disconnect Error:', error.message);
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
        console.error(`[EVO v2] Failed to send to ${to}:`, error.response?.data || error.message);
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
