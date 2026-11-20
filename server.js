const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');
const TelegramBot = require('node-telegram-bot-api');
const L = require('./lib');

const {
  BOT_TOKEN,
  TURSO_DATABASE_URL,
  TURSO_AUTH_TOKEN,
  DB_PATH = 'file:newsbot.db',
  PORT = 3000,
  ADMIN_CHAT_ID = '',
  ADMIN_ID = '',
  TARGET_CHANNELS = '@Alkatiba21',
  X_FEED_URL = '',
  FETCH_INTERVAL_MS = '300000',
  PRICE_THRESHOLD_PCT = '3',
} = process.env;

const ADMIN = String(ADMIN_CHAT_ID || ADMIN_ID || '8869642405').trim();
const intervalMs = Math.max(60000, Number(FETCH_INTERVAL_MS) || 300000);
const priceThreshold = Math.max(0.5, Number(PRICE_THRESHOLD_PCT) || 3);

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing');
  process.exit(1);
}

const db = createClient({
  url: TURSO_DATABASE_URL || (DB_PATH.startsWith('file:') ? DB_PATH : `file:${DB_PATH}`),
  authToken: TURSO_AUTH_TOKEN,
});

async function run(sql, args = []) {
  return db.execute({ sql, args });
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
let isRunning = true;
let lastCycleAt = null;
let lastError = null;
let latestPrices = [];

async function initDB() {
  await run(`CREATE TABLE IF NOT EXISTS settings(
    k TEXT PRIMARY KEY,
    v TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS sources(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    value TEXT NOT NULL UNIQUE,
    active INTEGER DEFAULT 1
  )`);
  await run(`CREATE TABLE IF NOT EXISTS targets(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL UNIQUE,
    active INTEGER DEFAULT 1
  )`);
  await run(`CREATE TABLE IF NOT EXISTS posted_items(
    hash TEXT PRIMARY KEY,
    source TEXT,
    title TEXT,
    posted_at INTEGER
  )`);

  const enabledRes = await run("SELECT v FROM settings WHERE k='enabled'");
  if (!enabledRes.rows || !enabledRes.rows.length) {
    await run("INSERT INTO settings(k, v) VALUES('enabled', '1')");
  } else {
    isRunning = enabledRes.rows[0].v !== '0';
  }

  await run("INSERT INTO settings(k, v) VALUES('template', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [
    L.DEFAULT_TEMPLATE,
  ]);

  for (const ch of L.DEFAULT_CHANNELS) {
    await run("INSERT OR IGNORE INTO sources(type, value, active) VALUES('tg_channel', ?, 1)", [ch]);
  }
  for (const feed of L.DEFAULT_RSS_FEEDS) {
    await run("INSERT OR IGNORE INTO sources(type, value, active) VALUES('rss', ?, 1)", [feed]);
  }
  for (const handle of L.DEFAULT_X_HANDLES) {
    await run("INSERT OR IGNORE INTO sources(type, value, active) VALUES('x_account', ?, 1)", [handle]);
  }
  if (X_FEED_URL) {
    for (const u of X_FEED_URL.split(',').map(s => s.trim()).filter(Boolean)) {
      await run("INSERT OR IGNORE INTO sources(type, value, active) VALUES('x_feed', ?, 1)", [u]);
    }
  }

  const seedTargets = ['@Alkatiba21', ...(TARGET_CHANNELS || '').split(',')];
  for (const rawTarget of seedTargets) {
    const t = L.cleanTargetChannel(rawTarget);
    if (t) {
      await run("INSERT OR IGNORE INTO targets(chat_id, active) VALUES(?, 1)", [t]);
    }
  }
}

async function getTemplate() {
  const r = await run("SELECT v FROM settings WHERE k='template'");
  return (r.rows && r.rows[0] && r.rows[0].v) || L.DEFAULT_TEMPLATE;
}

async function setEnabledState(val) {
  isRunning = !!val;
  await run("INSERT INTO settings(k, v) VALUES('enabled', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [
    isRunning ? '1' : '0',
  ]);
}

async function getActiveTargets() {
  const r = await run("SELECT chat_id FROM targets WHERE active=1 ORDER BY id ASC");
  return (r.rows || []).map(x => String(x.chat_id));
}

