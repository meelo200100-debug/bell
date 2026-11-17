// Bell Coin / BELLGRAM: Express API + Telegram bot + SQLite.
// The server is the single source of truth: mining, levels, balances and wallet checks never trust the browser.
const express = require('express'), path = require('path'), fs = require('fs');
const Database = require('better-sqlite3'), TelegramBot = require('node-telegram-bot-api');
const L = require('./lib');

const { BOT_TOKEN, WEBAPP_URL, TONAPI_KEY, DB_PATH = 'bell.db', PORT = 3000 } = process.env;
let { BOT_LINK } = process.env;

if (!BOT_TOKEN) { console.error('BOT_TOKEN is missing'); process.exit(1); }
if (!WEBAPP_URL) console.warn('WARNING: WEBAPP_URL is not set in environment variables!');

const JETTON_MASTER = 'EQAWPHubEzmFIM0UWV0yuATzbmj9HdRRn5WXvKLzqflrWGvl';
const JETTON_MASTER_RAW = '0:163c7b9b13398520cd14595d32b804f36e68fd1dd4519f9597bca2f3a9f96b58';
const JETTON_DECIMALS = 9;
const REF_BONUS = 50, MIN_CLAIM = 0.01, WALLET_TTL = 60000;
const WITHDRAW_MIN_BALANCE = 10000, WITHDRAW_MIN_WALLET = 3000;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT,
  balance REAL DEFAULT 0, started INTEGER, refs INTEGER DEFAULT 0, wallet TEXT)`);
const have = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
const add = (n, t) => { if (!have.has(n)) db.exec(`ALTER TABLE users ADD COLUMN ${n} ${t}`); };
add('seg_start', 'INTEGER DEFAULT 0'); add('acc', 'REAL DEFAULT 0'); add('rate', 'REAL DEFAULT 500');
add('mined', 'REAL DEFAULT 0'); add('streak', 'INTEGER DEFAULT 0'); add('last_login', 'INTEGER DEFAULT 0');
add('wbal', 'REAL DEFAULT 0'); add('ton', 'REAL DEFAULT 0'); add('wcheck', 'INTEGER DEFAULT 0');
add('wallet_changed', 'INTEGER DEFAULT 0'); add('last_wallet', 'TEXT'); add('referred_by', 'INTEGER');
db.exec('UPDATE users SET seg_start = started WHERE seg_start = 0 OR seg_start IS NULL');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_wallet ON users(wallet) WHERE wallet IS NOT NULL');

const get = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);

// ---- TON API (read-only) ----
async function tonapi(p) {
  const r = await fetch('https://tonapi.io/v2' + p, {
    headers: TONAPI_KEY ? { Authorization: `Bearer ${TONAPI_KEY}` } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error('tonapi ' + r.status);
  return r.json();
}
const getPublicKey = async addr => {
  try {
    const res = await tonapi(`/accounts/${encodeURIComponent(addr)}/publickey`);
    return res && res.public_key ? res.public_key : null;
  } catch (e) {
    return null; // Uninitialized wallets may return 404/400 on publickey endpoint
  }
};

function parseUnits(raw, decimals) {
  if (!raw) return 0;
  try {
    const b = BigInt(String(raw));
    const base = 10n ** BigInt(decimals);
    return Number(b / base) + Number(b % base) / Number(base);
  } catch (e) {
    return (Number(raw) || 0) / (10 ** decimals);
  }
}

async function readWallet(addr) {
  const id = encodeURIComponent(addr);
  const [acc, jets] = await Promise.all([tonapi(`/accounts/${id}`), tonapi(`/accounts/${id}/jettons?limit=1000`)]);
  const item = (jets.balances || []).find(x => {
    const a = x.jetton && String(x.jetton.address).toLowerCase();
    return a === JETTON_MASTER.toLowerCase() || a === JETTON_MASTER_RAW;
  });
  const wbal = item ? parseUnits(item.balance, JETTON_DECIMALS) : 0;
  const ton = parseUnits(acc.balance, 9);
  return { wbal: Number.isFinite(wbal) ? wbal : 0, ton: Number.isFinite(ton) ? ton : 0 };
}

// Re-reads the wallet (cached 60s) and, if the level changed, closes the old mining segment at the old rate.
async function refresh(id) {
  let u = get(id), err = false;
  const now = Date.now();
  if (u.wallet && now - u.wcheck > WALLET_TTL) {
    try {
      const w = await readWallet(u.wallet);
      db.prepare('UPDATE users SET wbal=?, ton=?, wcheck=? WHERE id=?').run(w.wbal, w.ton, now, id);
    } catch (e) {
      err = true; console.error('wallet read failed:', e.message);
      db.prepare('UPDATE users SET wcheck=? WHERE id=?').run(now - WALLET_TTL + 10000, id);
    }
    u = get(id);
  }
  const want = L.dailyFor(u.wallet ? u.wbal : 0);
  if (want !== u.rate) {
    db.prepare('UPDATE users SET acc=?, seg_start=?, rate=? WHERE id=?').run(L.round6(L.pending(u, now)), now, want, id);
    u = get(id);
  }
  return { u, err };
}

function view(u, walletError = false) {
  const now = Date.now(), wb = u.wallet ? u.wbal : 0;
  const baseLink = BOT_LINK || 'https://t.me/bellcoinbct_bot/app';
  const sep = baseLink.includes('?') ? '&' : '?';
  return {
    now, name: u.name, balance: u.balance, mined: u.mined,
    pending: L.pending(u, now), rate: u.rate, endsAt: u.started + L.DAY, level: L.levelFor(wb),
    wallet: u.wallet || null, walletBalance: wb, tonBalance: u.wallet ? u.ton : 0, walletError,
    refs: u.refs, link: `${baseLink}${sep}startapp=r${u.id}`,
    loginStreak: u.streak, lastLogin: u.last_login,
    withdraw: { minBalance: WITHDRAW_MIN_BALANCE, minWallet: WITHDRAW_MIN_WALLET, open: false,
      eligible: u.balance >= WITHDRAW_MIN_BALANCE && wb >= WITHDRAW_MIN_WALLET },
  };
}

// ---- HTTP ----
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));

// Dynamic fallback for tonconnect-manifest.json if file is not in public/
app.get('/tonconnect-manifest.json', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  const fileInPublic = path.join(__dirname, 'public', 'tonconnect-manifest.json');
  const fileInRoot = path.join(__dirname, 'tonconnect-manifest.json');
  if (fs.existsSync(fileInPublic)) return res.sendFile(fileInPublic);
  if (fs.existsSync(fileInRoot)) return res.sendFile(fileInRoot);
  const origin = WEBAPP_URL ? new URL(WEBAPP_URL).origin : `${req.protocol}://${req.get('host')}`;
  res.json({
    url: origin,
    name: 'BELLGRAM',
    iconUrl: `${origin}/icon.png`
  });
});

