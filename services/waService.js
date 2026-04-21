const axios = require('axios');

const EVO_URL = process.env.EVO_URL || 'http://evolution:8080';
const EVO_KEY = process.env.EVO_KEY || 'setorwasecret123';

/**
 * Evolution API Service (v16.23 - Use /instance/connect for both QR and Pairing)
 * /instance/connect returns: { pairingCode, code, base64, count }
 */

async function createInstance(sessionId, userId, io, pairingNumber = null) {
    try {
        console.log(`[EVO] Starting fresh instance for ${sessionId} (pairingNumber: ${pairingNumber})...`);

        // 1. Force cleanup existing
        try {
            await axios.delete(`${EVO_URL}/instance/logout/${sessionId}`, { headers: { 'apikey': EVO_KEY } });
            await axios.delete(`${EVO_URL}/instance/delete/${sessionId}`, { headers: { 'apikey': EVO_KEY } });
        } catch (e) {}

        // 2. Create Fresh Instance
        const payload = { instanceName: sessionId, token: EVO_KEY };
        if (pairingNumber) {
            payload.number = String(pairingNumber);
            payload.pairingCode = true;
        }

        const createRes = await axios.post(`${EVO_URL}/instance/create`, payload, {
            headers: { 'apikey': EVO_KEY }
        });
        console.log(`[EVO] Instance created ok`);

        // 3. Wait for WA engine handshake
        await new Promise(r => setTimeout(r, 3000));

        // 4. Poll /instance/connect which returns: { pairingCode, code, base64, count }
        let attempts = 0;
        let codeEmitted = false;

        const pollInterval = setInterval(async () => {
            attempts++;
            try {
                const res = await axios.get(`${EVO_URL}/instance/connect/${sessionId}`, {
                    headers: { 'apikey': EVO_KEY }
                });

                const data = res.data;
                console.log(`[EVO] connect attempt ${attempts} - keys:`, Object.keys(data || {}));
                console.log(`[EVO] code=${data?.code}, pairingCode=${data?.pairingCode}, hasBase64=${!!data?.base64}`);

                if (pairingNumber) {
                    // In pairing mode - look for the 8-char pairing code
                    const rawCode = data?.code || data?.pairingCode;
                    if (rawCode && typeof rawCode === 'string') {
                        // Clean and validate: pairing codes are 8 alphanumeric chars
                        const cleanCode = rawCode.replace(/[^A-Z0-9]/gi, '');
                        console.log(`[EVO] rawCode="${rawCode}", cleanCode="${cleanCode}", len=${cleanCode.length}`);
                        if (cleanCode.length >= 6 && cleanCode.length <= 10 && !codeEmitted) {
                            codeEmitted = true;
                            console.log(`[EVO] EMITTING pairing code: ${cleanCode}`);
                            if (io) io.to(userId).emit("pairing_code", cleanCode);
                            clearInterval(pollInterval);
                        }
                    }
                } else {
                    // QR mode - emit base64 QR
                    if (data?.base64) {
                        if (io) io.to(userId).emit("qr", data.base64);
                    }

                    // Check connected
                    const stateRes = await axios.get(`${EVO_URL}/instance/connectionState/${sessionId}`, {
                        headers: { 'apikey': EVO_KEY }
                    });
                    if (stateRes.data?.instance?.state === 'open') {
                        clearInterval(pollInterval);
                        if (io) io.to(userId).emit("status", "connected");
                        if (io) io.to(userId).emit("wa_list_update");
                    }
                }
            } catch (e) {
                console.log(`[EVO] poll attempt ${attempts} error:`, e.response?.data || e.message);
            }

            if (attempts >= 40) {
                console.log(`[EVO] poll timeout, stopping.`);
                clearInterval(pollInterval);
                if (pairingNumber && !codeEmitted && io) {
                    io.to(userId).emit("pairing_error", "Timeout: nomor tidak valid atau WA belum terhubung");
                }
            }
        }, 2000);

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