function decodeHtml(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchTelegramChannel(username) {
  const url = `https://t.me/s/${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CryptoNewsBot/1.0)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return [];
  const html = await res.text();
  const blocks = [...html.matchAll(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
  return blocks
    .slice(-8)
    .map(m => L.stripLinksAndHandles(decodeHtml(m[1])))
    .filter(txt => txt.length >= 20)
    .map(txt => ({
      bodyAr: txt,
      bodyEn: txt,
    }));
}

async function fetchRssFeed(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CryptoNewsBot/1.0)' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return [];
  const xml = await res.text();
  const items = [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)];
  return items
    .slice(0, 8)
    .map(block => {
      const raw = block[0];
      const title = L.stripLinksAndHandles(decodeHtml((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''));
      const desc = L.stripLinksAndHandles(decodeHtml((raw.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] || ''));
      const combined = desc && !desc.toLowerCase().startsWith(title.toLowerCase()) ? `${title}\n${desc}` : (desc || title);
      return {
        bodyAr: combined,
        bodyEn: combined,
      };
    })
    .filter(x => x.bodyEn && x.bodyEn.length >= 15);
}

async function fetchXAccount(handleOrUrl) {
  const clean = L.cleanXHandle(handleOrUrl);
  if (!clean) return [];
  const candidateUrls = /^https?:\/\//i.test(clean)
    ? [clean]
    : [
        `https://nitter.net/${encodeURIComponent(clean)}/rss`,
        `https://nitter.poast.org/${encodeURIComponent(clean)}/rss`,
      ];

  for (const u of candidateUrls) {
    try {
      const items = await fetchRssFeed(u);
      if (items.length) return items;
    } catch (_) {}
  }
  return [];
}

async function fetchCryptoMarketAlerts(template, targets) {
  const coins = [
    { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' },
    { id: 'ethereum', symbol: 'ETH', name: 'Ethereum' },
    { id: 'binancecoin', symbol: 'BNB', name: 'BNB' },
    { id: 'solana', symbol: 'SOL', name: 'Solana' },
    { id: 'the-open-network', symbol: 'TON', name: 'Toncoin' },
    { id: 'ripple', symbol: 'XRP', name: 'XRP' },
  ];

  const ids = coins.map(c => c.id).join(',');
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return 0;
  const data = await res.json();
  let published = 0;

  latestPrices = coins.map(c => {
    const row = data[c.id] || {};
    return {
      symbol: c.symbol,
      name: c.name,
      price: Number(row.usd || 0),
      change24h: Number(row.usd_24h_change || 0),
    };
  });

  for (const item of latestPrices) {
    if (!item.price || Math.abs(item.change24h) < priceThreshold) continue;
    const bucket = Math.floor(Date.now() / (4 * 3600 * 1000));
    const dir = item.change24h >= 0 ? 'up' : 'down';
    const h = L.newsHash(`price:${item.symbol}:${dir}:${bucket}`);
    const exists = await run('SELECT 1 FROM posted_items WHERE hash=?', [h]);
    if (exists.rows && exists.rows.length) continue;

    const msg = L.formatPriceAlert(item, template);
    for (const chatId of targets) {
      await bot.sendMessage(chatId, msg, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });
    }
    await run('INSERT OR IGNORE INTO posted_items(hash, source, title, posted_at) VALUES(?, ?, ?, ?)', [
      h,
      'market',
      item.symbol,
      Date.now(),
    ]);
    published++;
  }
  return published;
}

