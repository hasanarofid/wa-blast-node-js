const express = require('express');
const path = require('path');
const http = require('http');
const fs = require('fs');
const socketIo = require('socket.io');
const { createInstance, sendMessage, getSession, getLatestQr, forceNewQr } = require('./services/waService');
const adminRouter = require('./adminRouter');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

// Global blast tracking
const activeBlasts = {};

app.set("io", io);

io.on("connection", (socket) => {
    socket.on("join", (userId) => {
        socket.join(userId);
        console.log(`User ${userId} joined room`);

        // If Baileys already generated a QR before this socket connected,
        socket.emit("wa_list_update");
        const { isUserConnected } = require('./services/waService');
        if (isUserConnected(userId)) {
            socket.emit("status", "connected");
        } else {
            socket.emit("status", "disconnected");
        }
    });
});

const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Admin Panel (mounted at /admin) ──────────────────────────────────────────
app.use('/admin', adminRouter);

// ── User routes ──────────────────────────────────────────────────────────────
const USERS_FILE = path.join(__dirname, 'data', 'users.json');

function readUsers() {
    if (!fs.existsSync(USERS_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}

function writeUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ── Referral Helpers ──────────────────────────────────────────────────────────
function generateRefCode(users) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code;
    do {
        code = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (users.find(u => u.refCode === code));
    return code;
}

function getClientIp(req) {
    return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function getIncentives() {
    let incentives = { ratePerMessage: 350, minWithdraw: 10000, referralBonus: 50, referralBlastBonus: 50 };
    const fp = path.join(__dirname, 'data', 'incentives.json');
    if (fs.existsSync(fp)) { try { incentives = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { } }
    // referralBlastBonus default = referralBonus jika tidak di-set
    if (!incentives.referralBlastBonus) incentives.referralBlastBonus = incentives.referralBonus || 50;
    return incentives;
}

app.post('/api/register', (req, res) => {
    const { username, whatsapp, password, ref } = req.body;
    if (!username || !whatsapp || !password) {
        return res.status(400).json({ success: false, message: 'Semua field harus diisi' });
    }
    const users = readUsers();
    if (users.find(u => u.username === username)) {
        return res.status(400).json({ success: false, message: 'Username sudah digunakan' });
    }

    const refCode = generateRefCode(users);
    const clientIp = getClientIp(req);

    const newUser = {
        username,
        whatsapp,
        password,
        balance: 0,
        referral: 0,
        referralEarnings: 0,
        referralBlastEarnings: 0,  // komisi dari blast referral
        refCode,
        referredBy: null,
        referredList: [],
        joinedAt: new Date().toISOString()
    };

    // Handle referral jika ada kode ref
    // Bonus TIDAK langsung cair saat daftar — baru cair ketika referee melakukan blast pertama kali
    if (ref) {
        const referrer = users.find(u => u.refCode === ref);
        if (referrer && referrer.username !== username) {
            // IP check: cek apakah IP ini sudah pernah digunakan referrer sebelumnya
            const usedIps = referrer.referredIps || [];
            if (usedIps.includes(clientIp)) {
                return res.status(400).json({ success: false, message: 'Link referral tidak valid untuk perangkat ini' });
            }
            // Catat relasi referral — bonus cair nanti saat referee pertama kali blast
            newUser.referredBy = referrer.username;
            newUser.hasTriggeredReferralBonus = false; // flag: belum blast, bonus belum cair

            const rIdx = users.findIndex(u => u.username === referrer.username);
            if (rIdx !== -1) {
                if (!users[rIdx].referredList) users[rIdx].referredList = [];
                users[rIdx].referredList.push({ username, joinedAt: newUser.joinedAt, hasBlastedYet: false });
                if (!users[rIdx].referredIps) users[rIdx].referredIps = [];
                users[rIdx].referredIps.push(clientIp);
            }
        }
    }

    users.push(newUser);
    writeUsers(users);
    res.json({ success: true, message: 'Registrasi berhasil', data: { username, joinedAt: newUser.joinedAt } });
});


app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const users = readUsers();
    const user = users.find(u => u.username === username && u.password === password);
    if (user) {
        res.json({ success: true, message: 'Login berhasil', data: { username: user.username, joinedAt: user.joinedAt, balance: user.balance, referral: user.referral } });
    } else {
        res.status(401).json({ success: false, message: 'Username atau password salah' });
    }
});

app.get('/api/user/info', (req, res) => {
    const { username } = req.query;
    let incentives = getIncentives();
    const users = readUsers();
    const user = username ? users.find(u => u.username === username) : null;
    res.json({
        success: true,
        user: user ? {
            username: user.username,
            balance: user.balance,
            referral: user.referral,
            joinedAt: user.joinedAt,
            totalEarnings: user.totalEarnings || 0,
            totalBlast: user.totalBlast || 0
        } : { username: '', balance: 0, referral: 0, joinedAt: null, totalEarnings: 0, totalBlast: 0 },
        incentives
    });
});

app.get('/api/user/referral-info', (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Username diperlukan' });
    const users = readUsers();
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    // Generate refCode jika user lama belum punya
    if (!user.refCode) {
        const idx = users.findIndex(u => u.username === username);
        users[idx].refCode = generateRefCode(users);
        writeUsers(users);
        user.refCode = users[idx].refCode;
    }

    const host = req.headers.host || '137.184.15.175';
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const refLink = `${protocol}://${host}/register?ref=${user.refCode}`;

    res.json({
        success: true,
        refCode: user.refCode,
        refLink,
        totalReferral: user.referral || 0,
        totalEarnings: user.referralEarnings || 0,
        totalBlastEarnings: user.referralBlastEarnings || 0,
        referredList: user.referredList || []
    });
});


// ── Payment Method endpoints ──────────────────────────────────────────────────
app.get('/api/user/payment-method', (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Username diperlukan' });
    const users = readUsers();
    const user = users.find(u => u.username === username);
    if (!user) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    res.json({ success: true, paymentMethod: user.paymentMethod || null });
});

app.post('/api/user/payment-method', (req, res) => {
    const { username, method, bankName, accountNumber, accountName, cryptoAddress } = req.body;
    if (!username || !method) return res.status(400).json({ success: false, message: 'Data tidak lengkap' });
    const users = readUsers();
    const idx = users.findIndex(u => u.username === username);
    if (idx === -1) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    if (users[idx].paymentMethod) {
        return res.status(400).json({ success: false, message: 'Metode penarikan sudah diatur dan tidak dapat diubah lagi' });
    }

    const paymentMethod = { method };
    if (method === 'bank') {
        if (!bankName || !accountNumber || !accountName) {
            return res.status(400).json({ success: false, message: 'Nama bank, nomor rekening, dan nama pemilik harus diisi' });
        }
        paymentMethod.bankName = bankName;
        paymentMethod.accountNumber = accountNumber;
        paymentMethod.accountName = accountName;
    } else if (method === 'crypto') {
        if (!cryptoAddress) {
            return res.status(400).json({ success: false, message: 'Alamat crypto harus diisi' });
        }
        paymentMethod.cryptoAddress = cryptoAddress;
    }

    users[idx].paymentMethod = paymentMethod;
    writeUsers(users);
    res.json({ success: true, message: 'Metode penarikan berhasil disimpan', paymentMethod });
});

app.post('/api/withdraw', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'Username diperlukan' });

    // Check user & balance
    let users = readUsers();
    let idx = users.findIndex(u => u.username === username);
    if (idx === -1) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    const user = users[idx];
    const incentives = getIncentives();
    const minWd = incentives.minWithdraw || 10000;

    if (user.balance < minWd) {
        return res.status(400).json({ success: false, message: `Saldo belum mencapai minimum withdraw (Rp. ${minWd})` });
    }
    if (!user.paymentMethod) {
        return res.status(400).json({ success: false, message: 'Harap atur metode penarikan di profil terlebih dahulu' });
    }

    // Process
    const wdFile = path.join(__dirname, 'data', 'withdrawals.json');
    let withdrawals = [];
    if (fs.existsSync(wdFile)) {
        try { withdrawals = JSON.parse(fs.readFileSync(wdFile, 'utf8')); } catch { }
    }

    // Potong Saldo
    const targetBalance = user.balance;
    users[idx].balance = 0;
    writeUsers(users);

    withdrawals.push({
        id: Math.random().toString(36).slice(2),
        username: user.username,
        amount: targetBalance,
        paymentMethod: user.paymentMethod,
        status: 'pending',
        createdAt: new Date().toISOString()
    });

    fs.writeFileSync(wdFile, JSON.stringify(withdrawals, null, 2));

    res.json({ success: true, message: 'Permintaan withdraw berhasil, saldo akan segera diproses.' });
});

