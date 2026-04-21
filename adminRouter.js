const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const router = express.Router();

// ─── Data file helpers ───────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, 'data');

function readJson(file) {
    const fp = path.join(DATA_DIR, file);
    if (!fs.existsSync(fp)) return null;
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function writeJson(file, data) {
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf8');
}

// ─── Active admin sessions (in-memory token store) ──────────────────────────

const adminSessions = new Set();

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
    const token = req.headers['x-admin-token'] || req.query.token;
    if (token && adminSessions.has(token)) return next();
    return res.status(401).json({ success: false, message: 'Unauthorized' });
}

// ─── Serve login page ─────────────────────────────────────────────────────────

router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html'));
});

router.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html'));
});

// ─── Login / Logout ───────────────────────────────────────────────────────────

router.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const adminData = readJson('admin.json');
    if (!adminData) return res.status(500).json({ success: false, message: 'Config error' });

    // Support both array (multi-admin) and legacy single object
    const admins = Array.isArray(adminData) ? adminData : [adminData];
    const match = admins.find(a => a.email === email && a.password === password);

    if (match) {
        const token = crypto.randomBytes(32).toString('hex');
        adminSessions.add(token);
        return res.json({ success: true, token });
    }
    return res.status(401).json({ success: false, message: 'Email atau password salah' });
});


router.post('/api/logout', requireAdmin, (req, res) => {
    const token = req.headers['x-admin-token'];
    adminSessions.delete(token);
    res.json({ success: true });
});

// ─── Stats overview ───────────────────────────────────────────────────────────

router.get('/api/stats', requireAdmin, (req, res) => {
    const sendlog = readJson('sendlog.json') || [];
    const messages = readJson('messages.json') || [];
    const usersList = readJson('users.json') || [];

    // Count connected devices from in-memory session state (real-time, same as /api/wa-numbers)
    const { _getConnectedSessions } = require('./services/waService');
    const connectedSessions = _getConnectedSessions ? _getConnectedSessions() : [];
    const connectedDevices = connectedSessions.length;

    // Use registered users count
    const uniqueUsers = usersList.length;

    // Count messages sent today (WIB = UTC+7)
    const nowWIB = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const todayStr = nowWIB.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const sentToday = sendlog.filter(log => {
        if (!log.sentAt) return false;
        const logWIB = new Date(new Date(log.sentAt).getTime() + 7 * 60 * 60 * 1000);
        return logWIB.toISOString().slice(0, 10) === todayStr;
    }).length;

    res.json({
        success: true,
        stats: {
            totalSent: sendlog.length,
            connectedDevices,
            sentToday,
            totalMessages: messages.length,
            uniqueUsers
        }
    });
});

// ─── WA Monitoring (Session-based, read-only + force-disconnect) ──────────────

// GET: hanya tampilkan sesi yang saat ini AKTIF/connected (dari in-memory)
router.get('/api/wa-numbers', requireAdmin, (req, res) => {
    const { getUserSessionDetails } = require('./services/waService');

    // Kumpulkan semua sesi dari semua user yang pernah konek
    // getUserSessionDetails hanya terima satu userId, jadi kita perlu akses langsung
    const { _getConnectedSessions } = require('./services/waService');
    const list = _getConnectedSessions ? _getConnectedSessions() : [];

    res.json({ success: true, data: list });
});

// DELETE: force-disconnect Baileys session + delete session folder
router.delete('/api/wa-numbers/:id', requireAdmin, async (req, res) => {
    const userId = req.params.id;
    const sessionsDir = path.join(__dirname, 'sessions');
    const sessionPath = path.join(sessionsDir, userId);

    if (!fs.existsSync(sessionPath)) {
        return res.status(404).json({ success: false, message: 'Session tidak ditemukan' });
    }

    try {
        const { disconnectSession } = require('./services/waService');
        await disconnectSession(userId);
        res.json({ success: true, message: `Session ${userId} berhasil diputus dan dihapus.` });
    } catch (e) {
        console.error('[Admin] Error disconnecting session:', e);
        res.status(500).json({ success: false, message: 'Gagal memutus koneksi: ' + e.message });
    }
});

