// Bell Coin / BELLGRAM: Express API + Telegram bot + Turso Cloud SQLite (@libsql/client).
// The server is the single source of truth: mining, levels, balances and wallet checks never trust the browser.
const express = require('express'), path = require('path'), fs = require('fs');
const { createClient } = require('@libsql/client');
const TelegramBot = require('node-telegram-bot-api');
const L = require('./lib');

const { BOT_TOKEN, WEBAPP_URL, TONAPI_KEY, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, DB_PATH = 'file:bell.db', PORT = 3000 } = process.env;
let { BOT_LINK } = process.env;

if (!BOT_TOKEN) { console.error('BOT_TOKEN is missing'); process.exit(1); }
if (!WEBAPP_URL) console.warn('WARNING: WEBAPP_URL is not set in environment variables!');
if (!TURSO_DATABASE_URL) console.warn('WARNING: TURSO_DATABASE_URL is not set! Falling back to local file database.');

const JETTON_MASTER = 'EQAWPHubEzmFIM0UWV0yuATzbmj9HdRRn5WXvKLzqflrWGvl';
const JETTON_MASTER_RAW = '0:163c7b9b13398520cd14595d32b804f36e68fd1dd4519f9597bca2f3a9f96b58';
const JETTON_DECIMALS = 9;
const REF_BONUS = 50, MIN_CLAIM = 0.01, WALLET_TTL = 60000;
const WITHDRAW_MIN_BALANCE = 10000, WITHDRAW_MIN_WALLET = 3000;

// Connect to Turso Cloud Database (or local file fallback if TURSO_DATABASE_URL is not set)
const db = createClient({
  url: TURSO_DATABASE_URL || (DB_PATH.startsWith('file:') ? DB_PATH : `file:${DB_PATH}`),
  authToken: TURSO_AUTH_TOKEN,
});

async function run(sql, args = []) {
  return db.execute({ sql, args });
}

async function get(id) {
  const r = await run('SELECT * FROM users WHERE id=?', [id]);
  if (!r.rows || !r.rows[0]) return null;
  const row = r.rows[0];
  return {
    id: Number(row.id),
    name: String(row.name || 'User'),
    balance: Number(row.balance || 0),
    started: Number(row.started || 0),
    refs: Number(row.refs || 0),
    wallet: row.wallet ? String(row.wallet) : null,
    seg_start: Number(row.seg_start || 0),
    acc: Number(row.acc || 0),
    rate: Number(row.rate || 500),
    mined: Number(row.mined || 0),
    streak: Number(row.streak || 0),
    last_login: Number(row.last_login || 0),
    wbal: Number(row.wbal || 0),
    ton: Number(row.ton || 0),
    wcheck: Number(row.wcheck || 0),
    wallet_changed: Number(row.wallet_changed || 0),
    last_wallet: row.last_wallet ? String(row.last_wallet) : null,
    referred_by: row.referred_by ? Number(row.referred_by) : null,
  };
}

