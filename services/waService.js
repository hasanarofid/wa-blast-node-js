const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Logger for Baileys
const logger = pino({ level: 'silent' });

// Global session storage
const sessions = new Map();
const qrCodes = new Map();

/**
 * Baileys Service (Native Integration)
 * Replaces Evolution API v2
 */

async function createInstance(sessionId, userId, io, pairingNumber = null, isReconnect = false) {
    try {
        console.log(`[Baileys] Starting session ${sessionId} | pairing=${pairingNumber} | isReconnect=${isReconnect}`);
        
        const sessionDir = path.join(__dirname, '..', 'sessions', sessionId);
        
        // Handle existing session in memory
        if (sessions.has(sessionId)) {
            console.log(`[Baileys] Closing existing in-memory session for ${sessionId}`);
            try { 
                const oldSock = sessions.get(sessionId);
                oldSock.ev.removeAllListeners();
                // Instead of logout (which might kill the session), we just end the connection
                oldSock.end(); 
            } catch(e) {}
            sessions.delete(sessionId);
        }

        // Proactive cleanup ONLY if it's NOT a reconnect and it's NOT registered
        if (!isReconnect) {
            const { state: tempState } = await useMultiFileAuthState(sessionDir);
            if (!tempState.creds.registered) {
                console.log(`[Baileys] Cleaning up unregistered session directory for ${sessionId}`);
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            getMessage: async (key) => { return { conversation: 'hello' } }
        });

        sessions.set(sessionId, sock);

        // Handle pairing code ONLY if NOT a reconnect
        if (pairingNumber && !sock.authState.creds.registered && !isReconnect) {
            console.log(`[Baileys] Requesting pairing code for ${pairingNumber}`);
            setTimeout(async () => {
                try {
                    let number = pairingNumber.replace(/[^0-9]/g, '');
                    if (!number.startsWith('62') && number.startsWith('0')) {
                        number = '62' + number.slice(1);
                    }
                    const code = await sock.requestPairingCode(number);
                    console.log(`[Baileys] Pairing code successfully generated: ${code}`);
                    if (io) io.to(userId).emit("pairing_code", code);
                } catch (e) {
                    console.error("[Baileys] Pairing code error:", e.message);
                    if (io) io.to(userId).emit("error", "Gagal meminta kode pairing. Silakan coba lagi.");
                }
            }, 3000);
        }

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !pairingNumber) {
                const QRCode = require('qrcode');
                QRCode.toDataURL(qr, (err, url) => {
                    if (!err && io) io.to(userId).emit("qr", url);
                });
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log(`[Baileys] Connection closed for ${sessionId}. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    createInstance(sessionId, userId, io, pairingNumber, true);
                } else {
                    console.log(`[Baileys] Session ${sessionId} logged out or terminated.`);
                    sessions.delete(sessionId);
                    if (io) io.to(userId).emit("status", "disconnected");
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
            } else if (connection === 'open') {
                console.log(`[Baileys] Connection opened for ${sessionId}`);
                if (io) {
                    io.to(userId).emit("status", "connected");
                    io.to(userId).emit("wa_list_update");
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        return { success: true };
    } catch (error) {
        console.error('[Baileys] Critical Error:', error.message);
        return { success: false, error: error.message };
    }
}

async function getWaList(userId) {
    const sessionId = `session_${userId}`;
    const sock = sessions.get(sessionId);
    if (sock && sock.user) {
        return [{
            sessionId,
            phone: jidNormalizedUser(sock.user.id).split('@')[0],
            status: 'connected'
        }];
    }
    
    // Check if session folder exists
    const sessionDir = path.join(__dirname, '..', 'sessions', sessionId);
    if (fs.existsSync(sessionDir)) {
        return [{
            sessionId,
            phone: 'WhatsApp',
            status: 'disconnected'
        }];
    }
    
    return [];
}

async function disconnectSession(sessionId) {
    try {
        const sock = sessions.get(sessionId);
        if (sock) {
            await sock.logout();
            sessions.delete(sessionId);
        }
        const sessionDir = path.join(__dirname, '..', 'sessions', sessionId);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
        return { success: true };
    } catch (error) {
        console.error('[Baileys] Disconnect Error:', error.message);
        return { success: false, error: error.message };
    }
}

async function checkIsOnWhatsApp(userId, number) {
    const sessionId = `session_${userId}`;
    const sock = sessions.get(sessionId);
    if (!sock) return null;

    try {
        let jid = number.replace(/[^0-9]/g, '');
        if (!jid.includes('@')) jid = jid + '@s.whatsapp.net';
        
        const [result] = await sock.onWhatsApp(jid);
        return result?.exists || false;
    } catch (e) {
        console.error(`[Baileys] Check WA Error for ${number}:`, e.message);
        return null;
    }
}

function getSession(sessionId) {
    return sessions.get(sessionId);
}

async function getUserSessionDetails(userId) {
    const list = await getWaList(userId);
    return list[0] || null;
}

async function _getConnectedSessions() {
    const connected = [];
    for (const [id, sock] of sessions.entries()) {
        if (sock.user) {
            connected.push({
                id,
                phone: jidNormalizedUser(sock.user.id).split('@')[0],
                status: 'connected'
            });
        }
    }
    return connected;
}

async function sendMessage(sessionId, to, message, mediaUrl = null) {
    let sock = sessions.get(sessionId);
    
    // If not in memory but session exists on disk, try to recover
    if (!sock) {
        const userId = sessionId.replace('session_', '');
        // In a real app, we'd need 'io' here for recovery. 
        // For simplicity, we assume server.js auto-reconnects.
        throw new Error("Session not active. Please reconnect.");
    }

    try {
        let jid = to.replace(/[^0-9]/g, '');
        if (!jid.includes('@')) jid = jid + '@s.whatsapp.net';

        let result;
        if (mediaUrl) {
            result = await sock.sendMessage(jid, {
                image: { url: mediaUrl },
                caption: message
            });
        } else {
            result = await sock.sendMessage(jid, { text: message });
        }

        return { 
            status: 'sent', 
            id: result.key.id, 
            phone: jidNormalizedUser(sock.user.id).split('@')[0] 
        };
    } catch (error) {
        console.error(`[Baileys] Failed to send to ${to}:`, error.message);
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
    isUserConnected,
    checkIsOnWhatsApp,
    getSession,
    getUserSessionDetails,
    _getConnectedSessions
};