// ─── Message Templates CRUD ───────────────────────────────────────────────────

router.get('/api/messages', requireAdmin, (req, res) => {
    const list = readJson('messages.json') || [];
    res.json({ success: true, data: list });
});

router.post('/api/messages', requireAdmin, (req, res) => {
    const { title, content, image } = req.body;
    if (!title || !content) return res.status(400).json({ success: false, message: 'Judul dan isi wajib diisi' });
    const list = readJson('messages.json') || [];

    let imageUrl = null;
    if (image && image.startsWith('data:image')) {
        try {
            const base64Data = image.split(';base64,').pop();
            const extMatch = image.match(/data:image\/(.*?);base64/);
            const ext = extMatch ? extMatch[1] : 'png';
            const filename = `img_${crypto.randomBytes(4).toString('hex')}.${ext}`;
            const filepath = path.join(__dirname, 'public', 'uploads', filename);
            if (!fs.existsSync(path.join(__dirname, 'public', 'uploads'))) {
                fs.mkdirSync(path.join(__dirname, 'public', 'uploads'), { recursive: true });
            }
            fs.writeFileSync(filepath, base64Data, { encoding: 'base64' });
            imageUrl = `/uploads/${filename}`;
        } catch (e) {
            console.error('Failed to save image:', e);
        }
    }

    const newItem = {
        id: crypto.randomBytes(8).toString('hex'),
        title: title.trim(),
        content: content.trim(),
        imageUrl: imageUrl,
        createdAt: new Date().toISOString()
    };
    list.push(newItem);
    writeJson('messages.json', list);
    res.json({ success: true, data: newItem });
});

router.put('/api/messages/:id', requireAdmin, (req, res) => {
    const { title, content, image } = req.body;
    const list = readJson('messages.json') || [];
    const idx = list.findIndex(m => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });

    let imageUrl = list[idx].imageUrl || null;
    if (image && image.startsWith('data:image')) {
        try {
            const base64Data = image.split(';base64,').pop();
            const extMatch = image.match(/data:image\/(.*?);base64/);
            const ext = extMatch ? extMatch[1] : 'png';
            const filename = `img_${crypto.randomBytes(4).toString('hex')}.${ext}`;
            const filepath = path.join(__dirname, 'public', 'uploads', filename);
            if (!fs.existsSync(path.join(__dirname, 'public', 'uploads'))) {
                fs.mkdirSync(path.join(__dirname, 'public', 'uploads'), { recursive: true });
            }
            fs.writeFileSync(filepath, base64Data, { encoding: 'base64' });
            imageUrl = `/uploads/${filename}`;
        } catch (e) {
            console.error('Failed to save image:', e);
        }
    } else if (image === '') {
        // If image is explicitly sent as empty (to clear)
        imageUrl = null;
    }

    list[idx] = { ...list[idx], title: title || list[idx].title, content: content || list[idx].content, imageUrl };
    writeJson('messages.json', list);
    res.json({ success: true, data: list[idx] });
});

router.delete('/api/messages/:id', requireAdmin, (req, res) => {
    let list = readJson('messages.json') || [];
    const before = list.length;
    list = list.filter(m => m.id !== req.params.id);
    if (list.length === before) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
    writeJson('messages.json', list);
    res.json({ success: true });
});

