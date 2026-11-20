const crypto = require('crypto');

const DEFAULT_CHANNELS = [
  'Crypto_News95',
  'x_crypto_1',
  'crypto_News24_Z',
  'aliitalk',
  'WatcherGuru',
  'zenteral',
];

const DEFAULT_RSS_FEEDS = [
  'https://cointelegraph.com/rss',
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://www.newsbtc.com/feed/',
  'https://cryptoslate.com/feeds/',
  'https://cryptobriefing.com/feeds/',
  'https://www.dlnews.com/rss/',
  'https://thedefiant.io/api/feed',
  'https://blog.coinlist.co/tag/defi/rss',
  'https://blog.synthetix.io/rss',
  'https://ritholtz.com/feed',
  'https://econbrowser.com/feed',
  'https://marginalrevolution.com/feed',
];

const DEFAULT_X_HANDLES = [
  'WatcherGuru',
  'Cointelegraph',
  'CoinDesk',
  'whale_alert',
  'TheBlock__',
  'Blockworks_',
  'VitalikButerin',
  'saylor',
  'cz_binance',
];

const DEFAULT_TEMPLATE = [
  '⚡ *عاجل*',
  '',
  '{{NEWS}}',
  '',
  '[👻 ADMIN](https://t.me/g_h_o_s_t_14)|[👿  𝐆𝐇𝐎𝐒𝐓](https://t.me/CRGhosts21) | [✈️Alkatiba21](https://t.me/Alkatiba21) | [💬Group](https://t.me/HETANCR22)| [🗯 Referral](https://t.me/REFERRA21)| [🎥 youtube](https://www.youtube.com/@GHOSTS21-CG)|[💬Twitter](https://x.com/Ghost_818)|[📸Instagram](https://www.instagram.com/mr1997art/)|[📨 Share](https://t.me/share/url?url=https://t.me/Alkatiba21&text=Hey%20You)',
].join('\n');

const cleanSlug = s => String(s || '').trim()
  .replace(/^https?:\/\/(t\.me|telegram\.me)\/(s\/)?/i, '')
  .replace(/^@+/, '').split('/')[0].split('?')[0].trim();

// Telegram channel to READ from (username only).
function cleanChannelName(input) {
  const s = cleanSlug(input);
  return /^[A-Za-z0-9_]{5,32}$/.test(s) ? s : '';
}

// Chat to POST to: numeric id or @username.
function cleanTargetChannel(input) {
  const raw = String(input || '').trim();
  if (/^-?\d{5,20}$/.test(raw)) return raw;
  const s = cleanSlug(raw);
  return /^[A-Za-z0-9_]{5,32}$/.test(s) ? `@${s}` : '';
}

