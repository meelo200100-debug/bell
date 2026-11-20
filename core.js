// Bot logic (no network or database setup here, so it can be tested with fakes).
const L = require('./lib');
const { XMLParser } = require('fast-xml-parser');

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; CryptoNewsBot/1.0)' };
const DAY = 864e5;
const TELEGRAM_MAX = 4096;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  htmlEntities: true,
  trimValues: true,
  cdataPropName: '__cdata',
  isArray: (name) => ['item', 'entry', 'link'].includes(name),
});

function decodeHtml(str) {
  const cp = n => { try { return String.fromCodePoint(n); } catch (e) { return ''; } };
  const tags = /<\/?[a-z][^>]*>/gi;
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/\{\{TG[_]?EMOJI:(\d+)\|([\s\S]*?)\}\}/gi, (_, id, glyph) => `{{TG_EMOJI:${id}|${String(glyph).replace(/<[^>]*>/g, '')}}}`)
    .replace(/<tg-emoji\b[^>]*emoji-id=["'](\d+)["'][^>]*>([\s\S]*?)<\/tg-emoji>/gi, (_, id, glyph) => `{{TG_EMOJI:${id}|${String(glyph).replace(/<[^>]*>/g, '')}}}`)
    .replace(/<a\b[^>]*href=["']https?:\/\/[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(tags, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/"/g, '"')
    .replace(/'/g, "'")
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/&/g, '&')
    .replace(tags, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function telegramHtml(text) {
  let s = String(text || '');
  const custom = [];
  s = s.replace(/\{\{TG[_]?EMOJI:(\d+)\|([^}]+)\}\}/g, (_, id, glyph) => {
    const token = `__CUSTOM_EMOJI_${custom.length}__`;
    custom.push(`<tg-emoji emoji-id="${id}">${escapeHtml(glyph)}</tg-emoji>`);
    return token;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
  custom.forEach((html, i) => { s = s.replace(`__CUSTOM_EMOJI_${i}__`, html); });
  return s;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&','<':'<','>':'>','"':'"',"'":'&#39;'}[c]));
}

function tgError(e) {
  const body = e && e.response && e.response.body;
  let code = body && body.error_code;
  let desc = body && body.description;
  const retry = body && body.parameters && body.parameters.retry_after;
  if (!code) {
    const m = /ETELEGRAM:\s*(\d{3})\s*(.*)/.exec(String((e && e.message) || ''));
    if (m) { code = Number(m[1]); desc = desc || m[2]; }
  }
  return { code, desc: desc || String((e && e.message) || ''), retry };
}

function safeTruncateForTelegram(htmlOrText, max = TELEGRAM_MAX - 100) {
  const cps = [...String(htmlOrText || '')];
  if (cps.length <= max) return cps.join('');
  let cut = cps.slice(0, max).join('');
  const sp = cut.lastIndexOf(' ');
  cut = (sp > max * 0.7 ? cut.slice(0, sp) : cut).trimEnd();
  // avoid breaking tags roughly
  cut = cut.replace(/<[^>]*$/, '').replace(/&[^;]*$/, '');
  return cut + '…';
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length).fill(null).map(() => []);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      try { out[k] = await fn(items[k]); } catch (e) { out[k] = []; console.warn(`Source error [${items[k].value}]:`, String(e.message || '').slice(0, 120)); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function createCore({ db, bot, cfg, fetchFn = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now }) {
  let isRunning = true, lastCycleAt = null, lastError = null, latestPrices = [], cycleRunning = false;
  const lockOwner = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const run = (sql, args = []) => db.execute({ sql, args });
  const first = r => (r.rows && r.rows[0]) || null;
  const rate = new Map(); // simple admin rate limit

  async function initDB() {
    await run('CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)');
    await run(`CREATE TABLE IF NOT EXISTS sources(
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, value TEXT NOT NULL UNIQUE, active INTEGER DEFAULT 1)`);
    await run(`CREATE TABLE IF NOT EXISTS targets(
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL UNIQUE, active INTEGER DEFAULT 1)`);
    await run('CREATE TABLE IF NOT EXISTS posted_items(hash TEXT PRIMARY KEY, source TEXT, title TEXT, posted_at INTEGER)');
    await run('CREATE TABLE IF NOT EXISTS failed_items(hash TEXT PRIMARY KEY, retry_after INTEGER, reason TEXT)');
    await run('CREATE TABLE IF NOT EXISTS cycle_locks(name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    await run('CREATE TABLE IF NOT EXISTS custom_emoji_packs(name TEXT PRIMARY KEY, url TEXT NOT NULL, synced_at INTEGER, count INTEGER DEFAULT 0)');
    await run('CREATE TABLE IF NOT EXISTS custom_emojis(custom_emoji_id TEXT PRIMARY KEY, pack_name TEXT NOT NULL, glyph TEXT, file_id TEXT)');

    // New tables (migration-safe: IF NOT EXISTS, no data loss)
    await run(`CREATE TABLE IF NOT EXISTS news_items(
      hash TEXT PRIMARY KEY, text TEXT NOT NULL, source TEXT, source_title TEXT, ts INTEGER, created_at INTEGER
    )`);
    await run(`CREATE TABLE IF NOT EXISTS news_deliveries(
      hash TEXT NOT NULL, chat_id TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER DEFAULT 0, last_attempt INTEGER, next_retry INTEGER,
      error TEXT, message_id INTEGER,
      PRIMARY KEY (hash, chat_id)
    )`);
    await run(`CREATE TABLE IF NOT EXISTS price_alert_state(
      symbol TEXT PRIMARY KEY, direction TEXT, last_alert_at INTEGER, last_price REAL, last_change REAL
    )`);

    const en = first(await run("SELECT v FROM settings WHERE k='enabled'"));
    if (!en) await run("INSERT INTO settings(k, v) VALUES('enabled', '1')");
    else isRunning = en.v !== '0';

    await run("INSERT OR IGNORE INTO settings(k, v) VALUES('template', ?)", [L.DEFAULT_TEMPLATE]);
    await run("INSERT OR IGNORE INTO settings(k, v) VALUES('buttons', ?)", [JSON.stringify(L.DEFAULT_BUTTONS)]);
    syncCustomEmojiPacks().catch(e => console.warn('Custom emoji sync failed:', e.message));

    for (const ch of L.DEFAULT_CHANNELS) await run("INSERT OR IGNORE INTO sources(type, value, active) VALUES('tg_channel', ?, 1)", [ch]);
    for (const feed of L.DEFAULT_RSS_FEEDS) await run("INSERT OR IGNORE INTO sources(type, value, active) VALUES('rss', ?, 1)", [feed]);
    if (cfg.nitterHosts.length) {
      for (const h of L.DEFAULT_X_HANDLES) await run("INSERT OR IGNORE INTO sources(type, value, active) VALUES('x_account', ?, 1)", [h]);
    }
    for (const u of cfg.xFeedUrls) {
      const url = L.cleanFeedUrl(u);
      if (url) await run("INSERT OR IGNORE INTO sources(type, value, active) VALUES('x_feed', ?, 1)", [url]);
    }
    for (const raw of ['@Alkatiba21', ...cfg.targetChannels]) {
      const t = L.cleanTargetChannel(raw);
      if (t) await run('INSERT OR IGNORE INTO targets(chat_id, active) VALUES(?, 1)', [t]);
    }
  }

  async function getTemplate() {
    const r = first(await run("SELECT v FROM settings WHERE k='template'"));
    return (r && r.v) || L.DEFAULT_TEMPLATE;
  }
  async function getButtons() {
    const r = first(await run("SELECT v FROM settings WHERE k='buttons'"));
    try {
      const buttons = JSON.parse((r && r.v) || '[]');
      return Array.isArray(buttons) && buttons.length === 4 ? buttons : L.DEFAULT_BUTTONS;
    } catch (_) { return L.DEFAULT_BUTTONS; }
  }

  function emojiPackName(url) {
    try { return new URL(url).pathname.split('/').filter(Boolean).pop() || ''; } catch (_) { return ''; }
  }

  async function syncCustomEmojiPacks() {
    for (const url of L.DEFAULT_CUSTOM_EMOJI_PACKS) {
      const name = emojiPackName(url);
      if (!name) continue;
      await run('INSERT OR IGNORE INTO custom_emoji_packs(name, url, synced_at, count) VALUES(?, ?, NULL, 0)', [name, url]);
      if (!bot || typeof bot.call !== 'function') continue;
      try {
        const set = await bot.call('getStickerSet', { name }, 15000);
        const stickers = Array.isArray(set && set.stickers) ? set.stickers : [];
        for (const sticker of stickers) {
          if (!sticker.custom_emoji_id) continue;
          await run('INSERT INTO custom_emojis(custom_emoji_id, pack_name, glyph, file_id) VALUES(?, ?, ?, ?) ON CONFLICT(custom_emoji_id) DO UPDATE SET pack_name=excluded.pack_name, glyph=excluded.glyph, file_id=excluded.file_id', [String(sticker.custom_emoji_id), name, String(sticker.emoji || ''), String(sticker.file_id || '')]);
        }
        await run('UPDATE custom_emoji_packs SET synced_at=?, count=? WHERE name=?', [now(), stickers.filter(s => s.custom_emoji_id).length, name]);
      } catch (e) {
        console.warn(`Custom emoji pack sync failed [${name}]:`, e.message);
      }
    }
  }
  async function setEnabledState(val) {
    isRunning = !!val;
    await run("INSERT INTO settings(k, v) VALUES('enabled', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [isRunning ? '1' : '0']);
  }
  async function getActiveTargets() {
    const r = await run('SELECT chat_id FROM targets WHERE active=1 ORDER BY id ASC');
    return (r.rows || []).map(x => String(x.chat_id));
  }

  // ---------- fetching ----------
  async function fetchTelegramChannel(username) {
    const res = await fetchFn(`https://t.me/s/${encodeURIComponent(username)}`, { headers: UA, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const html = await res.text();
    const titleMatch = /class="tgme_channel_info_header_title[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
    const channelTitle = titleMatch ? decodeHtml(titleMatch[1]) : '';
    return html.split('data-post="').slice(1).slice(-30).map(block => {
      const m = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);
      if (!m) return null;
      const authorMatch = /class="tgme_widget_message_author_name[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block);
      const authorName = authorMatch ? decodeHtml(authorMatch[1]) : channelTitle;
      const t = /<time[^>]*datetime="([^"]+)"/.exec(block);
      let cleaned = L.stripLinksAndHandles(decodeHtml(m[1]), username);
      if (authorName) cleaned = L.stripLinksAndHandles(cleaned, authorName);
      if (channelTitle && channelTitle !== authorName) cleaned = L.stripLinksAndHandles(cleaned, channelTitle);
      return { text: cleaned, ts: t ? L.parseDate(t[1]) : null, source: username, sourceTitle: authorName || channelTitle || username };
    }).filter(x => x && x.text.length >= 20);
  }

  function extractText(node) {
    if (!node) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (node.__cdata) return String(node.__cdata);
    if (node['#text']) return String(node['#text']);
    return '';
  }

  function extractLink(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) {
      const alt = node.find(l => l && l['@_rel'] === 'alternate') || node[0];
      return alt && (alt['@_href'] || extractText(alt)) || '';
    }
    return node['@_href'] || extractText(node) || '';
  }

  async function fetchRssFeed(feedUrl) {
    if (!L.isSafeRemoteUrl(feedUrl)) return [];
    let res;
    try {
      res = await (L.safeFetch ? L.safeFetch(feedUrl, { headers: UA, timeoutMs: 12000 }, fetchFn) : fetchFn(feedUrl, { headers: UA, signal: AbortSignal.timeout(10000) }));
    } catch (e) {
      console.warn(`RSS fetch skipped [${feedUrl}]:`, String(e.message || '').slice(0, 80));
      return [];
    }
    if (!res.ok) return [];
    const xml = await res.text();
    if (xml.length > 2_000_000) {
      console.warn(`RSS too large [${feedUrl}]`);
      return [];
    }
    let parsed;
    try { parsed = xmlParser.parse(xml); } catch (e) {
      console.warn(`RSS parse failed [${feedUrl}]:`, e.message);
      return [];
    }
    const channel = parsed.rss && parsed.rss.channel ? parsed.rss.channel : (parsed.feed || {});
    const feedTitle = decodeHtml(extractText(channel.title) || '').split(/[\|\-–—]/)[0].trim();
    const rawItems = Array.isArray(channel.item) ? channel.item : (Array.isArray(channel.entry) ? channel.entry : []);
    return rawItems.slice(0, 12).map(item => {
      const title = L.stripLinksAndHandles(decodeHtml(extractText(item.title)), feedUrl);
      let desc = extractText(item['content:encoded']) || extractText(item.description) || extractText(item.summary) || extractText(item.content) || '';
      desc = L.stripLinksAndHandles(decodeHtml(desc), feedUrl);
      if (feedTitle && feedTitle.length >= 3) {
        // title/desc already stripped of clear attributions
      }
      const text = desc && !desc.toLowerCase().startsWith(title.toLowerCase()) ? `${title}\n${desc}` : (desc || title);
      const dateRaw = extractText(item.pubDate) || extractText(item.published) || extractText(item.updated) || extractText(item['dc:date']) || '';
      const ts = L.parseDate(decodeHtml(dateRaw));
      return { text, ts, source: feedUrl, sourceTitle: feedTitle || feedUrl, dateRaw };
    }).filter(x => x.text && x.text.length >= 15);
  }

  async function fetchXAccount(handleOrUrl) {
    if (/^https?:\/\//i.test(handleOrUrl)) return fetchRssFeed(handleOrUrl);
    if (!cfg.nitterHosts.length) return [];
    for (const host of cfg.nitterHosts) {
      try {
        const items = await fetchRssFeed(`${host.replace(/\/$/, '')}/${encodeURIComponent(handleOrUrl)}/rss`);
        if (items.length) return items;
      } catch (_) {}
    }
    return [];
  }

  const fetchSource = s => (
    s.type === 'tg_channel' ? fetchTelegramChannel(s.value)
      : s.type === 'rss' || s.type === 'x_feed' ? fetchRssFeed(s.value)
        : s.type === 'x_account' ? fetchXAccount(s.value) : Promise.resolve([])
  );

  async function translateChunk(text) {
    const cleanInput = String(text || '').trim();
    if (!cleanInput) return null;
    if (cfg.translateUrl && L.isSafeRemoteUrl(cfg.translateUrl)) {
      try {
        const r = await fetchFn(`${cfg.translateUrl.replace(/\/$/, '')}/translate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ q: cleanInput, source: 'auto', target: 'ar', format: 'text', ...(cfg.translateKey ? { api_key: cfg.translateKey } : {}) }),
        });
        if (r.ok) {
          const j = await r.json();
          if (typeof j.translatedText === 'string' && j.translatedText.trim()) return L.polishArabicTranslation(j.translatedText);
        }
      } catch (e) { console.warn('LibreTranslate error:', String(e.message || '').slice(0, 80)); }
    }
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ar&dt=t&q=${encodeURIComponent(cleanInput)}`;
      const r = await fetchFn(url, { headers: UA, signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data && data[0])) {
          const translated = data[0].map(seg => (seg && seg[0]) || '').join('').trim();
          if (translated && L.isArabic(translated)) return L.polishArabicTranslation(translated);
        }
      }
    } catch (e) { console.warn('GTX translate error:', String(e.message || '').slice(0, 80)); }
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(cleanInput.slice(0, 450))}&langpair=en|ar`;
      const r = await fetchFn(url, { headers: UA, signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const j = await r.json();
        const translated = j && j.responseData && j.responseData.translatedText;
        if (typeof translated === 'string' && translated.trim() && L.isArabic(translated)) return L.polishArabicTranslation(translated);
      }
    } catch (e) { console.warn('MyMemory error:', String(e.message || '').slice(0, 80)); }
    return null;
  }

  async function translateToArabic(text) {
    const parts = L.splitForTranslation(text, 400);
    const out = [];
    for (const part of parts) {
      let tr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        tr = await translateChunk(part);
        if (tr) break;
        await sleep(400);
      }
      if (!tr) return null; // incomplete -> fail the whole translation
      out.push(tr);
    }
    const joined = out.join('\n').trim();
    return joined && L.isArabic(joined) ? joined : null;
  }

  // ---------- sending ----------
  const SHARE_EVENT_LABEL = 'مشاركة الخبر 🔴';

  function messageLink(chatId, messageId) {
    const id = String(chatId || '');
    if (id.startsWith('@')) return `https://t.me/${id.slice(1)}/${messageId}`;
    if (/^-100\d+$/.test(id)) return `https://t.me/c/${id.slice(4)}/${messageId}`;
    return '';
  }

  async function sendSafe(chatId, text, buttons = []) {
    let plain = false, waited = false;
    const prepared = safeTruncateForTelegram(text, 3800);
    for (let i = 0; i < 3; i++) {
      try {
        const options = plain ? { disable_web_page_preview: true } : { parse_mode: 'HTML', disable_web_page_preview: true };
        if (buttons.length === 4) options.reply_markup = { inline_keyboard: [buttons.slice(0, 2), buttons.slice(2, 4)] };
        const payloadText = plain ? prepared.replace(/\{\{TG[_]?EMOJI:\d+\|([^}]+)\}\}/g, '$1').replace(/<[^>]*>/g, '') : telegramHtml(prepared);
        if ([...payloadText].length > TELEGRAM_MAX) throw Object.assign(new Error('too long'), { response: { body: { error_code: 400, description: 'message too long' } } });
        const message = await bot.sendMessage(chatId, payloadText, options);
        const shareUrl = message && messageLink(chatId, message.message_id);
        if (shareUrl && typeof bot.call === 'function' && options.reply_markup) {
          const shareButton = { text: SHARE_EVENT_LABEL, url: `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}` };
          try {
            await bot.call('editMessageReplyMarkup', {
              chat_id: chatId,
              message_id: message.message_id,
              reply_markup: { inline_keyboard: [...options.reply_markup.inline_keyboard, [shareButton]] },
            }, 15000);
          } catch (e) {
            console.warn('Could not add event share button:', e.message);
          }
        }
        return { ok: true, messageId: message && message.message_id };
      } catch (e) {
        const { code, desc, retry } = tgError(e);
        if (code === 429 && !waited) {
          waited = true;
          const waitSec = Math.min(60, Number(retry) || 5);
          await sleep(waitSec * 1000);
          continue;
        }
        if (code === 400 && /parse entities|too long|message is too long/i.test(desc) && !plain) { plain = true; continue; }
        const permanent = code === 400 || code === 403 || code === 404;
        return { ok: false, permanent, retryAfter: retry, error: desc };
      }
    }
    return { ok: false, permanent: false, error: 'retries exhausted' };
  }

  async function deliverToTargets(hash, text, targets, buttons) {
    const results = [];
    for (const chatId of targets) {
      const existing = first(await run('SELECT status FROM news_deliveries WHERE hash=? AND chat_id=?', [hash, chatId]));
      if (existing && existing.status === 'success') {
        results.push({ chatId, ok: true, skipped: true });
        continue;
      }
      const r = await sendSafe(chatId, text, buttons);
      const attempts = (existing ? Number(existing.attempts || 0) : 0) + 1;
      if (r.ok) {
        await run(`INSERT INTO news_deliveries(hash, chat_id, status, attempts, last_attempt, next_retry, error, message_id)
          VALUES(?, ?, 'success', ?, ?, NULL, NULL, ?)
          ON CONFLICT(hash, chat_id) DO UPDATE SET status='success', attempts=excluded.attempts, last_attempt=excluded.last_attempt, next_retry=NULL, error=NULL, message_id=excluded.message_id`,
          [hash, chatId, attempts, now(), r.messageId || null]);
        results.push({ chatId, ok: true });
      } else {
        const permanent = !!r.permanent;
        const backoff = r.retryAfter ? Math.min(3600, Number(r.retryAfter) * 1000) : Math.min(6 * 3600 * 1000, 30000 * Math.pow(2, Math.min(attempts, 6)));
        const next = permanent ? null : now() + backoff;
        const status = permanent ? 'permanent_fail' : 'failed';
        await run(`INSERT INTO news_deliveries(hash, chat_id, status, attempts, last_attempt, next_retry, error, message_id)
          VALUES(?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(hash, chat_id) DO UPDATE SET status=excluded.status, attempts=excluded.attempts, last_attempt=excluded.last_attempt, next_retry=excluded.next_retry, error=excluded.error`,
          [hash, chatId, status, attempts, now(), next, String(r.error || '').slice(0, 200)]);
        results.push({ chatId, ok: false, permanent, error: r.error });
        console.error('Send failed', chatId, ':', String(r.error || '').slice(0, 100));
      }
    }
    const allDone = results.every(r => r.ok || r.permanent);
    const anyOk = results.some(r => r.ok);
    return { results, allDone, anyOk, error: results.find(r => !r.ok)?.error || '' };
  }

  // ---------- price alerts ----------
  const COINS = [
    { id: 'bitcoin', symbol: 'BTC', name: 'البيتكوين' },
    { id: 'ethereum', symbol: 'ETH', name: 'الإيثيريوم' },
    { id: 'binancecoin', symbol: 'BNB', name: 'باينانس كوين' },
    { id: 'solana', symbol: 'SOL', name: 'سولانا' },
    { id: 'the-open-network', symbol: 'TON', name: 'تونكوين' },
    { id: 'ripple', symbol: 'XRP', name: 'ريبل' },
  ];
  async function fetchCryptoMarketAlerts(template, targets, buttons) {
    const ids = COINS.map(c => c.id).join(',');
    let res;
    try {
      res = await fetchFn(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
        { signal: AbortSignal.timeout(10000) });
    } catch (e) { console.warn('Price API error:', e.message); return 0; }
    if (!res.ok) { console.warn('Price API status', res.status); return 0; }
    const data = await res.json();
    latestPrices = COINS.map(c => {
      const row = data[c.id] || {};
      const price = Number(row.usd);
      const change = Number(row.usd_24h_change);
      return { symbol: c.symbol, name: c.name, price: Number.isFinite(price) && price > 0 ? price : null, change24h: Number.isFinite(change) ? change : null };
    });
    let published = 0;
    const cooldownMs = Math.max(3600000, Number(cfg.priceCooldownMs || 4 * 3600 * 1000));
    const postDelayMs = Math.max(0, Number(cfg.postDelayMs ?? 5000));
    for (const item of latestPrices) {
      if (!item.price || item.change24h == null || Math.abs(item.change24h) < cfg.priceThreshold) continue;
      const direction = item.change24h >= 0 ? 'up' : 'down';
      const prev = first(await run('SELECT direction, last_alert_at FROM price_alert_state WHERE symbol=?', [item.symbol]));
      if (prev && prev.direction === direction && (now() - Number(prev.last_alert_at || 0)) < cooldownMs) continue;
      if (published > 0 && postDelayMs > 0) await sleep(postDelayMs);
      const alertText = L.formatPriceAlert(item, template);
      if (!alertText) continue;
      const h = L.newsHash(`price:${item.symbol}:${direction}:${Math.floor(now() / cooldownMs)}`);
      const r = await deliverToTargets(h, alertText, targets, buttons);
      if (r.anyOk) {
        await run(`INSERT INTO price_alert_state(symbol, direction, last_alert_at, last_price, last_change)
          VALUES(?, ?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET direction=excluded.direction, last_alert_at=excluded.last_alert_at, last_price=excluded.last_price, last_change=excluded.last_change`,
          [item.symbol, direction, now(), item.price, item.change24h]);
        published++;
      }
    }
    return published;
  }

  // ---------- main cycle ----------
  async function acquireCycleLock() {
    const expires = now() + 30 * 60 * 1000;
    const result = await run(`INSERT INTO cycle_locks(name, owner, expires_at) VALUES('news', ?, ?)
      ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
      WHERE cycle_locks.expires_at < ?`, [lockOwner, expires, now()]);
    return Number(result.rowsAffected || 0) > 0;
  }

  async function renewCycleLock() {
    await run('UPDATE cycle_locks SET expires_at=? WHERE name=? AND owner=?', [now() + 30 * 60 * 1000, 'news', lockOwner]);
  }

  async function releaseCycleLock() {
    await run('DELETE FROM cycle_locks WHERE name=? AND owner=?', ['news', lockOwner]);
  }

  async function runNewsCycle(force = false) {
    if (!isRunning && !force) return { skipped: true, published: 0 };
    if (cycleRunning) return { skipped: true, busy: true, published: 0 };
    if (!await acquireCycleLock()) return { skipped: true, busy: true, published: 0 };
    cycleRunning = true; lastCycleAt = now(); lastError = null;
    const renewTimer = setInterval(() => renewCycleLock().catch(() => {}), 5 * 60 * 1000);
    try {
      const targets = await getActiveTargets();
      if (!targets.length) return { skipped: false, published: 0, reason: 'no_targets' };
      const template = await getTemplate();
      const buttons = await getButtons();

      const srcRows = (await run('SELECT type, value FROM sources WHERE active=1')).rows || [];
      const collected = (await mapLimit(srcRows, 6, fetchSource)).flat();

      const cutoff = now() - cfg.maxAgeMs;
      let items = [];
      for (const i of collected) {
        if (!i || !i.text || !L.hasContent(i.text)) continue;
        if (i.ts == null) {
          if (cfg.allowMissingDates) {
            console.warn(`Missing date allowed for ${i.source}`);
            items.push({ ...i, ts: null });
          } else {
            console.warn(`Skipping item with missing/invalid date from ${i.source}`);
            continue;
          }
        } else if (i.ts < cutoff) {
          continue; // too old
        } else {
          items.push(i);
        }
      }
      if (cfg.adFilter) items = items.filter(i => !L.isPromo(i.text, cfg.adExtra));
      items = items.sort((a, b) => (b.ts || 0) - (a.ts || 0));

      const picked = [], inBatch = new Set(), pickedTexts = [];
      const postedRows = (await run('SELECT title FROM posted_items WHERE posted_at >= ?', [now() - 30 * DAY])).rows || [];
      const postedTexts = postedRows.map(row => String(row.title || '')).filter(Boolean);
      for (const it of items) {
        if (picked.length >= cfg.maxPerCycle) break;
        const h = L.newsHash(it.text);
        if (inBatch.has(h)) continue;
        inBatch.add(h);
        if (first(await run('SELECT 1 FROM posted_items WHERE hash=?', [h]))) continue; // already fully handled historically
        const failed = first(await run('SELECT retry_after FROM failed_items WHERE hash=?', [h]));
        if (failed && Number(failed.retry_after) > now()) continue;
        if (postedTexts.some(previous => L.areSimilarNews(it.text, previous)) || pickedTexts.some(previous => L.areSimilarNews(it.text, previous))) continue;
        picked.push({ ...it, h });
        pickedTexts.push(it.text);
      }
      // also pick pending deliveries that need retry
      const pending = (await run(`SELECT DISTINCT d.hash FROM news_deliveries d
        JOIN news_items n ON n.hash = d.hash
        WHERE d.status='failed' AND (d.next_retry IS NULL OR d.next_retry <= ?)
        LIMIT 10`, [now()])).rows || [];
      for (const row of pending) {
        if (picked.some(p => p.h === row.hash)) continue;
        const ni = first(await run('SELECT text, source, source_title, ts FROM news_items WHERE hash=?', [row.hash]));
        if (ni) picked.push({ text: ni.text, source: ni.source, sourceTitle: ni.source_title, ts: ni.ts, h: row.hash, isRetry: true });
      }
      picked.reverse();

      let published = 0;
      const postDelayMs = Math.max(0, Number(cfg.postDelayMs ?? 5000));
      for (let idx = 0; idx < picked.length; idx++) {
        if (idx > 0 && postDelayMs > 0) await sleep(postDelayMs);
        const it = picked[idx];
        await run(`INSERT INTO news_items(hash, text, source, source_title, ts, created_at) VALUES(?, ?, ?, ?, ?, ?)
          ON CONFLICT(hash) DO NOTHING`, [it.h, it.text, it.source || '', it.sourceTitle || '', it.ts || null, now()]);

        const translated = await translateToArabic(it.text);
        const ar = translated && L.isArabic(translated) ? translated : (L.isArabic(it.text) ? it.text : null);
        if (!ar) {
          lastError = `تعذرت ترجمة الخبر إلى العربية؛ سيتم إعادة المحاولة: ${String(it.sourceTitle || it.source || 'مصدر غير معروف')}`;
          console.warn(lastError);
          await run('INSERT INTO failed_items(hash, retry_after, reason) VALUES(?, ?, ?) ON CONFLICT(hash) DO UPDATE SET retry_after=excluded.retry_after, reason=excluded.reason', [it.h, now() + 2 * 3600 * 1000, 'translation_failed']);
          continue;
        }
        await run('DELETE FROM failed_items WHERE hash=?', [it.h]);
        const postText = L.formatCleanBilingualPost({ bodyAr: ar, bodyEn: '', template, sourceName: it.sourceTitle || it.source || '', bilingual: false });
        const r = await deliverToTargets(it.h, postText, targets, buttons);
        if (r.allDone) {
          await run('INSERT OR IGNORE INTO posted_items(hash, source, title, posted_at) VALUES(?, ?, ?, ?)', [it.h, it.source || 'feed', it.text.slice(0, 120), now()]);
        }
        if (r.anyOk) published++;
        else lastError = `Could not post to any channel: ${r.error}`;
      }

      try { published += await fetchCryptoMarketAlerts(template, targets, buttons); }
      catch (e) { console.warn('Market alerts failed:', e.message); }

      await run('DELETE FROM posted_items WHERE posted_at < ?', [now() - 30 * DAY]);
      await run('DELETE FROM failed_items WHERE retry_after < ?', [now() - 7 * DAY]);
      return { skipped: false, published };
    } catch (e) {
      lastError = e.message;
      console.error('News cycle error:', e);
      return { skipped: false, published: 0, error: e.message };
    } finally {
      clearInterval(renewTimer);
      cycleRunning = false;
      await releaseCycleLock().catch(e => console.warn('Cycle lock release failed:', e.message));
    }
  }

  // ---------- admin API ----------
  function adminAuth(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = ip + ':' + (req.path || '');
    const nowMs = Date.now();
    const arr = (rate.get(key) || []).filter(t => nowMs - t < 60000);
    if (arr.length >= 40) return res.status(429).json({ error: 'rate_limited' });
    arr.push(nowMs);
    rate.set(key, arr);
    const v = L.verifyInitData(req.get('x-init') || '', cfg.botToken, cfg.initMaxAgeSec);
    if (!v) return res.status(401).json({ error: 'unauthorized' });
    if (String(v.user.id) !== cfg.adminId) return res.status(403).json({ error: 'forbidden' });
    next();
  }

  function parseSource(type, raw) {
    if (type === 'tg_channel') return L.cleanChannelName(raw);
    if (type === 'x_account') return L.cleanXHandle(raw);
    if (type === 'rss' || type === 'x_feed') return L.cleanFeedUrl(raw);
    return null;
  }

  const handlers = {
    state: async (req, res) => {
      const [sources, targets, posted, template, buttons, emojiPacks] = await Promise.all([
        run('SELECT id, type, value, active FROM sources ORDER BY id ASC'),
        run('SELECT id, chat_id, active FROM targets ORDER BY id ASC'),
        run('SELECT COUNT(*) AS c FROM posted_items'),
        getTemplate(),
        getButtons(),
        run('SELECT name, url, synced_at, count FROM custom_emoji_packs ORDER BY name'),
      ]);
      res.json({
        running: isRunning, busy: cycleRunning, lastCycleAt, lastError,
        publishedCount: Number((first(posted) || {}).c || 0), template,
        sources: sources.rows || [], targets: targets.rows || [], prices: latestPrices, buttons,
        emojiPacks: emojiPacks.rows || [],
        xEnabled: cfg.nitterHosts.length > 0, translateEnabled: true, adFilter: cfg.adFilter,
      });
    },
    toggle: async (req, res) => { await setEnabledState(Boolean(req.body && req.body.running)); res.json({ ok: true, running: isRunning }); },
    template: async (req, res) => {
      const tpl = String((req.body && req.body.template) || '').trim();
      if (!tpl) return res.status(400).json({ error: 'empty_template' });
      if (tpl.length > 3000) return res.status(400).json({ error: 'template_too_long' });
      await run("INSERT INTO settings(k, v) VALUES('template', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [tpl]);
      res.json({ ok: true, template: tpl });
    },
    buttons: async (req, res) => {
      const raw = req.body && req.body.buttons;
      if (!Array.isArray(raw) || raw.length !== 4) return res.status(400).json({ error: 'buttons_must_be_four' });
      const buttons = raw.map(item => ({
        text: String(item && item.text || '').trim(),
        url: String(item && item.url || '').trim(),
      }));
      if (buttons.some(b => !b.text || b.text.length > 40 || b.url.length > 2048 || !L.isSafeRemoteUrl(b.url))) {
        return res.status(400).json({ error: 'invalid_button' });
      }
      await run("INSERT INTO settings(k, v) VALUES('buttons', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [JSON.stringify(buttons)]);
      res.json({ ok: true, buttons });
    },
    sources: async (req, res) => {
      const type = String((req.body && req.body.type) || 'tg_channel');
      const value = parseSource(type, String((req.body && req.body.value) || ''));
      if (value === null) return res.status(400).json({ error: 'invalid_type' });
      if (!value) return res.status(400).json({ error: 'invalid_value' });
      await run('INSERT OR IGNORE INTO sources(type, value, active) VALUES(?, ?, 1)', [type, value]);
      res.json({ ok: true });
    },
    deleteSource: async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_value' });
      const result = await run('DELETE FROM sources WHERE id=?', [id]);
      res.json({ ok: true, deleted: Number(result.rowsAffected || 0) });
    },
    targets: async (req, res) => {
      const chatId = L.cleanTargetChannel(req.body && req.body.chat_id);
      if (!chatId) return res.status(400).json({ error: 'invalid_target' });
      await run('INSERT OR IGNORE INTO targets(chat_id, active) VALUES(?, 1)', [chatId]);
      res.json({ ok: true, chat_id: chatId });
    },
    fetchNow: async (req, res) => res.json({ ok: true, ...(await runNewsCycle(true)) }),
  };

  // ---------- bot commands (admin only) ----------
  const isAdmin = msg => String(msg.from && msg.from.id) === cfg.adminId;
  const say = (chatId, text, opts) => bot.sendMessage(chatId, text, opts).catch(() => {});
  const safe = fn => (msg, m) => Promise.resolve().then(() => fn(msg, m)).catch(e => console.error('Command error:', e));

  function registerCommands() {
    bot.on('message', safe(async msg => {
      if (!isAdmin(msg)) return;
      const text = String(msg.text || msg.caption || '');
      const entities = msg.entities || msg.caption_entities || [];
      const custom = entities.filter(e => e.type === 'custom_emoji' && e.custom_emoji_id);
      if (!custom.length) return;
      const tokens = custom.map(e => {
        const glyph = text.substring(e.offset, e.offset + e.length) || '⭐';
        return `{{TG_EMOJI:${e.custom_emoji_id}|${glyph}}}`;
      });
      await say(msg.chat.id, '✅ انسخ الكود التالي وضعه في قالب النشر:\n' + tokens.join('\n'));
    }));
    bot.onText(/^\/start(?:@\w+)?/, safe(async msg => {
      if (!isAdmin(msg)) return say(msg.chat.id, '⚡ بوت أخبار الكتيبة. هذا البوت خاص بالإدارة.');
      await say(msg.chat.id,
        '⚡ *عاجل — بوت الأخبار والأسواق*\n\nالأوامر:\n' +
        '• `/panel` — لوحة التحكم\n• `/on` — تشغيل النشر التلقائي\n• `/off` — إيقاف النشر التلقائي\n' +
        '• `/addtarget @channel` — إضافة قناة للنشر\n• `/addsource @channel_or_url` — إضافة مصدر جديد\n' +
        '• `/fetch` — جلب ونشر الآن\n• `/status` — عرض الحالة', { parse_mode: 'Markdown' });
    }));
    bot.onText(/^\/panel(?:@\w+)?$/, safe(async msg => {
      if (!isAdmin(msg)) return;
      if (msg.chat.type !== 'private') return say(msg.chat.id, '❌ افتح /panel في محادثة خاصة مع البوت.');
      if (!/^https:\/\//i.test(cfg.webappUrl || '')) return say(msg.chat.id, '❌ اضبط WEBAPP_URL (رابط https للخدمة) في إعدادات الاستضافة.');
      await say(msg.chat.id, '🎛 لوحة التحكم', { reply_markup: { inline_keyboard: [[{ text: 'فتح اللوحة', web_app: { url: cfg.webappUrl } }]] } });
    }));
    bot.onText(/^\/on(?:@\w+)?$/, safe(async msg => {
      if (!isAdmin(msg)) return; await setEnabledState(true); await say(msg.chat.id, '✅ تم تشغيل النشر التلقائي');
    }));
    bot.onText(/^\/off(?:@\w+)?$/, safe(async msg => {
      if (!isAdmin(msg)) return; await setEnabledState(false); await say(msg.chat.id, '⏸️ تم إيقاف النشر التلقائي');
    }));
    bot.onText(/^\/addtarget(?:@\w+)?\s+(.+)/, safe(async (msg, m) => {
      if (!isAdmin(msg)) return;
      const target = L.cleanTargetChannel(m[1]);
      if (!target) return say(msg.chat.id, '❌ معرّف قناة غير صالح');
      await run('INSERT OR IGNORE INTO targets(chat_id, active) VALUES(?, 1)', [target]);
      await say(msg.chat.id, `✅ تمت إضافة قناة النشر: ${target}`);
    }));
    bot.onText(/^\/addsource(?:@\w+)?\s+(.+)/, safe(async (msg, m) => {
      if (!isAdmin(msg)) return;
      const raw = m[1].trim(), isUrl = /^https?:\/\//i.test(raw);
      const type = isUrl ? (/x\.com|twitter\.com|nitter/i.test(raw) ? 'x_feed' : 'rss') : 'tg_channel';
      const val = parseSource(type, raw);
      if (!val) return say(msg.chat.id, '❌ مصدر غير صالح');
      await run('INSERT OR IGNORE INTO sources(type, value, active) VALUES(?, ?, 1)', [type, val]);
      await say(msg.chat.id, `✅ تمت إضافة المصدر (${type}): ${val}`);
    }));
    bot.onText(/^\/settemplate(?:@\w+)?\s+([\s\S]+)/, safe(async (msg, m) => {
      if (!isAdmin(msg)) return;
      const tpl = m[1].trim();
      if (!tpl || tpl.length > 3000) return say(msg.chat.id, '❌ قالب غير صالح');
      await run("INSERT INTO settings(k, v) VALUES('template', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", [tpl]);
      await say(msg.chat.id, '✅ تم تحديث قالب النشر');
    }));
    bot.onText(/^\/fetch(?:@\w+)?$/, safe(async msg => {
      if (!isAdmin(msg)) return;
      const r = await runNewsCycle(true);
      await say(msg.chat.id, r.busy ? '⏳ هناك عملية جلب جارية الآن' : `🔄 تم الفحص والنشر. عدد المنشورات الجديدة: ${r.published || 0}`);
    }));
    bot.onText(/^\/status(?:@\w+)?$/, safe(async msg => {
      if (!isAdmin(msg)) return;
      const targets = await getActiveTargets();
      const srcs = first(await run('SELECT COUNT(*) AS c FROM sources WHERE active=1'));
      await say(msg.chat.id, `الحالة: ${isRunning ? 'يعمل' : 'متوقف'}\nمصادر نشطة: ${srcs && srcs.c || 0}\nقنوات نشر: ${targets.length}\nآخر دورة: ${lastCycleAt ? new Date(lastCycleAt).toISOString() : '—'}`);
    }));
  }

  return { initDB, registerCommands, runNewsCycle, adminAuth, handlers, setEnabledState, getActiveTargets };
}

module.exports = { createCore };