// Set one template as the active blast template
router.post('/api/messages/:id/set-blast', requireAdmin, (req, res) => {
    let list = readJson('messages.json') || [];
    const idx = list.findIndex(m => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
    // Unset all, then set the chosen one
    list = list.map(m => ({ ...m, isBlastTemplate: false }));
    list[idx].isBlastTemplate = true;
    writeJson('messages.json', list);
    res.json({ success: true, data: list[idx] });
});

// ─── Send Message (Admin blast specific) ─────────────────────────────────────

router.post('/api/send', requireAdmin, async (req, res) => {
    const { fromNumber, toNumber, messageContent } = req.body;
    if (!fromNumber || !toNumber || !messageContent) {
        return res.status(400).json({ success: false, message: 'Semua field wajib diisi' });
    }

    // Log the send action
    const sendlog = readJson('sendlog.json') || [];
    const logEntry = {
        id: crypto.randomBytes(8).toString('hex'),
        fromNumber,
        toNumber,
        messageContent,
        userId: 'admin',
        status: 'sent',
        sentAt: new Date().toISOString()
    };
    sendlog.push(logEntry);
    writeJson('sendlog.json', sendlog);

    // Attempt actual send via waService if session available
    try {
        const { getSession, sendMessage } = require('./services/waService');
        // fromNumber is used as userId key (userId = phone number for admin-connected WA)
        const sock = getSession(fromNumber);
        if (sock) {
            let target = toNumber.trim();
            if (target.startsWith('08')) target = '628' + target.slice(2);
            await sendMessage(fromNumber, target, messageContent);
            logEntry.status = 'delivered';
        } else {
            logEntry.status = 'no_session';
        }
    } catch (e) {
        logEntry.status = 'error';
    }

    // Update log with final status
    const updatedLog = readJson('sendlog.json') || [];
    const li = updatedLog.findIndex(l => l.id === logEntry.id);
    if (li !== -1) { updatedLog[li].status = logEntry.status; writeJson('sendlog.json', updatedLog); }

    res.json({ success: true, data: logEntry });
});

// ─── Incentive Settings ───────────────────────────────────────────────────────

router.get('/api/incentives', requireAdmin, (req, res) => {
    const data = readJson('incentives.json') || { ratePerMessage: 350, minWithdraw: 10000, referralBonus: 50, referralBlastBonus: 50 };
    res.json({ success: true, data });
});

router.put('/api/incentives', requireAdmin, (req, res) => {
    const { ratePerMessage, minWithdraw, referralBonus, referralBlastBonus } = req.body;
    const current = readJson('incentives.json') || {};
    const updated = {
        ratePerMessage: ratePerMessage !== undefined ? Number(ratePerMessage) : current.ratePerMessage,
        minWithdraw: minWithdraw !== undefined ? Number(minWithdraw) : current.minWithdraw,
        referralBonus: referralBonus !== undefined ? Number(referralBonus) : current.referralBonus,
        referralBlastBonus: referralBlastBonus !== undefined ? Number(referralBlastBonus) : (current.referralBlastBonus || current.referralBonus || 50)
    };
    writeJson('incentives.json', updated);
    res.json({ success: true, data: updated });
});

// ─── Reports ─────────────────────────────────────────────────────────────────

// Laporan devices — status real-time dari Evolution API (in-memory waService)
router.get('/api/report/devices', requireAdmin, (req, res) => {
    const sessionsDir = path.join(__dirname, 'sessions');
    const { _getConnectedSessions } = require('./services/waService');
    const connectedSessions = _getConnectedSessions ? _getConnectedSessions() : [];
    const connectedIds = new Set(connectedSessions.map(s => s.id));

    const devices = [];
    if (fs.existsSync(sessionsDir)) {
        const userFolders = fs.readdirSync(sessionsDir);
        for (const sessionId of userFolders) {
            const folderPath = path.join(sessionsDir, sessionId);
            const stat = fs.statSync(folderPath);
            const isConnected = connectedIds.has(sessionId);
            if (!isConnected) continue; // Filter: Hanya tampilkan yang Sedang Konek

            // Determine userId from sessionId (format: userId_timestamp)
            const userId = sessionId.includes('_')
                ? sessionId.split('_').slice(0, -1).join('_')
                : sessionId;
            devices.push({
                userId,
                sessionId,
                connectedSince: stat.birthtime,
                lastActivity: stat.mtime,
                status: 'connected'
            });
        }
    }

    // Sort by latest activity
    devices.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

    res.json({ success: true, data: devices });
});

// Laporan users (now reading from users.json)
router.get('/api/report/users', requireAdmin, (req, res) => {
    const users = readJson('users.json') || [];
    // Also attach sendlog data to show total messages sent
    const sendlog = readJson('sendlog.json') || [];
    const sentCount = {};
    for (const log of sendlog) {
        sentCount[log.userId] = (sentCount[log.userId] || 0) + 1;
    }
    const data = users.map(u => ({
        userId: u.username,
        whatsapp: u.whatsapp,
        totalSent: sentCount[u.username] || 0,
        joinedAt: u.joinedAt,
        balance: u.balance || 0,
        referral: u.referral || 0,
        referredBy: u.referredBy || null,
        paymentMethod: u.paymentMethod || null,
        password: u.password
    }));
    res.json({ success: true, data });
});

// Update User (Edit bank, password)
router.post('/api/users/:username/edit', requireAdmin, (req, res) => {
    const { username } = req.params;
    const { password, bankName, accountNumber, accountName } = req.body;
    let users = readJson('users.json') || [];
    const idx = users.findIndex(u => u.username === username);
    if (idx === -1) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    if (password) users[idx].password = password;
    if (bankName !== undefined) {
        if (!users[idx].paymentMethod) users[idx].paymentMethod = { method: 'bank' };
        users[idx].paymentMethod.bankName = bankName;
        users[idx].paymentMethod.accountNumber = accountNumber;
        users[idx].paymentMethod.accountName = accountName;
    }

    writeJson('users.json', users);
    res.json({ success: true, message: 'User berhasil diupdate' });
});

// ─── Withdrawals Management ───────────────────────────────────────────────────

router.get('/api/withdrawals', requireAdmin, (req, res) => {
    const data = readJson('withdrawals.json') || [];
    // Sort pending first, then newest
    data.sort((a, b) => {
        if (a.status === 'pending' && b.status !== 'pending') return -1;
        if (a.status !== 'pending' && b.status === 'pending') return 1;
        return new Date(b.createdAt) - new Date(a.createdAt);
    });
    res.json({ success: true, data });
});

router.post('/api/withdrawals/:id/approve', requireAdmin, (req, res) => {
    const wdList = readJson('withdrawals.json') || [];
    const idx = wdList.findIndex(w => w.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
    if (wdList[idx].status !== 'pending') return res.status(400).json({ success: false, message: 'Status sudah diproses' });

    wdList[idx].status = 'approved';
    wdList[idx].processedAt = new Date().toISOString();
    writeJson('withdrawals.json', wdList);
    res.json({ success: true, message: 'Withdrawal di-approve' });
});

router.post('/api/withdrawals/:id/reject', requireAdmin, (req, res) => {
    const wdList = readJson('withdrawals.json') || [];
    const idx = wdList.findIndex(w => w.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Tidak ditemukan' });
    if (wdList[idx].status !== 'pending') return res.status(400).json({ success: false, message: 'Status sudah diproses' });

    wdList[idx].status = 'rejected';
    wdList[idx].processedAt = new Date().toISOString();

    // Kembalikan saldo user
    let users = readJson('users.json') || [];
    const uIdx = users.findIndex(u => u.username === wdList[idx].username);
    if (uIdx !== -1) {
        users[uIdx].balance = (users[uIdx].balance || 0) + (wdList[idx].amount || 0);
        writeJson('users.json', users);
    }

    writeJson('withdrawals.json', wdList);
    res.json({ success: true, message: 'Withdrawal di-reject dan saldo dikembalikan' });
});



// Laporan pengiriman (from → to)
router.get('/api/report/sendlog', requireAdmin, (req, res) => {
    const sendlog = readJson('sendlog.json') || [];
    const users = readJson('users.json') || [];
    // Sort newest first
    const sorted = [...sendlog].sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
    
    const mapped = sorted.map(log => {
        const user = users.find(u => u.username === log.userId);
        let senderPhone = '081234567890';
        if (user && user.whatsapp) {
            senderPhone = user.whatsapp;
            if (senderPhone.startsWith('8')) senderPhone = '0' + senderPhone;
            else if (senderPhone.startsWith('628')) senderPhone = '0' + senderPhone.slice(2);
        }
        return {
            ...log,
            senderPhone
        };
    });

    res.json({ success: true, data: mapped });
});

// Public endpoint so user pages can fetch incentive settings (no auth needed)
router.get('/api/public/incentives', (req, res) => {
    const data = readJson('incentives.json') || { ratePerMessage: 350, minWithdraw: 10000, referralBonus: 50, referralBlastBonus: 50 };
    res.json({ success: true, data });
});

// Public endpoint: get the active blast template (used by user's whatsapp page)
router.get('/api/public/blast-template', (req, res) => {
    const list = readJson('messages.json') || [];
    const active = list.find(m => m.isBlastTemplate) || list[0] || null;
    res.json({ success: true, data: active });
});

// Public endpoint: get blast targets so server.js blast can consume it
router.get('/api/public/blast-targets', (req, res) => {
    const list = readJson('blast_targets.json') || [];
    res.json({ success: true, data: list, count: list.length });
});

// ─── Blast Targets Management ─────────────────────────────────────────────────

// Helper: normalize a phone number to 628xxx format
function normalizePhone(raw) {
    let n = String(raw).replace(/\D/g, '').trim();
    if (!n) return null;
    if (n.startsWith('08')) n = '628' + n.slice(2);
    if (n.startsWith('8') && n.length >= 9) n = '62' + n;
    return n.length >= 10 ? n : null;
}

// GET: current blast target list
router.get('/api/blast-targets', requireAdmin, (req, res) => {
    const list = readJson('blast_targets.json') || [];
    res.json({ success: true, data: list, count: list.length });
});

// POST add single number
router.post('/api/blast-targets/add', requireAdmin, (req, res) => {
    const { number } = req.body;
    const n = normalizePhone(number);
    if (!n) return res.status(400).json({ success: false, message: 'Nomor tidak valid' });
    let list = readJson('blast_targets.json') || [];
    if (list.includes(n)) return res.status(409).json({ success: false, message: 'Nomor sudah ada dalam list' });
    list.push(n);
    writeJson('blast_targets.json', list);
    res.json({ success: true, data: list, count: list.length });
});

// POST upload CSV text (client parses file → sends raw text)
router.post('/api/blast-targets/upload-csv', requireAdmin, (req, res) => {
    const { csv, mode } = req.body; // mode: 'replace' | 'append'
    if (!csv) return res.status(400).json({ success: false, message: 'CSV kosong' });

    // Parse: split on newlines and/or commas, normalize each number
    const rawNums = csv.split(/[\n,;]+/);
    const valid = [];
    const invalid = [];
    for (const raw of rawNums) {
        const n = normalizePhone(raw.trim());
        if (n) valid.push(n);
        else if (raw.trim()) invalid.push(raw.trim());
    }

    // Deduplicate
    const unique = [...new Set(valid)];

    let list = (mode === 'append') ? (readJson('blast_targets.json') || []) : [];
    const merged = [...new Set([...list, ...unique])];
    writeJson('blast_targets.json', merged);

    res.json({
        success: true,
        data: merged,
        count: merged.length,
        added: unique.length,
        skipped: invalid.length,
        invalid: invalid.slice(0, 10) // return first 10 invalid for feedback
    });
});

// DELETE single number
router.delete('/api/blast-targets/:number', requireAdmin, (req, res) => {
    let list = readJson('blast_targets.json') || [];
    const before = list.length;
    // Accept both normalized and raw formats
    const target = normalizePhone(req.params.number) || req.params.number;
    list = list.filter(n => n !== target && n !== req.params.number);
    if (list.length === before) return res.status(404).json({ success: false, message: 'Nomor tidak ada dalam list' });
    writeJson('blast_targets.json', list);
    res.json({ success: true, data: list, count: list.length });
});

// DELETE all (reset)
router.delete('/api/blast-targets', requireAdmin, (req, res) => {
    writeJson('blast_targets.json', []);
    res.json({ success: true, data: [], count: 0, message: 'Semua target blast telah direset' });
});

module.exports = router;

