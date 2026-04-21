const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    makeInMemoryStore,
    delay
} = require("@whiskeysockets/baileys");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
const { Boom } = require("@hapi/boom");

// Logger configuration
const logger = pino({ level: 'silent' });

// Global session management
const sessions = {}; // sessionId -> { socket, userId, status }
const sessionStatus = {}; // sessionId -> 'pending' | 'connected' | 'disconnected'
const qrs = {}; // sessionId -> base64qr

// Directory for sessions
const SESSIONS_DIR = path.join(__dirname, "..", "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

/**
 * Initialize a Baileys session
 */
async function createInstance(sessionId, userId, io, pairingNumber = null) {
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        browser: ["Chrome", "macOS", "110.0.0.0"],
        markOnline: true,
        syncFullHistory: false, // For speed like Evolution API
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        generateHighQualityLinkPreview: true,
    });

    sessions[sessionId] = { socket: sock, userId, status: 'pending' };
    sessionStatus[sessionId] = 'pending';

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        console.log(`[BAILEYS] Update for ${sessionId}: connection=${connection}, qr=${qr ? 'yes' : 'no'}, status=${sessionStatus[sessionId]}`);
        
        if (qr && !pairingNumber) {
            const QRCode = require('qrcode');
            QRCode.toDataURL(qr, (err, url) => {
                if (!err && io) {
                    io.to(userId).emit("qr", url);
                }
            });
        }

        if (connection === 'close') {
            const isLoggedOut = (lastDisconnect?.error)?.output?.statusCode === DisconnectReason.loggedOut;
            // Force reconnect if still pending/pairing to overcome VPS IP flapping
            const shouldReconnect = !isLoggedOut || sessionStatus[sessionId] === 'pending';
            
            console.log(`[BAILEYS] Connection closed for ${sessionId}. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                // IMPORTANT: Use delay for pending sessions to avoid spamming server
                const delay = sessionStatus[sessionId] === 'pending' ? 5000 : 0;
                setTimeout(() => {
                    createInstance(sessionId, userId, io);
                }, delay);
            } else {
                sessionStatus[sessionId] = 'disconnected';
                if (io) {
                    io.to(userId).emit("status", "disconnected");
                    io.to(userId).emit("wa_list_update");
                }
                delete sessions[sessionId];
                delete sessionStatus[sessionId];
            }
        } else if (connection === 'open') {
            console.log(`[BAILEYS] Connection opened for session: ${sessionId}`);
            sessionStatus[sessionId] = 'connected';
            if (io) {
                io.to(userId).emit("status", "connected");
                io.to(userId).emit("wa_list_update");
            }
        }
    });

    let pairingCodeResolved = null;

    // Only request pairing code if explicitly provided (first time)
    if (pairingNumber && !sock.authState.creds.registered) {
        console.log(`[BAILEYS] Requesting fresh pairing code for ${pairingNumber}`);
        await delay(3000);
        try {
            const cleanNumber = pairingNumber.replace(/[^0-9]/g, '');
            pairingCodeResolved = await sock.requestPairingCode(cleanNumber);
            console.log(`[BAILEYS] Pairing code for ${cleanNumber}: ${pairingCodeResolved}`);
        } catch (err) {
            console.error(`[BAILEYS] Failed to request pairing code:`, err.message);
        }
    }

    return pairingCodeResolved;
}

/**
 * Force a new QR (or pairing code)
 */
async function forceNewQr(sessionId, userId, io, method = 'qr', phone = '') {
    // If session exists, disconnect first
    if (sessions[sessionId]) {
        await disconnectSession(sessionId);
    }

    // Clean session folder to ensure fresh pairing/qr
    const sessionPath = path.join(SESSIONS_DIR, sessionId);
    if (fs.existsSync(sessionPath)) {
        try {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch (err) {
            console.error(`[BAILEYS] Failed to clean session folder:`, err.message);
        }
    }

    const pairingCode = await createInstance(sessionId, userId, io, method === 'pairing' ? phone : null);
    return { success: true, pairingCode };
}

/**
 * Disconnect and cleanup a session
 */
async function disconnectSession(sessionId) {
    if (sessions[sessionId]) {
        try {
            // Defensive cleanup to prevent crash on closing/connecting socket
            const s = sessions[sessionId].socket;
            if (s.ws?.readyState === 1) { // OPEN
                await s.logout().catch(() => {});
            }
            s.end();
        } catch (e) {}
        delete sessions[sessionId];
        delete sessionStatus[sessionId];
        delete qrs[sessionId];
        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
    }
}

/**
 * Send a message (Text or Image)
 */
async function sendMessage(userId, number, text, imageUrl = null) {
    const activeSession = Object.keys(sessions).find(sid => 
        sessions[sid].userId === userId && sessionStatus[sid] === 'connected'
    );

    if (!activeSession) throw new Error("WhatsApp tidak terhubung");

    const sock = sessions[activeSession].socket;
    const jid = number.includes('@s.whatsapp.net') ? number : `${number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    let result;
    if (imageUrl) {
        const localPath = path.join(__dirname, '..', 'public', imageUrl);
        if (!fs.existsSync(localPath)) {
            // Fallback to text if image not found
            result = await sock.sendMessage(jid, { text: text });
        } else {
            result = await sock.sendMessage(jid, { 
                image: fs.readFileSync(localPath), 
                caption: text 
            });
        }
    } else {
        result = await sock.sendMessage(jid, { text: text });
    }

    return { 
        sessionId: activeSession, 
        phone: sock.user.id.split(':')[0],
        result 
    };
}

/**
 * Check if a number is on WhatsApp
 */
async function checkIsOnWhatsApp(userId, number) {
    const activeSession = Object.keys(sessions).find(sid => 
        sessions[sid].userId === userId && sessionStatus[sid] === 'connected'
    );

    if (!activeSession) return null;

    const sock = sessions[activeSession].socket;
    const jid = number.includes('@s.whatsapp.net') ? number : `${number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    try {
        const [result] = await sock.onWhatsApp(jid);
        return result ? result.exists : false;
    } catch (err) {
        console.error(`[checkIsOnWhatsApp] Error:`, err.message);
        return null;
    }
}

/**
 * Status Helpers
 */
function isUserConnected(userId) {
    return Object.keys(sessions).some(sid => 
        sessions[sid].userId === userId && sessionStatus[sid] === 'connected'
    );
}

function getUserSessionDetails(userId) {
    const list = [];
    const sessionIds = Object.keys(sessions).filter(id => sessions[id].userId === userId);
    for (const sid of sessionIds) {
        const sock = sessions[sid].socket;
        const status = sessionStatus[sid];
        list.push({
            sessionId: sid,
            phone: status === 'connected' ? sock.user.id.split(':')[0] : 'Menunggu Scan',
            status: status || 'pending'
        });
    }
    return list;
}

function getPendingSessionId(userId) {
    return Object.keys(sessions).find(sid => 
        sessions[sid].userId === userId && sessionStatus[sid] === 'pending'
    );
}

function _getConnectedSessions() {
    const list = [];
    for (const sessionId of Object.keys(sessions)) {
        if (sessionStatus[sessionId] !== 'connected') continue;
        const sock = sessions[sessionId].socket;
        const phone = sock.user.id.split(':')[0];
        let phoneDisplay = phone;
        if (phoneDisplay && phoneDisplay.startsWith('62')) {
            phoneDisplay = '0' + phoneDisplay.slice(2);
        }
        list.push({
            id: sessionId,
            number: sessionId,
            label: sessions[sessionId].userId,
            phone: phone,
            phoneDisplay: phoneDisplay,
            status: 'connected',
            connectedAt: new Date().toISOString()
        });
    }
    return list;
}

// Stubs for legacy support
function getSession(sessionId) { return sessions[sessionId]; }
function getAllSessions() { return sessions; }
function getLatestQr(sessionId) { return qrs[sessionId]; }
function getSessionPhone(userId) {
    const list = Object.keys(sessions).filter(sid => 
        sessions[sid].userId === userId && sessionStatus[sid] === 'connected'
    );
    return list.length > 0 ? sessions[list[0]].socket.user.id.split(':')[0] : null;
}
function getAllSessionPhones() {
    const phones = {};
    for (const sid in sessions) {
        if (sessionStatus[sid] === 'connected') {
            phones[sid] = sessions[sid].socket.user.id.split(':')[0];
        }
    }
    return phones;
}

module.exports = { 
    createInstance, 
    getSession, 
    getAllSessions, 
    getLatestQr, 
    getSessionPhone, 
    getAllSessionPhones, 
    forceNewQr, 
    disconnectSession, 
    sendMessage, 
    getPendingSessionId, 
    getUserSessionDetails, 
    isUserConnected, 
    checkIsOnWhatsApp, 
    _getConnectedSessions 
};