async function runNewsCycle(force = false) {
  if (!isRunning && !force) return { skipped: true, published: 0 };
  lastCycleAt = Date.now();
  lastError = null;

  try {
    const targets = await getActiveTargets();
    if (!targets.length) return { skipped: false, published: 0, reason: 'no_targets' };

    const template = await getTemplate();
    const srcRows = await run('SELECT type, value FROM sources WHERE active=1');
    const collected = [];

    for (const s of srcRows.rows || []) {
      try {
        if (s.type === 'tg_channel') {
          collected.push(...(await fetchTelegramChannel(s.value)));
        } else if (s.type === 'rss' || s.type === 'x_feed') {
          collected.push(...(await fetchRssFeed(s.value)));
        } else if (s.type === 'x_account') {
          collected.push(...(await fetchXAccount(s.value)));
        }
      } catch (e) {
        console.warn(`Source fetch error [${s.value}]:`, e.message);
      }
    }

    let published = 0;
    for (const item of collected) {
      const h = L.newsHash(`${item.bodyAr} ${item.bodyEn}`);
      const seen = await run('SELECT 1 FROM posted_items WHERE hash=?', [h]);
      if (seen.rows && seen.rows.length) continue;

      const formatted = L.formatCleanBilingualPost({ ...item, template });
      if (!L.stripLinksAndHandles(item.bodyEn || item.bodyAr)) continue;

      for (const chatId of targets) {
        await bot.sendMessage(chatId, formatted, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
      }
      await run('INSERT OR IGNORE INTO posted_items(hash, source, title, posted_at) VALUES(?, ?, ?, ?)', [
        h,
        'feed',
        (item.bodyEn || item.bodyAr).slice(0, 120),
        Date.now(),
      ]);
      published++;
      if (published >= 5) break;
    }

    published += await fetchCryptoMarketAlerts(template, targets);
    return { skipped: false, published };
  } catch (e) {
    lastError = e.message;
    console.error('News cycle error:', e);
    return { skipped: false, published: 0, error: e.message };
  }
}

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const pubIdx = path.join(__dirname, 'public', 'index.html');
  res.sendFile(fs.existsSync(pubIdx) ? pubIdx : path.join(__dirname, 'index.html'));
});

app.get('/api/state', async (req, res) => {
  const [sources, targets, postedCount, template] = await Promise.all([
    run('SELECT id, type, value, active FROM sources ORDER BY id ASC'),
    run('SELECT id, chat_id, active FROM targets ORDER BY id ASC'),
    run('SELECT COUNT(*) AS c FROM posted_items'),
    getTemplate(),
  ]);
  res.json({
    running: isRunning,
    lastCycleAt,
    lastError,
    publishedCount: Number((postedCount.rows && postedCount.rows[0] && postedCount.rows[0].c) || 0),
    template,
    sources: sources.rows || [],
    targets: targets.rows || [],
    prices: latestPrices,
  });
});

app.post('/api/toggle', async (req, res) => {
  await setEnabledState(Boolean(req.body && req.body.running));
  res.json({ ok: true, running: isRunning });
});