app.get('/api/user/withdrawals', (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Username diperlukan' });

    const wdFile = path.join(__dirname, 'data', 'withdrawals.json');
    let withdrawals = [];
    if (fs.existsSync(wdFile)) {
        try { withdrawals = JSON.parse(fs.readFileSync(wdFile, 'utf8')); } catch { }
    }

    const userWd = withdrawals.filter(w => w.username === username);
    res.json({ success: true, data: userWd });
});

// Route fallbacks for HTML pages
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/referral', (req, res) => res.sendFile(path.join(__dirname, 'public', 'referral.html')));
app.get('/whatsapp', (req, res) => res.sendFile(path.join(__dirname, 'public', 'whatsapp.html')));
app.get('/withdraw', (req, res) => res.sendFile(path.join(__dirname, 'public', 'withdraw.html')));
app.get('/profil', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profil.html')));

app.post('/connect', async (req, res) => {
    const userId = req.body?.userId || "cobasaja";
    const method = req.body?.method || "qr";
    const phone = req.body?.phone || "";

    const ioInstance = req.app.get("io");
    const { getPendingSessionId } = require('./services/waService');

    // Use a stable session ID pattern based on userId to prevent identity rotation and speed up handshake
    let sid = getPendingSessionId(userId);
    if (!sid) {
        sid = `session_${userId}`;
    }

    try {
        const result = await forceNewQr(sid, userId, ioInstance, method, phone);
        if (result.error) {
            return res.status(500).json({ error: result.error });
        }
        res.json({ message: "Connecting...", sessionId: sid, ...result });
    } catch (err) {
        console.error("Connect error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/whatsapp/list', (req, res) => {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ success: false, message: 'Username diperlukan' });
    const { getUserSessionDetails } = require('./services/waService');
    res.json({ success: true, data: getUserSessionDetails(userId) });
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, message: 'sessionId diperlukan' });
    const { disconnectSession } = require('./services/waService');
    await disconnectSession(sessionId);
    res.json({ success: true, message: 'WhatsApp terputus' });
});

// Mapping mode blast ke delay dalam milidetik
const BLAST_DELAYS = {
    flazz:  100,    // 0.1 detik
    vfast:  1000,   // 1 detik
    fast:   3000,   // 3 detik
    medium: 10000,  // 10 detik
    slow:   20000,  // 20 detik
    vslow:  30000   // 30 detik
};

app.post('/api/blast/start', async (req, res) => {
    const userId = req.body?.userId || "cobasaja";
    const mode   = req.body?.mode   || "medium";
    const blastDelay = BLAST_DELAYS[mode] ?? BLAST_DELAYS.medium;
    const { isUserConnected } = require('./services/waService');
    if (!isUserConnected(userId)) {
        return res.status(400).json({ error: "WhatsApp belum terkoneksi." });
    }

    // Check if there are any targets at all before starting
    const targetsFile = path.join(__dirname, 'data', 'blast_targets.json');
    let initTargets = [];
    if (fs.existsSync(targetsFile)) {
        try { initTargets = JSON.parse(fs.readFileSync(targetsFile, 'utf8')); } catch { }
    }
    if (!initTargets.length) {
        return res.status(400).json({ error: "Belum ada target blast. Tambahkan nomor di Admin → Target Blast." });
    }

    // Try to use active admin message template
    let messageText = "Halo, selamat datang! Beli ayam dong di chickenmal ya kak...";
    let imageUrl = null;
    const msgsFile = path.join(__dirname, 'data', 'messages.json');
    if (fs.existsSync(msgsFile)) {
        try {
            const msgs = JSON.parse(fs.readFileSync(msgsFile, 'utf8'));
            const activeMsg = msgs.find(m => m.isBlastTemplate) || msgs[0];
            if (activeMsg) {
                messageText = activeMsg.content;
                imageUrl = activeMsg.imageUrl;
            }
        } catch { }
    }

    // Stop blast sebelumnya jika ada
    if (activeBlasts[userId]) {
        activeBlasts[userId].stopped = true;
        if (activeBlasts[userId]._cancelTimer) {
            clearTimeout(activeBlasts[userId]._cancelTimer);
            if (activeBlasts[userId]._cancelResolve) activeBlasts[userId]._cancelResolve();
        }
    }

    // Buat entry blast baru untuk user ini
    const blastState = { stopped: false, _cancelTimer: null, _cancelResolve: null };
    activeBlasts[userId] = blastState;
    const initialTargetCount = initTargets.length;
    res.json({ success: true, targets: initialTargetCount });

    (async () => {
        let sentCount = 0;

        while (true) {
            if (blastState.stopped) {
                console.log(`Blast stopped by user ${userId}`);
                break;
            }

            // Atomically retrieve and remove the first target
            let targetsList = [];
            if (fs.existsSync(targetsFile)) {
                try { targetsList = JSON.parse(fs.readFileSync(targetsFile, 'utf8')); } catch { }
            }

            if (targetsList.length === 0) {
                console.log(`No more targets left for user ${userId}`);
                break; // Semua nomor sudah diblast
            }

            let num = targetsList.shift();
            fs.writeFileSync(targetsFile, JSON.stringify(targetsList, null, 2));

            if (num.startsWith('08')) num = '628' + num.slice(2);

            try {
                const { checkIsOnWhatsApp, isUserConnected } = require('./services/waService');
                
                if (!isUserConnected(userId)) {
                    console.log(`[BLAST] User disconnected mid-blast. Auto-stopping.`);
                    blastState.stopped = true;
                    // Put number back
                    let targetsListSafe = [];
                    if (fs.existsSync(targetsFile)) {
                        try { targetsListSafe = JSON.parse(fs.readFileSync(targetsFile, 'utf8')); } catch { }
                    }
                    targetsListSafe.unshift(num);
                    fs.writeFileSync(targetsFile, JSON.stringify(targetsListSafe, null, 2));
                    break;
                }

                const isValidWA = await checkIsOnWhatsApp(userId, num);

                const users = readUsers();
                const uIdx = users.findIndex(u => u.username === userId);

                if (isValidWA === true) {
                    const sendResult = await sendMessage(userId, num, messageText, imageUrl);
                    // Nomor WA aktual yang dipakai blast (dari session Evolution API)
                    const senderWaNumber = (sendResult && sendResult.phone) ? sendResult.phone : userId;
                    sentCount++;
                    console.log(`[BLAST] Sent to ${num} by ${userId} (WA: ${senderWaNumber})`);

                    if (uIdx !== -1) {
                        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
                        if (!users[uIdx].daily || users[uIdx].daily.date !== todayStr) {
                            users[uIdx].daily = { date: todayStr, validWA: 0, nonValidWA: 0, earnings: 0 };
                        }
                        users[uIdx].validWA = (users[uIdx].validWA || 0) + 1;
                        users[uIdx].daily.validWA += 1;
                        const incentives = getIncentives();
                        const rate = incentives.ratePerMessage || 0;
                        if (rate > 0) {
                            users[uIdx].balance = (users[uIdx].balance || 0) + rate;
                            users[uIdx].totalEarnings = (users[uIdx].totalEarnings || 0) + rate;
                            users[uIdx].daily.earnings += rate;
                            users[uIdx].totalBlast = (users[uIdx].totalBlast || 0) + 1;
                        }

                        // ── Referral blast bonus: cair setiap kali referee blast ──────────
                        // Setiap blast yang dilakukan referee → referrer dapat komisi
                        if (users[uIdx].referredBy) {
                            const referrerUsername = users[uIdx].referredBy;
                            const rIdx = users.findIndex(u => u.username === referrerUsername);
                            if (rIdx !== -1) {
                                const blastBonus = incentives.referralBlastBonus || 50;
                                users[rIdx].balance = (users[rIdx].balance || 0) + blastBonus;
                                users[rIdx].referralEarnings = (users[rIdx].referralEarnings || 0) + blastBonus;
                                users[rIdx].referralBlastEarnings = (users[rIdx].referralBlastEarnings || 0) + blastBonus;

                                // Update referredList: tambah totalBlast & komisi per-referral
                                if (users[rIdx].referredList) {
                                    const refListIdx = users[rIdx].referredList.findIndex(r => r.username === userId);
                                    if (refListIdx !== -1) {
                                        users[rIdx].referredList[refListIdx].hasBlastedYet = true;
                                        users[rIdx].referredList[refListIdx].totalBlast = (users[rIdx].referredList[refListIdx].totalBlast || 0) + 1;
                                        users[rIdx].referredList[refListIdx].totalKomisi = (users[rIdx].referredList[refListIdx].totalKomisi || 0) + blastBonus;
                                    }
                                }
                                // Hitung ulang total referral aktif (yang sudah pernah blast)
                                if (users[rIdx].referredList) {
                                    users[rIdx].referral = users[rIdx].referredList.filter(r => r.hasBlastedYet).length;
                                }
                                console.log(`[REFERRAL] Blast bonus Rp${blastBonus} diberikan ke ${referrerUsername} karena ${userId} blast.`);
                            }
                            // Tandai sudah pernah blast (hanya sekali)
                            if (!users[uIdx].hasTriggeredReferralBonus) {
                                users[uIdx].hasTriggeredReferralBonus = true;
                            }
                        }
                        // ─────────────────────────────────────────────────────────────────
                    }

                    // Log to sendlog.json
                    const logFile = path.join(__dirname, 'data', 'sendlog.json');
                    let sendlog = [];
                    if (fs.existsSync(logFile)) {
                        try { sendlog = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch { }
                    }
                    sendlog.push({
                        id: Math.random().toString(36).slice(2),
                        fromNumber: senderWaNumber,  // nomor WA aktual yang dipakai blast
                        toNumber: num,
                        messageContent: messageText,
                        userId,
                        status: 'delivered',
                        sentAt: new Date().toISOString()
                    });
                    fs.writeFileSync(logFile, JSON.stringify(sendlog, null, 2));

                    io.to(userId).emit("blast_progress", { sent: sentCount, total: initialTargetCount });
                } else if (isValidWA === false) {
                    console.log(`[BLAST] Number ${num} is not registered on WA. Skipping message.`);
                    if (uIdx !== -1) {
                        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
                        if (!users[uIdx].daily || users[uIdx].daily.date !== todayStr) {
                            users[uIdx].daily = { date: todayStr, validWA: 0, nonValidWA: 0, earnings: 0 };
                        }
                        users[uIdx].nonValidWA = (users[uIdx].nonValidWA || 0) + 1;
                        users[uIdx].daily.nonValidWA += 1;
                    }
                } else {
                    console.log(`[BLAST] Verification error for ${num}. Postponing target.`);
                    // Put number back to queue to avoid losing it or falsely treating it as invalid
                    let targetsListSafe = [];
                    if (fs.existsSync(targetsFile)) {
                        try { targetsListSafe = JSON.parse(fs.readFileSync(targetsFile, 'utf8')); } catch { }
                    }
                    targetsListSafe.unshift(num); // Or push(num) to move to back of line
                    fs.writeFileSync(targetsFile, JSON.stringify(targetsListSafe, null, 2));
                    
                    // Delay slightly longer on API error to avoid hammering
                    await new Promise(r => setTimeout(r, 5000));
                }

                if (uIdx !== -1) {
                    writeUsers(users);
                }

                // Jeda antar pesan — bisa dicancel segera saat stop dipanggil
                await new Promise(resolve => {
                    if (blastState.stopped) return resolve();
                    const timer = setTimeout(resolve, blastDelay);
                    blastState._cancelTimer = timer;
                    blastState._cancelResolve = resolve;
                });
                blastState._cancelTimer = null;
                blastState._cancelResolve = null;
            } catch (err) {
                console.error(`[BLAST] Failed to process ${num}:`, err.message);
            }
        }

        io.to(userId).emit("blast_finished", { sent: sentCount });
        delete activeBlasts[userId];
    })();
});

app.post('/api/blast/stop', (req, res) => {
    const userId = req.body?.userId || "cobasaja";
    const blast = activeBlasts[userId];
    if (blast) {
        blast.stopped = true;
        // Cancel jeda yang sedang berjalan agar loop berhenti segera
        if (blast._cancelTimer) {
            clearTimeout(blast._cancelTimer);
            if (blast._cancelResolve) blast._cancelResolve();
        }
        // Jangan delete di sini — loop background yang akan delete setelah selesai
        return res.json({ success: true, message: "Blast dihentikan." });
    }
    res.json({ success: false, message: "Tidak ada blast berjalan." });
});
// ── Telegram Auto Report ─────────────────────────────────────────────────────
const https = require('https');

// Token bot & chat ID tujuan (Diambil dari environment variables untuk keamanan)
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// Kirim pesan teks ke Telegram
function sendTelegramMessage(message) {
    const data = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
    });
    const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    };
    const req = https.request(options, (res) => {
        res.on('data', () => {}); // Consume data
    });
    req.on('error', (e) => {
        console.error('[Telegram] Request error:', e.message);
    });
    req.write(data);
    req.end();
}