function cleanXHandle(input) {
  const s = String(input || '').trim();
  if (/^https?:\/\//i.test(s)) return cleanFeedUrl(s);
  const h = s.replace(/^@+/, '').split('/')[0].split('?')[0].trim();
  return /^[A-Za-z0-9_]{1,30}$/.test(h) ? h : '';
}

function cleanFeedUrl(input) {
  const s = String(input || '').trim();
  return isSafeRemoteUrl(s) && s.length <= 500 ? s : '';
}

// Reject URLs that could target local/cloud metadata services if an admin session is compromised.
function isSafeRemoteUrl(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch (_) { return false; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || !u.hostname) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^(0|127|10|192\.168|169\.254)\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return false;
  return true;
}

// Removes links, @handles, source attributions (channel/group/site names), and Markdown-breaking characters.
function stripLinksAndHandles(text, sourceName = '') {
  let cleaned = String(text || '');

  // 1. Remove explicit source name / channel / site domain if provided
  if (sourceName && String(sourceName).trim()) {
    const rawSrc = String(sourceName).trim();
    const candidates = new Set([rawSrc]);
    if (/^https?:\/\//i.test(rawSrc)) {
      try {
        const u = new URL(rawSrc);
        const host = u.hostname.replace(/^www\./i, '');
        candidates.add(host);
        const base = host.split('.')[0];
        if (base && base.length >= 3) candidates.add(base);
      } catch (_) {}
    } else {
      const slug = rawSrc.replace(/^@+/, '').trim();
      if (slug) candidates.add(slug);
    }
    for (const c of candidates) {
      const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleaned = cleaned.replace(new RegExp(esc, 'gi'), '');
    }
  }

  // 2. Remove all URLs / domains / t.me / x.com / twitter.com / telegram.me links
  cleaned = cleaned
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/www\.\S+/gi, '')
    .replace(/\b(?:t|telegram)\.me\/\S+/gi, '')
    .replace(/\b(?:x|twitter)\.com\/\S+/gi, '')
    .replace(/\b[a-z0-9-]+\.(?:com|net|org|io|co|news|me|xyz|tv|app|info|biz|ai)\/\S*/gi, '')
    .replace(/@[A-Za-z0-9_]+/g, '');

  // 2b. Remove any remaining URLs/links/domains even if separated by spaces/punctuation
  cleaned = cleaned
    .replace(/(?:https?:\/\/)?[\w.-]+\.[a-z]{2,}(?:\/[^\s\n]*)?/gi, match => {
      // Keep decimal numbers like 1.5 or $0.05 (only remove if followed by slash or known TLD)
      if (/^\d+\.\d+$/.test(match)) return match;
      return '';
    });

  // 3. Remove common source attribution lines & prefixes/suffixes (Arabic & English)
  cleaned = cleaned
    // Standalone or trailing attribution lines: المصدر: ... / منقول من ... / عبر ... / قناة ... / جروب ... / موقع ... / Source: ... / Via ...
    .replace(/(?:^|\n)\s*(?:📌|🔗|📰|📢|📣|📡|📍|🏷️|🏷|🏪|🏬|🏛️|🏛|🌐|💎|🚀|🔥|⚡|⚡️|•|-|—|–|\|)?\s*(?:المصدر|منقول\s*من|نقل[ااً]\s*عن|عبر|بواسطة|تابعونا\s*على|اشترك\s*في|للمزيد|قراءة\s*المزيد|اقرأ\s*المزيد|المقال\s*الأصلي|source|via|credit|read\s*more|full\s*story|originally\s*published)\s*[:\-–—|]?\s*[^\n]*/gi, '')
    // Channel / Group / Site signature lines anywhere in text (e.g., "قناة كريبتو نيوز", "جروب ...", "موقع ...")
    .replace(/(?:^|\n)\s*(?:📌|🔗|📰|📢|📣|📡|🏪|🏬|🌐|⚡|⚡️|🔴|🟢|🔵|•|-|—|–|\|)?\s*(?:قناة|جروب|مجموعة|شبكة|صحيفة|موقع|منصة)\s+[^\n]{2,70}(?=\n|$)/gi, '')
    // Trailing pipe/dash/slash source suffixes on a line (e.g., "... | قناة كريبتو نيوز" or "... - CoinTelegraph")
    .replace(/\s*[\|—–\/]+\s*(?:قناة|جروب|موقع|شبكة)?\s*[\p{L}\p{N}_ .-]{2,50}$/gmu, '')
    // Leading channel/site tag with colon (e.g., "قناة كريبتو نيوز: ..." or "كريبتو نيوز:")
    .replace(/^\s*(?:قناة|جروب|موقع|شبكة)\s+[^\n:]{2,45}\s*:\s*/gmi, '')
    // Trailing short signature line at the very end of the post starting with an emoji or symbol (e.g., "🏪 كربتو نيوز", "📢 كريبتو نيوز", "🔹 Watcher Guru")
    .replace(/\n+\s*(?:[\p{Extended_Pictographic}\uFE0F\u200D•\-—–|]+\s*)+[\p{L}\p{N}_ .-]{2,40}\s*$/gu, '')
    // Trailing short brand/channel name line at the very end (2 to 4 words, no sentence-ending punctuation, preceded by blank line)
    .replace(/\n{2,}\s*(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?(?:[\p{L}\p{N}_-]+\s+){0,3}[\p{L}\p{N}_-]+\s*$/gu, match => {
      // Only strip if it does NOT contain numbers/prices/percentages (so real news lines with numbers are preserved)
      if (/\d|%|\$|دولار|ألف|مليون|مليار/.test(match)) return match;
      return '';
    });

  // 4. Clean Markdown-breaking characters and normalize whitespace
  return cleaned
    .replace(/[\*_`\[\]\\]+/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toBoldLines(text) {
  const cleaned = stripLinksAndHandles(text);
  if (!cleaned) return '';
  return cleaned
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => `*${line}*`)
    .join('\n\n');
}

function newsHash(text) {
  const norm = stripLinksAndHandles(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return crypto.createHash('sha256').update(norm).digest('hex');
}

const hasContent = text => /[\p{L}\p{N}]/u.test(stripLinksAndHandles(text));

// Cuts on a word boundary (by code points, so emoji are never split).
function truncate(s, n) {
  const cps = [...String(s || '')];
  if (cps.length <= n) return cps.join('');
  const cut = cps.slice(0, n).join('');
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

function isArabic(text) {
  const t = String(text || '');
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (!letters) return false;
  return (t.match(/[؀-ۿ]/g) || []).length / letters > 0.4;
}

const DEFAULT_PROMO = [
  'sponsored', 'promo code', 'referral code', 'referral link', 'use code', 'sign up now', 'register now',
  'join now', 'claim your', 'limited time', 'deposit bonus', 'welcome bonus', 'trading competition',
  'trading contest', 'win up to', 'prize pool',
  'إعلان ممول', 'محتوى ممول', 'كود الدعوة', 'كود الإحالة', 'كود خصم', 'سجل الآن', 'سجّل الآن',
  'انضم الآن', 'مسابقة تداول', 'جوائز تصل',
];
function isPromo(text, extra = []) {
  const t = String(text || '').toLowerCase();
  if (/(^|\s)#ad(\s|$)/i.test(t)) return true;
  return DEFAULT_PROMO.concat(extra).some(k => k && t.includes(String(k).toLowerCase()));
}

const parseDate = s => { const t = Date.parse(String(s || '').trim()); return Number.isFinite(t) ? t : null; };

// A function replacer is required: a plain string would interpret "$&", "$'" and "$$" inside the news text.
function applyTemplate(template, body) {
  const tpl = template && String(template).trim() ? String(template) : DEFAULT_TEMPLATE;
  const boldContent = toBoldLines(body);
  if (/\{\{\s*NEWS\s*\}\}/i.test(tpl)) {
    return tpl.replace(/\{\{\s*NEWS\s*\}\}/gi, () => boldContent);
  }
  const lines = tpl.split('\n');
  const mid = Math.max(1, Math.floor(lines.length / 2));
  return [...lines.slice(0, mid), boldContent, ...lines.slice(mid)].join('\n');
}

// Polishes machine-translated Arabic into natural, professional crypto & financial journalism Arabic.
function polishArabicTranslation(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  const replacements = [
    [/\bبيتكوين\b/g, 'البيتكوين'],
    [/\bإيثيريوم\b|\bايثريوم\b/g, 'الإيثيريوم'],
    [/\bسولانا\b/g, 'سولانا'],
    [/\bعملة مشفرة\b/g, 'عملة رقمية'],
    [/\bعملات مشفرة\b/g, 'عملات رقمية'],
    [/\bالعملات المشفرة\b/g, 'العملات الرقمية'],
    [/\bتشفير\b/g, 'كريبتو'],
    [/\bالاحتياطي الفيدرالي\b/g, 'الاحتياطي الفيدرالي الأمريكي'],
    [/\bلجنة الأوراق المالية والبورصات\b/g, 'هيئة الأوراق المالية والبورصات الأمريكية (SEC)'],
    [/\bصندوق الاستثمار المتداول\b/g, 'صندوق المؤشرات المتداول (ETF)'],
    [/\bصناديق الاستثمار المتداولة\b/g, 'صناديق المؤشرات المتداولة (ETF)'],
    [/\bحيتان\b/g, 'حيتان السوق'],
    [/\bارتفاع حاد\b/g, 'قفزة قوية'],
    [/\s+([،.؛:!؟])/g, '$1'],
    [/([،؛:])([^\s\n\d])/g, '$1 $2'],
  ];
  for (const [rx, val] of replacements) {
    s = s.replace(rx, val);
  }
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// bodyAr = Arabic version (or the original when translation is unavailable), bodyEn = original English text.
function formatCleanBilingualPost({ bodyAr, bodyEn, template, sourceName = '', bilingual = false }) {
  const cleanAr = truncate(stripLinksAndHandles(bodyAr, sourceName), 750);
  const cleanEn = truncate(stripLinksAndHandles(bodyEn, sourceName), 750);
  const parts = [];
  if (cleanAr) parts.push(cleanAr);
  if (bilingual && cleanEn && cleanEn.toLowerCase() !== cleanAr.toLowerCase()) {
    parts.push(cleanEn);
  }
  return applyTemplate(template, parts.join('\n'));
}

function formatPriceAlert(item, template) {
  const change = Number(item.change24h) || 0, price = Number(item.price) || 0;
  const up = change >= 0;
  const dirAr = up ? 'ارتفاع' : 'انخفاض';
  const sign = up ? '+' : '';
  const priceStr = price >= 1 ? price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : price.toFixed(6);
  const body = `${dirAr} ${item.name} (${item.symbol}) بنسبة ${sign}${change.toFixed(2)}% خلال 24 ساعة — السعر $${priceStr}`;
  return applyTemplate(template, body);
}

// Telegram Mini App initData (HMAC) check, used to protect the admin panel API.
function verifyInitData(init, token, maxAgeSec = 86400, nowSec = Date.now() / 1000) {
  if (!init || !token) return null;
  const p = new URLSearchParams(init), hash = p.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calc = crypto.createHmac('sha256', key).update(str).digest();
  if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), calc)) return null;
  const ad = Number(p.get('auth_date'));
  if (!Number.isFinite(ad) || ad <= 0 || ad > nowSec + 60 || nowSec - ad > maxAgeSec) return null;
  let user; try { user = JSON.parse(p.get('user')); } catch (e) { return null; }
  if (!user || !Number.isSafeInteger(user.id)) return null;
  return { user };
}

module.exports = {
  DEFAULT_CHANNELS, DEFAULT_RSS_FEEDS, DEFAULT_X_HANDLES, DEFAULT_TEMPLATE, DEFAULT_PROMO,
  cleanChannelName, cleanTargetChannel, cleanXHandle, cleanFeedUrl, isSafeRemoteUrl,
  stripLinksAndHandles, toBoldLines, newsHash, hasContent, truncate, isArabic, isPromo, parseDate,
  applyTemplate, polishArabicTranslation, formatCleanBilingualPost, formatPriceAlert, verifyInitData,
};