// Serve static files from both ./public and root directory (for index.html)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const pubIndex = path.join(__dirname, 'public', 'index.html');
  res.sendFile(fs.existsSync(pubIndex) ? pubIndex : path.join(__dirname, 'index.html'));
});

app.use('/api', (req, res, next) => {
  const v = L.verifyInitData(req.get('x-init') || '', BOT_TOKEN);
  if (!v) return res.status(401).json({ error: 'unauthorized' });
  const now = Date.now(), id = v.user.id;
  const name = String(v.user.first_name || v.user.username || 'User').slice(0, 64);
  const made = db.prepare('INSERT OR IGNORE INTO users(id,name,started,seg_start,rate) VALUES(?,?,?,?,500)').run(id, name, now, now);
  
  const cur = get(id);
  if (made.changes === 1 && !cur.referred_by) {
    const m = /^r(\d+)$/.exec(v.start || ''), ref = m ? Number(m[1]) : 0;
    if (ref && ref !== id && get(ref)) db.transaction(() => {
      db.prepare('UPDATE users SET balance=balance+?, refs=refs+1 WHERE id=?').run(REF_BONUS, ref);
      db.prepare('UPDATE users SET balance=balance+?, referred_by=? WHERE id=?').run(REF_BONUS, ref, id);
    })();
  } else {
    db.prepare('UPDATE users SET name=? WHERE id=?').run(name, id);
  }
  req.uid = id; next();
});
const ah = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'server' }); });

app.get('/api/me', ah(async (req, res) => { const { u, err } = await refresh(req.uid); res.json(view(u, err)); }));