// Ambil data report untuk tanggal tertentu (format 'YYYY-MM-DD' WIB)
function getReportDataForDate(dateStr) {
    const users = readUsers();
    const wdFile = path.join(__dirname, 'data', 'withdrawals.json');
    let withdrawals = [];
    if (fs.existsSync(wdFile)) {
        try { withdrawals = JSON.parse(fs.readFileSync(wdFile, 'utf8')); } catch { }
    }

    let valid = 0, nonValid = 0, totalKomisi = 0;
    for (const user of users) {
        if (user.daily && user.daily.date === dateStr) {
            valid += user.daily.validWA || 0;
            nonValid += user.daily.nonValidWA || 0;
            totalKomisi += user.daily.earnings || 0;
        }
    }

    const dayWithdrawals = withdrawals.filter(w => {
        if (!w.createdAt) return false;
        return new Date(w.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }) === dateStr;
    });
    const totalUserWithdraw = dayWithdrawals.reduce((sum, w) => sum + (w.amount || 0), 0);

    // Sisa database blast (real-time, tidak ter-reset)
    const blastTargetsFile = path.join(__dirname, 'data', 'blast_targets.json');
    let sisaDatabase = 0;
    if (fs.existsSync(blastTargetsFile)) {
        try { sisaDatabase = JSON.parse(fs.readFileSync(blastTargetsFile, 'utf8')).length; } catch { }
    }

    // Total user registrasi pada tanggal dateStr (WIB)
    const totalUserRegist = users.filter(u => {
        if (!u.joinedAt) return false;
        return new Date(u.joinedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }) === dateStr;
    }).length;

    return { valid, nonValid, totalKomisi, totalUserWithdraw, sisaDatabase, totalUserRegist };
}