app.post('/api/template', async (req, res) => {
  const tpl = String((req.body && req.body.template) || '').trim();
  if (!tpl) return res.status(400).json({ error: 'empty_template' });
  await run("INSERT INTO settings(k, v) VALUES('template', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [tpl]);
  res.json({ ok: true, template: tpl });
});

app.post('/api/sources', async (req, res) => {
  const type = String((req.body && req.body.type) || 'tg_channel');
  const rawVal = String((req.body && req.body.value) || '').trim();
  const value = type === 'tg_channel' ? L.cleanChannelName(rawVal) : type === 'x_account' ? L.cleanXHandle(rawVal) : rawVal;
  if (!value) return res.status(400).json({ error: 'invalid_value' });
  await run('INSERT OR IGNORE INTO sources(type, value, active) VALUES(?, ?, 1)', [type, value]);
  res.json({ ok: true });
});

app.post('/api/targets', async (req, res) => {
  const chatId = L.cleanTargetChannel(req.body && req.body.chat_id);
  if (!chatId) return res.status(400).json({ error: 'invalid_target' });
  await run('INSERT OR IGNORE INTO targets(chat_id, active) VALUES(?, 1)', [chatId]);
  res.json({ ok: true, chat_id: chatId });
});

app.post('/api/fetch-now', async (req, res) => {
  const out = await runNewsCycle(true);
  res.json({ ok: true, ...out });
});

const isAdmin = msg => !ADMIN || String(msg.chat && msg.chat.id) === ADMIN || String(msg.from && msg.from.id) === ADMIN;

bot.onText(/^\/start(?:@\w+)?/, msg => {
  bot.sendMessage(
    msg.chat.id,
    '⚡ *عاجل — بوت الأخبار والأسواق*\n\n' +
      'الأوامر:\n' +
      '• `/on` — تشغيل النشر التلقائي\n' +
      '• `/off` — إيقاف النشر التلقائي\n' +
      '• `/addtarget @channel` — إضافة قناة للنشر\n' +
      '• `/addsource @channel_or_url` — إضافة مصدر جديد\n' +
      '• `/fetch` — جلب ونشر الآن\n' +
      '• `/status` — عرض الحالة',
    { parse_mode: 'Markdown' }
  ).catch(() => {});
});

bot.onText(/^\/on(?:@\w+)?$/, async msg => {
  if (!isAdmin(msg)) return;
  await setEnabledState(true);
  bot.sendMessage(msg.chat.id, '✅ تم تشغيل النشر التلقائي').catch(() => {});
});

bot.onText(/^\/off(?:@\w+)?$/, async msg => {
  if (!isAdmin(msg)) return;
  await setEnabledState(false);
  bot.sendMessage(msg.chat.id, '⏸️ تم إيقاف النشر التلقائي').catch(() => {});
});

bot.onText(/^\/addtarget(?:@\w+)?\s+(.+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const target = L.cleanTargetChannel(m[1]);
  if (!target) return bot.sendMessage(msg.chat.id, '❌ معرّف قناة غير صالح').catch(() => {});
  await run('INSERT OR IGNORE INTO targets(chat_id, active) VALUES(?, 1)', [target]);
  bot.sendMessage(msg.chat.id, `✅ تمت إضافة قناة النشر: ${target}`).catch(() => {});
});

bot.onText(/^\/addsource(?:@\w+)?\s+(.+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const raw = m[1].trim();
  const isUrl = /^https?:\/\//i.test(raw);
  const type = isUrl ? (/x\.com|twitter\.com|nitter/i.test(raw) ? 'x_feed' : 'rss') : 'tg_channel';
  const val = type === 'tg_channel' ? L.cleanChannelName(raw) : raw;
  if (!val) return bot.sendMessage(msg.chat.id, '❌ مصدر غير صالح').catch(() => {});
  await run('INSERT OR IGNORE INTO sources(type, value, active) VALUES(?, ?, 1)', [type, val]);
  bot.sendMessage(msg.chat.id, `✅ تمت إضافة المصدر (${type}): ${val}`).catch(() => {});
});

bot.onText(/^\/settemplate(?:@\w+)?\s+([\s\S]+)/, async (msg, m) => {
  if (!isAdmin(msg)) return;
  const tpl = m[1].trim();
  await run("INSERT INTO settings(k, v) VALUES('template', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [tpl]);
  bot.sendMessage(msg.chat.id, '✅ تم تحديث قالب النشر').catch(() => {});
});

bot.onText(/^\/fetch(?:@\w+)?$/, async msg => {
  if (!isAdmin(msg)) return;
  const r = await runNewsCycle(true);
  bot.sendMessage(msg.chat.id, `🔄 تم الفحص والنشر. عدد المنشورات الجديدة: ${r.published || 0}`).catch(() => {});
});

bot.onText(/^\/status(?:@\w+)?$/, async msg => {
  if (!isAdmin(msg)) return;
  const targets = await getActiveTargets();
  const srcs = await run('SELECT COUNT(*) AS c FROM sources WHERE active=1');
  bot.sendMessage(
    msg.chat.id,
    `📊 الحالة: ${isRunning ? 'شغال ✅' : 'متوقف ⏸️'}\n` +
      `📡 المصادر النشطة: ${(srcs.rows && srcs.rows[0] && srcs.rows[0].c) || 0}\n` +
      `📣 قنوات النشر: ${targets.join(', ') || 'لا يوجد'}`,
    { disable_web_page_preview: true }
  ).catch(() => {});
});

initDB()
  .then(() => {
    app.listen(PORT, () => console.log('News & Market Bot server running on port', PORT));
    setInterval(() => runNewsCycle(false), intervalMs);
    setTimeout(() => runNewsCycle(false), 4000);
  })
  .catch(err => {
    console.error('Init DB failed:', err);
    process.exit(1);
  });