app.post('/api/claim', ah(async (req, res) => {
  const { err } = await refresh(req.uid);
  db.transaction(() => {
    const u = get(req.uid), now = Date.now(), p = L.pending(u, now);
    if (p < MIN_CLAIM) return;
    db.prepare('UPDATE users SET balance=?, mined=?, started=?, seg_start=?, acc=0 WHERE id=?')
      .run(L.round6(u.balance + p), L.round6(u.mined + p), now, now, u.id);
  })();
  res.json(view(get(req.uid), err));
}));

app.post('/api/daily-login', ah(async (req, res) => {
  const { err } = await refresh(req.uid);
  db.transaction(() => {
    const u = get(req.uid), now = Date.now();
    if (u.last_login && now - u.last_login < L.DAY) return;
    const streak = u.last_login && now - u.last_login > 2 * L.DAY ? 1 : (u.streak % 7) + 1;
    db.prepare('UPDATE users SET balance=?, streak=?, last_login=? WHERE id=?').run(L.round6(u.balance + streak * 10), streak, now, u.id);
  })();
  res.json(view(get(req.uid), err));
}));

app.get('/api/ton-proof-payload', (req, res) => res.json({ payload: L.mkPayload(BOT_TOKEN, req.uid) }));

app.post('/api/wallet', ah(async (req, res) => {
  const b = req.body || {}, now = Date.now(), cur = get(req.uid);
  if (b.disconnect) {
    db.prepare('UPDATE users SET wallet=NULL, wbal=0, ton=0, wcheck=0 WHERE id=?').run(req.uid);
  } else {
    const domain = WEBAPP_URL ? new URL(WEBAPP_URL).host : req.get('host');
    const r = await L.verifyTonProof({ account: b.account, proof: b.proof },
      { secret: BOT_TOKEN, uid: req.uid, domain, getPublicKey });
    if (!r.ok) return res.status(r.error === 'lookup' ? 503 : 400).json({ error: r.error });
    
    if (db.prepare('SELECT 1 FROM users WHERE wallet=? AND id!=?').get(r.address, req.uid)) {
      return res.status(409).json({ error: 'wallet_taken' });
    }
    
    const prevWallet = cur.wallet || cur.last_wallet;
    if (prevWallet && prevWallet !== r.address && now - cur.wallet_changed < L.DAY) {
      return res.status(429).json({ error: 'wallet_locked' });
    }
    
    const changedAt = (!prevWallet || prevWallet !== r.address) ? now : (cur.wallet_changed || now);
    db.prepare('UPDATE users SET wallet=?, last_wallet=?, wbal=0, ton=0, wcheck=0, wallet_changed=? WHERE id=?')
      .run(r.address, r.address, changedAt, req.uid);
  }
  const { u, err } = await refresh(req.uid);
  res.json(view(u, err));
}));

const server = app.listen(PORT, () => console.log('API on', PORT));

// ---- Telegram bot ----
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
bot.getMe().then(me => {
  if (!BOT_LINK && me && me.username) {
    BOT_LINK = `https://t.me/${me.username}`;
    console.log('Auto-configured BOT_LINK:', BOT_LINK);
  }
}).catch(e => console.error('Failed to get bot info:', e.message));

bot.on('polling_error', e => console.error('polling_error', e.code, e.message));
bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const param = match && match[1] ? match[1].trim() : '';
  let appUrl = WEBAPP_URL || '';
  if (appUrl && param) {
    const sep = appUrl.includes('?') ? '&' : '?';
    appUrl = `${appUrl}${sep}tgWebAppStartParam=${encodeURIComponent(param)}`;
  }
  const opts = appUrl ? {
    reply_markup: { inline_keyboard: [[{ text: '🔔 Open BELLGRAM', web_app: { url: appUrl } }]] }
  } : {};
  bot.sendMessage(msg.chat.id,
    '🔔 Welcome to BELLGRAM!\nMine BELL every day, hold BELLGRAM to level up, and invite friends.',
    opts
  ).catch(e => console.error('sendMessage error:', e.message));
});

function shutdown() {
  bot.stopPolling().catch(() => {}).finally(() => {
    server.close(() => { db.close(); process.exit(0); });
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