// ── 1. Report harian total KEMARIN (dipanggil jam 00:00) ─────────────────────
function sendYesterdayReport() {
    try {
        // Hitung kemarin dalam WIB
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

        const { valid, nonValid, totalKomisi, totalUserWithdraw, sisaDatabase, totalUserRegist } = getReportDataForDate(yesterdayStr);

        const message = `📊 *Report Blast Masterwavip.com*\n📅 *Tanggal:* ${yesterdayStr}\n\n✅ *WA Terkirim:* ${valid}\n❌ *WA Non Valid:* ${nonValid}\n🗃️ *Sisa Database:* ${sisaDatabase.toLocaleString('id-ID')} nomor\n👤 *Total User Regist:* ${totalUserRegist} user\n👥 *Total User Withdraw:* Rp. ${totalUserWithdraw.toLocaleString('id-ID')}\n💰 *Total Komisi User:* Rp. ${totalKomisi.toLocaleString('id-ID')}\n\n_(Report akhir hari kemarin sebelum reset)_`;

        sendTelegramMessage(message);
        console.log(`[Telegram] Report kemarin (${yesterdayStr}) terkirim.`);
    } catch (err) {
        console.error('[Telegram] Error sendYesterdayReport:', err.message);
    }
}

// ── 2. Reset data harian semua user (dipanggil jam 00:01) ───────────────────
function resetDailyData() {
    try {
        const users = readUsers();
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
        for (let i = 0; i < users.length; i++) {
            users[i].daily = { date: todayStr, validWA: 0, nonValidWA: 0, earnings: 0 };
            users[i].validWA = 0;
            users[i].nonValidWA = 0;
        }
        writeUsers(users);
        console.log(`[Reset] Data harian semua user di-reset untuk tanggal ${todayStr}.`);
    } catch (err) {
        console.error('[Reset] Error resetDailyData:', err.message);
    }
}

