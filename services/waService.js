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

async function createInstance(sessionId, userId, io, pairingNumber = null) {
    try {
        console.log(`[EVO v2] Starting fresh for ${sessionId} | pairing=${pairingNumber}`);

        // 1. Proactive Clean Slate (v17.8)
        console.log(`[EVO v2] Force cleanup for ${sessionId}...`);
        try {
            await axios.delete(`${EVO_URL}/instance/logout/${sessionId}`, { headers: { 'apikey': EVO_KEY } });
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {}
        try {
            await axios.delete(`${EVO_URL}/instance/delete/${sessionId}`, { headers: { 'apikey': EVO_KEY } });
            await new Promise(r => setTimeout(r, 2000));
        } catch (e) {}

        // 2. Create fresh instance with robust retry
        let createSuccess = false;
        const createPayload = {
            instanceName: sessionId,
            token: EVO_KEY,
            integration: 'WHATSAPP-BAILEYS',
            alwaysOnline: true,
            pairingCode: !!pairingNumber
        };
        if (pairingNumber) createPayload.number = String(pairingNumber);

        for (let i = 0; i < 5; i++) {
            try {
                await axios.post(`${EVO_URL}/instance/create`, createPayload, { 
                    headers: { 'apikey': EVO_KEY } 
                });
                createSuccess = true;
                break;
            } catch (e) {
                const errMsg = e.response?.data?.message?.[0] || e.message;
                console.log(`[EVO v2] Create attempt ${i+1} fail: ${errMsg}`);
                
                // If already in use despite delete, try deleting one more time
                if (errMsg.includes("already in use")) {
                    await axios.delete(`${EVO_URL}/instance/delete/${sessionId}`, { headers: { 'apikey': EVO_KEY } }).catch(()=>{});
                    await new Promise(r => setTimeout(r, 3000));
                } else {
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }

        if (!createSuccess) throw new Error("Gagal membuat instance setelah 5 percobaan.");

        console.log(`[EVO v2] Instance ready: ${sessionId} | pairing=${!!pairingNumber}`);

        // 3. Wait for initialization
        await new Promise(r => setTimeout(r, 6000));

        if (pairingNumber) {
            // PAIRING CODE MODE - v2.2.3 uses the connect endpoint with a number query
            let pairAttempts = 0;
            const pairInterval = setInterval(async () => {
                pairAttempts++;
                try {
                    const pairRes = await axios.get(
                        `${EVO_URL}/instance/connect/${sessionId}?number=${String(pairingNumber)}`,
                        { headers: { 'apikey': EVO_KEY } }
                    );
                    console.log(`[EVO v2] Pairing attempt ${pairAttempts}:`, JSON.stringify(pairRes.data));

                    // In v2, the code can be in .code or .pairingCode
                    const code = pairRes.data?.code || pairRes.data?.pairingCode;
                    if (code && typeof code === 'string' && code.length >= 6) {
                        console.log(`[EVO v2] Got pairing code: ${code}`);
                        if (io) io.to(userId).emit("pairing_code", code);
                        clearInterval(pairInterval);
                    }
                } catch (e) {
                    console.log(`[EVO v2] Pairing attempt ${pairAttempts} error:`, e.response?.data || e.message);
                    if (pairAttempts >= 20) clearInterval(pairInterval);
                }
            }, 3000);

        } else {
            // QR CODE MODE
            let qrAttempts = 0;
            const qrInterval = setInterval(async () => {
                qrAttempts++;
                try {
                    const connectRes = await axios.get(`${EVO_URL}/instance/connect/${sessionId}`, {
                        headers: { 'apikey': EVO_KEY }
                    });
                    
                    // In v2, base64 might be nested or direct
                    const qrBase64 = connectRes.data?.base64 || connectRes.data?.code;
                    console.log(`[EVO v2] QR attempt ${qrAttempts}, has_qr: ${!!qrBase64}`);

                    if (qrBase64 && typeof qrBase64 === 'string' && qrBase64.length > 100) {
                        if (io) io.to(userId).emit("qr", qrBase64);
                    }

                    // Check state
                    try {
                        const stateRes = await axios.get(`${EVO_URL}/instance/connectionState/${sessionId}`, {
                            headers: { 'apikey': EVO_KEY }
                        });
                        if (stateRes.data?.instance?.state === 'open') {
                            clearInterval(qrInterval);
                            if (io) io.to(userId).emit("status", "connected");
                            if (io) io.to(userId).emit("wa_list_update");
                        }
                    } catch (e) {}

                } catch (e) {
                    console.log(`[EVO v2] QR attempt ${qrAttempts} error:`, e.message);
                    if (qrAttempts >= 40) clearInterval(qrInterval);
                }
            }, 2000);
        }

        return { success: true };
    } catch (error) {
        console.error('[EVO v2] Critical Error:', error.response?.data || error.message);
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
