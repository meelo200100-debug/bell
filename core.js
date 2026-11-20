// Bot logic (no network or database setup here, so it can be tested with fakes).
const L = require('./lib');

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; CryptoNewsBot/1.0)' };
const DAY = 864e5;

function decodeHtml(str) {
  const cp = n => { try { return String.fromCodePoint(n); } catch (e) { return ''; } };
  const tags = /<\/?[a-z][^>]*>/gi;
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    // Remove entire <a>...</a> tags that link to Telegram, X/Twitter, or external channel/source URLs
    .replace(/<a\b[^>]*href=["']https?:\/\/[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(tags, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(tags, ' ') // feeds often ship escaped HTML
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function telegramHtml(text) {
  let s = String(text || '');
  const custom = [];
  s = s.replace(/\{\{TG_EMOJI:(\d+)\|([^}]+)\}\}/g, (_, id, glyph) => {
    const token = `__CUSTOM_EMOJI_${custom.length}__`;
    custom.push(`<tg-emoji emoji-id="${id}">${escapeHtml(glyph)}</tg-emoji>`);
    return token;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
  s = s.replace(/\n/g, '\n');
  custom.forEach((html, i) => { s = s.replace(`__CUSTOM_EMOJI_${i}__`, html); });
  return s;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length).fill(null).map(() => []);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      try { out[k] = await fn(items[k]); } catch (e) { out[k] = []; console.warn(`Source error [${items[k].value}]:`, e.message); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function createCore({ db, bot, cfg, fetchFn = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now }) {
  let isRunning = true, lastCycleAt = null, lastError = null, latestPrices = [], cycleRunning = false;
  const run = (sql, args = []) => db.execute({ sql, args });
  const first = r => (r.rows && r.rows[0]) || null;

  // ---------- database ----------
  async function initDB() {
    await run('CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)');
    await run(`CREATE TABLE IF NOT EXISTS sources(
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, value TEXT NOT NULL UNIQUE, active INTEGER DEFAULT 1)`);
    await run(`CREATE TABLE IF NOT EXISTS targets(
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL UNIQUE, active INTEGER DEFAULT 1)`);
    await run('CREATE TABLE IF NOT EXISTS posted_items(hash TEXT PRIMARY KEY, source TEXT, title TEXT, posted_at INTEGER)');

    const en = first(await run("SELECT v FROM settings WHERE k='enabled'"));
    if (!en) await run("INSERT INTO settings(k, v) VALUES('enabled', '1')");
    else isRunning = en.v !== '0';

    // Only the first run writes the default template; a template saved from the panel survives restarts.
    await run("INSERT OR IGNORE INTO settings(k, v) VALUES('template', ?)", [L.DEFAULT_TEMPLATE]);

    for (const ch of L.DEFAULT_CHANNELS) await run("INSERT OR IGNORE INTO sources(type, value, active) VALUES('tg_channel', ?, 1)", [ch]);
    for (const feed of L.DEFAULT_RSS_FEEDS) await run("INSERT OR IGNORE INTO sources(type, value, active) VALUES('rss', ?, 1)", [feed]);
    // X accounts only work through a Nitter host you configure, so they are seeded only when NITTER_HOSTS is set.
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
    return html.split('data-post="').slice(1).slice(-8).map(block => {
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

  async function fetchRssFeed(feedUrl) {
    const res = await fetchFn(feedUrl, { headers: UA, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const xml = await res.text();
    const feedTitleMatch = /<(?:channel|feed)[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i.exec(xml);
    const feedTitle = feedTitleMatch ? decodeHtml(feedTitleMatch[1]).split(/[\|\-–—]/)[0].trim() : '';
    return [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].slice(0, 8).map(m => {
      const raw = m[0];
      const pick = tag => (new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(raw) || [])[1] || '';
      let title = L.stripLinksAndHandles(decodeHtml(pick('title')), feedUrl);
      let desc = L.stripLinksAndHandles(decodeHtml(pick('description') || pick('summary') || pick('content')), feedUrl);
      if (feedTitle && feedTitle.length >= 3) {
        title = L.stripLinksAndHandles(title, feedTitle);
        desc = L.stripLinksAndHandles(desc, feedTitle);
      }
      const text = desc && !desc.toLowerCase().startsWith(title.toLowerCase()) ? `${title}\n${desc}` : (desc || title);
      const ts = L.parseDate(decodeHtml(pick('pubDate') || pick('published') || pick('updated') || pick('dc:date')));
      return { text, ts, source: feedUrl, sourceTitle: feedTitle || feedUrl };
    }).filter(x => x.text && x.text.length >= 15);
  }

  async function fetchXAccount(handleOrUrl) {
    if (/^https?:\/\//i.test(handleOrUrl)) return fetchRssFeed(handleOrUrl);
    if (!cfg.nitterHosts.length) return [];
    for (const host of cfg.nitterHosts) {
      try {
        const items = await fetchRssFeed(`${host.replace(/\/$/, '')}/${encodeURIComponent(handleOrUrl)}/rss`);
        if (items.length) return items;
      } catch (_) { /* try next host */ }
    }
    return [];
  }

  const fetchSource = s => (
    s.type === 'tg_channel' ? fetchTelegramChannel(s.value)
      : s.type === 'rss' || s.type === 'x_feed' ? fetchRssFeed(s.value)
        : s.type === 'x_account' ? fetchXAccount(s.value) : Promise.resolve([])
  );

  // Professional automatic translation to Arabic (supports LibreTranslate if configured + built-in fallback translators).
  async function translateToArabic(text) {
    const cleanInput = String(text || '').trim();
    if (!cleanInput) return null;

    // 1. Custom LibreTranslate server if configured
    if (cfg.translateUrl) {
      try {
        const r = await fetchFn(`${cfg.translateUrl.replace(/\/$/, '')}/translate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
          body: JSON.stringify({ q: cleanInput, source: 'auto', target: 'ar', format: 'text', ...(cfg.translateKey ? { api_key: cfg.translateKey } : {}) }),
        });
        if (r.ok) {
          const j = await r.json();
          if (typeof j.translatedText === 'string' && j.translatedText.trim()) {
            return L.polishArabicTranslation(j.translatedText);
          }
        }
      } catch (_) {}
    }

    // 2. Built-in free neural translation (Google GTX endpoint - works immediately with zero API keys)
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ar&dt=t&q=${encodeURIComponent(cleanInput)}`;
      const r = await fetchFn(url, { headers: UA, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data && data[0])) {
          const translated = data[0].map(seg => (seg && seg[0]) || '').join('').trim();
          if (translated && L.isArabic(translated)) {
            return L.polishArabicTranslation(translated);
          }
        }
      }
    } catch (_) {}

    // 3. Secondary fallback (MyMemory Translation API)
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(cleanInput.slice(0, 480))}&langpair=en|ar`;
      const r = await fetchFn(url, { headers: UA, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j = await r.json();
        const translated = j && j.responseData && j.responseData.translatedText;
        if (typeof translated === 'string' && translated.trim() && L.isArabic(translated)) {
          return L.polishArabicTranslation(translated);
        }
      }
    } catch (_) {}

    return null;
  }

  // ---------- sending ----------
  async function sendSafe(chatId, text) {
    let plain = false, waited = false;
    for (let i = 0; i < 3; i++) {
      try {
        await bot.sendMessage(chatId, plain ? text.replace(/\{\{TG_EMOJI:\d+\|([^}]+)\}\}/g, '$1').replace(/<[^>]*>/g, '') : telegramHtml(text),
          plain ? { disable_web_page_preview: true } : { parse_mode: 'HTML', disable_web_page_preview: true });
        return { ok: true };
      } catch (e) {
        const { code, desc, retry } = tgError(e);
        if (code === 429 && !waited) { waited = true; await sleep(Math.min(30, retry || 5) * 1000); continue; }
        if (code === 400 && /parse entities/i.test(desc) && !plain) { plain = true; continue; }
        return { ok: false, permanent: code === 400 || code === 403 || code === 404, error: desc };
      }
    }
    return { ok: false, permanent: false, error: 'retries exhausted' };
  }

  // done=true means the item can be recorded as handled (sent somewhere, or rejected for good everywhere).
  async function publish(text, targets) {
    let ok = 0, permanent = 0, lastErr = '';
    for (const chatId of targets) {
      const r = await sendSafe(chatId, text);
      if (r.ok) ok++;
      else { lastErr = `${chatId}: ${r.error}`; console.error('Send failed', lastErr); if (r.permanent) permanent++; }
    }
    return { ok, done: ok > 0 || permanent === targets.length, error: lastErr };
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
  async function fetchCryptoMarketAlerts(template, targets) {
    const ids = COINS.map(c => c.id).join(',');
    const res = await fetchFn(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
      { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return 0;
    const data = await res.json();
    latestPrices = COINS.map(c => {
      const row = data[c.id] || {};
      return { symbol: c.symbol, name: c.name, price: Number(row.usd || 0), change24h: Number(row.usd_24h_change || 0) };
    });
    let published = 0;
    const postDelayMs = Math.max(0, Number(cfg.postDelayMs ?? 5000));
    for (const item of latestPrices) {
      if (!item.price || Math.abs(item.change24h) < cfg.priceThreshold) continue;
      const bucket = Math.floor(now() / (4 * 3600 * 1000));
      const h = L.newsHash(`price:${item.symbol}:${item.change24h >= 0 ? 'up' : 'down'}:${bucket}`);
      if (first(await run('SELECT 1 FROM posted_items WHERE hash=?', [h]))) continue;
      if (published > 0 && postDelayMs > 0) await sleep(postDelayMs);
      const r = await publish(L.formatPriceAlert(item, template), targets);
      if (!r.done) break;
      await run('INSERT OR IGNORE INTO posted_items(hash, source, title, posted_at) VALUES(?, ?, ?, ?)', [h, 'market', item.symbol, now()]);
      if (r.ok) published++;
    }
    return published;
  }

  // ---------- main cycle ----------
  async function runNewsCycle(force = false) {
    if (!isRunning && !force) return { skipped: true, published: 0 };
    if (cycleRunning) return { skipped: true, busy: true, published: 0 };
    cycleRunning = true; lastCycleAt = now(); lastError = null;
    try {
      const targets = await getActiveTargets();
      if (!targets.length) return { skipped: false, published: 0, reason: 'no_targets' };
      const template = await getTemplate();

      const srcRows = (await run('SELECT type, value FROM sources WHERE active=1')).rows || [];
      const collected = (await mapLimit(srcRows, 6, fetchSource)).flat();

      const cutoff = now() - cfg.maxAgeMs;
      let items = collected.filter(i => i && i.text && L.hasContent(i.text) && (i.ts === null || i.ts >= cutoff));
      if (cfg.adFilter) items = items.filter(i => !L.isPromo(i.text, cfg.adExtra));
      items = items.map(i => ({ ...i, ts: i.ts === null ? now() : i.ts })).sort((a, b) => b.ts - a.ts);

      const picked = [], inBatch = new Set();
      for (const it of items) {
        if (picked.length >= cfg.maxPerCycle) break;
        const h = L.newsHash(it.text);
        if (inBatch.has(h)) continue;
        inBatch.add(h);
        if (first(await run('SELECT 1 FROM posted_items WHERE hash=?', [h]))) continue;
        picked.push({ ...it, h });
      }
      picked.reverse(); // newest last, so the channel reads in order

      let published = 0;
      const postDelayMs = Math.max(0, Number(cfg.postDelayMs ?? 5000));
      for (let idx = 0; idx < picked.length; idx++) {
        if (idx > 0 && postDelayMs > 0) {
          await sleep(postDelayMs);
        }
        const it = picked[idx];
        const translated = await translateToArabic(it.text.slice(0, 800));
        const ar = translated && L.isArabic(translated) ? translated : (L.isArabic(it.text) ? it.text : null);
        if (!ar) {
          lastError = `تعذرت ترجمة الخبر إلى العربية؛ تم تخطيه: ${String(it.sourceTitle || it.source || 'مصدر غير معروف')}`;
          console.warn(lastError);
          continue;
        }
        const r = await publish(L.formatCleanBilingualPost({ bodyAr: ar, bodyEn: '', template, sourceName: it.sourceTitle || it.source || '', bilingual: false }), targets);
        if (!r.done) { lastError = `Telegram unreachable: ${r.error}`; break; }
        await run('INSERT OR IGNORE INTO posted_items(hash, source, title, posted_at) VALUES(?, ?, ?, ?)', [it.h, it.source || 'feed', it.text.slice(0, 120), now()]);
        if (r.ok) published++; else lastError = `Could not post to any channel: ${r.error}`;
      }

      try { published += await fetchCryptoMarketAlerts(template, targets); }
      catch (e) { console.warn('Market alerts failed:', e.message); }

      await run('DELETE FROM posted_items WHERE posted_at < ?', [now() - 30 * DAY]);
      return { skipped: false, published };
    } catch (e) {
      lastError = e.message;
      console.error('News cycle error:', e);
      return { skipped: false, published: 0, error: e.message };
    } finally {
      cycleRunning = false;
    }
  }

  // ---------- admin API ----------
  function adminAuth(req, res, next) {
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
      const [sources, targets, posted, template] = await Promise.all([
        run('SELECT id, type, value, active FROM sources ORDER BY id ASC'),
        run('SELECT id, chat_id, active FROM targets ORDER BY id ASC'),
        run('SELECT COUNT(*) AS c FROM posted_items'),
        getTemplate(),
      ]);
      res.json({
        running: isRunning, busy: cycleRunning, lastCycleAt, lastError,
        publishedCount: Number((first(posted) || {}).c || 0), template,
        sources: sources.rows || [], targets: targets.rows || [], prices: latestPrices,
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
    // Let the admin use Telegram's native Premium/custom-emoji picker: send a custom emoji
    // to the bot and it returns the exact template token with its Telegram emoji ID.
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
      await say(msg.chat.id,
        `📊 الحالة: ${isRunning ? 'شغال ✅' : 'متوقف ⏸️'}\n📡 المصادر النشطة: ${(srcs && srcs.c) || 0}\n` +
        `📣 قنوات النشر: ${targets.join(', ') || 'لا يوجد'}\n` +
        `🕒 آخر دورة: ${lastCycleAt ? new Date(lastCycleAt).toISOString() : '—'}\n` +
        `${lastError ? `⚠️ آخر خطأ: ${lastError}\n` : ''}${cfg.nitterHosts.length ? '' : 'ℹ️ مصادر X متوقفة (لا يوجد NITTER_HOSTS)\n'}`,
        { disable_web_page_preview: true });
    }));
  }

  return { initDB, runNewsCycle, adminAuth, handlers, registerCommands, getActiveTargets };
}

module.exports = { createCore, decodeHtml, tgError };