// ── 3. Report berkala hari ini (dipanggil jam 03:00, 06:00, dst) ─────────────
function sendTelegramReport() {
    try {
        const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
        const { valid, nonValid, totalKomisi, totalUserWithdraw, sisaDatabase, totalUserRegist } = getReportDataForDate(dateStr);

        const message = `📊 *Report Blast Masterwavip.com*\n\n✅ *WA Terkirim:* ${valid}\n❌ *WA Non Valid:* ${nonValid}\n🗃️ *Sisa Database:* ${sisaDatabase.toLocaleString('id-ID')} nomor\n👤 *Total User Regist:* ${totalUserRegist} user\n👥 *Total User Withdraw:* Rp. ${totalUserWithdraw.toLocaleString('id-ID')}\n💰 *Total Komisi User:* Rp. ${totalKomisi.toLocaleString('id-ID')}`;

        sendTelegramMessage(message);
        console.log(`[Telegram Report] Report hari ini (${dateStr}) terkirim.`);
    } catch (err) {
        console.error('[Telegram Report] Error generating report:', err.message);
    }
}

// ── Jadwal Cron (WIB / Asia/Jakarta) ────────────────────────────────────────
// 00:00 → Kirim report total KEMARIN
cron.schedule('0 0 * * *', () => {
    sendYesterdayReport();
}, { timezone: "Asia/Jakarta" });

// 00:01 → Reset data harian
cron.schedule('1 0 * * *', () => {
    resetDailyData();
}, { timezone: "Asia/Jakarta" });

// Setiap jam (01:00–23:00) → Report hari ini (sejak reset)
cron.schedule('0 1-23 * * *', () => {
    sendTelegramReport();
}, { timezone: "Asia/Jakarta" });

server.listen(PORT, () => {
    console.log(`Express server running on http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);

    // Auto-reconnect sessions
    const sessionsDir = path.join(__dirname, 'sessions');
    if (fs.existsSync(sessionsDir)) {
        const folders = fs.readdirSync(sessionsDir);
        for (const sessionId of folders) {
            let userId = sessionId;
            if (sessionId.includes('_')) {
                userId = sessionId.split('_')[0];
            }
            console.log(`Auto-reconnecting session ${sessionId} for ${userId}`);
            createInstance(sessionId, userId, io).catch(err => console.error("Reconnect failed for", sessionId, err));
        }
    }
});