async function initDB() {
  await run(`CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY,
    name TEXT,
    balance REAL DEFAULT 0,
    started INTEGER,
    refs INTEGER DEFAULT 0,
    wallet TEXT,
    seg_start INTEGER DEFAULT 0,
    acc REAL DEFAULT 0,
    rate REAL DEFAULT 500,
    mined REAL DEFAULT 0,
    streak INTEGER DEFAULT 0,
    last_login INTEGER DEFAULT 0,
    wbal REAL DEFAULT 0,
    ton REAL DEFAULT 0,
    wcheck INTEGER DEFAULT 0,
    wallet_changed INTEGER DEFAULT 0,
    last_wallet TEXT,
    referred_by INTEGER
  )`);
  const info = await run('PRAGMA table_info(users)');
  const have = new Set((info.rows || []).map(c => c.name));
  const add = async (n, t) => { if (!have.has(n)) await run(`ALTER TABLE users ADD COLUMN ${n} ${t}`); };
  await add('seg_start', 'INTEGER DEFAULT 0');
  await add('acc', 'REAL DEFAULT 0');
  await add('rate', 'REAL DEFAULT 500');
  await add('mined', 'REAL DEFAULT 0');
  await add('streak', 'INTEGER DEFAULT 0');
  await add('last_login', 'INTEGER DEFAULT 0');
  await add('wbal', 'REAL DEFAULT 0');
  await add('ton', 'REAL DEFAULT 0');
  await add('wcheck', 'INTEGER DEFAULT 0');
  await add('wallet_changed', 'INTEGER DEFAULT 0');
  await add('last_wallet', 'TEXT');
  await add('referred_by', 'INTEGER');
  await run('UPDATE users SET seg_start = started WHERE seg_start = 0 OR seg_start IS NULL');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS users_wallet ON users(wallet) WHERE wallet IS NOT NULL');
  console.log('Database initialized successfully (Turso ready)');
}

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
    return null;
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
  let u = await get(id), err = false;
  const now = Date.now();
  if (u.wallet && now - u.wcheck > WALLET_TTL) {
    try {
      const w = await readWallet(u.wallet);
      await run('UPDATE users SET wbal=?, ton=?, wcheck=? WHERE id=?', [w.wbal, w.ton, now, id]);
    } catch (e) {
      err = true; console.error('wallet read failed:', e.message);
      await run('UPDATE users SET wcheck=? WHERE id=?', [now - WALLET_TTL + 10000, id]);
    }
    u = await get(id);
  }
  const want = L.dailyFor(u.wallet ? u.wbal : 0);
  if (want !== u.rate) {
    await run('UPDATE users SET acc=?, seg_start=?, rate=? WHERE id=?', [L.round6(L.pending(u, now)), now, want, id]);
    u = await get(id);
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

app.get('/tonconnect-manifest.json', (req, res) => {
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

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const pubIndex = path.join(__dirname, 'public', 'index.html');
  res.sendFile(fs.existsSync(pubIndex) ? pubIndex : path.join(__dirname, 'index.html'));
});

const ah = fn => (req, res, next) => fn(req, res, next).catch(e => { console.error(e); res.status(500).json({ error: 'server' }); });

app.use('/api', ah(async (req, res, next) => {
  const v = L.verifyInitData(req.get('x-init') || '', BOT_TOKEN);
  if (!v) return res.status(401).json({ error: 'unauthorized' });
  const now = Date.now(), id = v.user.id;
  const name = String(v.user.first_name || v.user.username || 'User').slice(0, 64);
  const made = await run('INSERT OR IGNORE INTO users(id,name,started,seg_start,rate) VALUES(?,?,?,?,500)', [id, name, now, now]);

  const cur = await get(id);
  if (made.rowsAffected === 1 && cur && !cur.referred_by) {
    const m = /^r(\d+)$/.exec(v.start || ''), ref = m ? Number(m[1]) : 0;
    if (ref && ref !== id && await get(ref)) {
      await db.batch([
        { sql: 'UPDATE users SET balance=balance+?, refs=refs+1 WHERE id=?', args: [REF_BONUS, ref] },
        { sql: 'UPDATE users SET balance=balance+?, referred_by=? WHERE id=?', args: [REF_BONUS, ref, id] }
      ], 'write');
    }
  } else {
    await run('UPDATE users SET name=? WHERE id=?', [name, id]);
  }
  req.uid = id; next();
}));

app.get('/api/me', ah(async (req, res) => { const { u, err } = await refresh(req.uid); res.json(view(u, err)); }));

app.post('/api/claim', ah(async (req, res) => {
  const { err } = await refresh(req.uid);
  const u = await get(req.uid), now = Date.now(), p = L.pending(u, now);
  if (p >= MIN_CLAIM) {
    await run('UPDATE users SET balance=?, mined=?, started=?, seg_start=?, acc=0 WHERE id=?',
      [L.round6(u.balance + p), L.round6(u.mined + p), now, now, u.id]);
  }
  res.json(view(await get(req.uid), err));
}));

app.post('/api/daily-login', ah(async (req, res) => {
  const { err } = await refresh(req.uid);
  const u = await get(req.uid), now = Date.now();
  if (!u.last_login || now - u.last_login >= L.DAY) {
    const streak = u.last_login && now - u.last_login > 2 * L.DAY ? 1 : (u.streak % 7) + 1;
    await run('UPDATE users SET balance=?, streak=?, last_login=? WHERE id=?',
      [L.round6(u.balance + streak * 10), streak, now, u.id]);
  }
  res.json(view(await get(req.uid), err));
}));

app.get('/api/ton-proof-payload', (req, res) => res.json({ payload: L.mkPayload(BOT_TOKEN, req.uid) }));

app.post('/api/wallet', ah(async (req, res) => {
  const b = req.body || {}, now = Date.now(), cur = await get(req.uid);
  if (b.disconnect) {
    await run('UPDATE users SET wallet=NULL, wbal=0, ton=0, wcheck=0 WHERE id=?', [req.uid]);
  } else {
    const domain = WEBAPP_URL ? new URL(WEBAPP_URL).host : req.get('host');
    const r = await L.verifyTonProof({ account: b.account, proof: b.proof },
      { secret: BOT_TOKEN, uid: req.uid, domain, getPublicKey });
    if (!r.ok) return res.status(r.error === 'lookup' ? 503 : 400).json({ error: r.error });

    const taken = await run('SELECT 1 FROM users WHERE wallet=? AND id!=?', [r.address, req.uid]);
    if (taken.rows && taken.rows.length > 0) {
      return res.status(409).json({ error: 'wallet_taken' });
    }

    const prevWallet = cur.wallet || cur.last_wallet;
    if (prevWallet && prevWallet !== r.address && now - cur.wallet_changed < L.DAY) {
      return res.status(429).json({ error: 'wallet_locked' });
    }

    const changedAt = (!prevWallet || prevWallet !== r.address) ? now : (cur.wallet_changed || now);
    await run('UPDATE users SET wallet=?, last_wallet=?, wbal=0, ton=0, wcheck=0, wallet_changed=? WHERE id=?',
      [r.address, r.address, changedAt, req.uid]);
  }
  const { u, err } = await refresh(req.uid);
  res.json(view(u, err));
}));

let server;
initDB().then(() => {
  server = app.listen(PORT, () => console.log('API on', PORT));
}).catch(e => {
  console.error('Database initialization failed:', e);
  process.exit(1);
});

// ---- Telegram bot ----
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
bot.getMe().then(me => {
  if (!BOT_LINK && me && me.username) {
    BOT_LINK = `https://t.me/${me.username}/app`;
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
    '🔔 Welcome to BELLGRAM Mining!\n\n' +
    'Ring the bell and start your daily crypto mining adventure on Telegram.\n\n' +
    '⛏️ Mine and collect BELL every day\n' +
    '💎 Hold BELLGRAM in your TON wallet to boost your rate\n' +
    '🏅 Climb through 6 mining leagues\n' +
    '📅 Claim daily login streak bonuses\n' +
    '👥 Invite friends and earn 50 BELL for every join\n\n' +
    '👇 Start your journey with the button below.',
    opts
  ).catch(e => console.error('sendMessage error:', e.message));
});

function shutdown() {
  bot.stopPolling().catch(() => {}).finally(() => {
    if (server) server.close(() => process.exit(0));
    else process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
