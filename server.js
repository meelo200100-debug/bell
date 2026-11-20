const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');
const TelegramBot = require('./telegram');
const { createCore } = require('./core');

const env = process.env;
const { BOT_TOKEN, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, DB_PATH = 'file:newsbot.db', PORT = 3000 } = env;
if (!BOT_TOKEN) { console.error('BOT_TOKEN is missing'); process.exit(1); }
const adminRaw = String(env.ADMIN_ID || env.ADMIN_CHAT_ID || '').trim();
if (!/^\d{5,20}$/.test(adminRaw)) {
  console.error('ADMIN_ID must be a valid numeric Telegram user ID (5-20 digits).');
  process.exit(1);
}

const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const num = (v, d, min) => Math.max(min, Number(v) || d);

const cfg = {
  botToken: BOT_TOKEN,
  adminId: adminRaw,
  webappUrl: env.WEBAPP_URL || '',
  targetChannels: list(env.TARGET_CHANNELS),
  xFeedUrls: list(env.X_FEED_URL),
  nitterHosts: list(env.NITTER_HOSTS).filter(h => /^https?:\/\//i.test(h)),
  translateUrl: env.LIBRETRANSLATE_URL || '',
  translateKey: env.LIBRETRANSLATE_KEY || '',
  adFilter: env.AD_FILTER !== '0',
  adExtra: list(env.AD_KEYWORDS_EXTRA),
  maxAgeMs: num(env.MAX_AGE_HOURS, 12, 1) * 3600 * 1000,
  maxPerCycle: num(env.MAX_PER_CYCLE, 5, 1),
  postDelayMs: num(env.POST_DELAY_MS, 5000, 0),
  bilingual: env.BILINGUAL === '1',
  priceThreshold: num(env.PRICE_THRESHOLD_PCT, 3, 0.5),
  priceCooldownMs: num(env.PRICE_COOLDOWN_HOURS, 4, 1) * 3600 * 1000,
  allowMissingDates: env.ALLOW_MISSING_DATES === '1',
  initMaxAgeSec: num(env.INIT_MAX_AGE_SEC, 600, 60),
};
const intervalMs = num(env.FETCH_INTERVAL_MS, 300000, 60000);

const db = createClient({
  url: TURSO_DATABASE_URL || (DB_PATH.startsWith('file:') ? DB_PATH : `file:${DB_PATH}`),
  authToken: TURSO_AUTH_TOKEN,
});
if (!TURSO_DATABASE_URL) console.warn('TURSO_DATABASE_URL is not set: data lives in a local file and is lost on redeploy.');

const bot = new TelegramBot(BOT_TOKEN);
bot.on('polling_error', e => console.error('polling_error', e.code || '', String(e.message || '').replace(/bot\d+:[A-Za-z0-9_-]+/gi, 'bot***')));
const core = createCore({ db, bot, cfg });

const app = express();
app.use(express.json({ limit: '50kb' }));
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const pub = path.join(__dirname, 'public', 'index.html');
  res.sendFile(fs.existsSync(pub) ? pub : path.join(__dirname, 'index.html'));
});

const ah = fn => (req, res) => fn(req, res).catch(e => { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'server' }); });
app.use('/api', core.adminAuth);
app.get('/api/state', ah(core.handlers.state));
app.post('/api/toggle', ah(core.handlers.toggle));
app.post('/api/template', ah(core.handlers.template));
app.post('/api/buttons', ah(core.handlers.buttons));
app.post('/api/sources', ah(core.handlers.sources));
app.delete('/api/sources/:id', ah(core.handlers.deleteSource));
app.post('/api/targets', ah(core.handlers.targets));
app.post('/api/fetch-now', ah(core.handlers.fetchNow));

process.on('unhandledRejection', e => console.error('unhandledRejection', e));

let server;
let cycleTimer;
core.initDB()
  .then(() => {
    core.registerCommands();
    bot.startPolling().catch(e => console.error('Polling start failed:', e));
    server = app.listen(PORT, () => console.log('News & Market Bot server running on port', PORT));
    cycleTimer = setInterval(() => core.runNewsCycle(false).catch(e => console.error(e)), intervalMs);
    setTimeout(() => core.runNewsCycle(false).catch(e => console.error(e)), 4000);
  })
  .catch(err => { console.error('Init DB failed:', err); process.exit(1); });

function shutdown(sig) {
  console.log(`Received ${sig}, shutting down...`);
  if (cycleTimer) clearInterval(cycleTimer);
  const stopPoll = bot.stopPolling ? bot.stopPolling().catch(() => {}) : Promise.resolve();
  const closeSrv = server ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
  Promise.all([stopPoll, closeSrv]).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
