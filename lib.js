const crypto = require('crypto');
const dns = require('dns').promises;
const https = require('https');
const http = require('http');

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

const DEFAULT_BUTTONS = [
  { text: 'القناة الرئيسية', url: 'https://t.me/Alkatiba21' },
  { text: 'Group التواصل', url: 'https://t.me/HETANCR22' },
  { text: 'كلم الـ Admin', url: 'https://t.me/g_h_o_s_t_14' },
  { text: 'مشاركة الخبر', url: 'https://t.me/share/url?url=https%3A%2F%2Ft.me%2FAlkatiba21' },
];

const DEFAULT_CUSTOM_EMOJI_PACKS = [
  'https://t.me/addemoji/H222890',
  'https://t.me/addemoji/FlagsIcons',
  'https://t.me/addemoji/ZIHAD_Premium_Seller_by_fStikBot',
  'https://t.me/addemoji/IconsEmoji_JABA',
];

const cleanSlug = s => String(s || '').trim()
  .replace(/^https?:\/\/(t\.me|telegram\.me)\/(s\/)?/i, '')
  .replace(/^@+/, '').split('/')[0].split('?')[0].trim();

function cleanChannelName(input) {
  const s = cleanSlug(input);
  return /^[A-Za-z0-9_]{5,32}$/.test(s) ? s : '';
}

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

function isPrivateOrReservedIp(ip) {
  if (!ip) return true;
  const s = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const check = mapped ? mapped[1] : s;
  // only treat as IP if it looks like one
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(check) && !/^[0-9a-f:]+$/i.test(check)) return false;
  if (/^127\./.test(check) || check === '0.0.0.0' || check === '::1' || check === '::') return true;
  if (/^10\./.test(check) || /^192\.168\./.test(check) || /^169\.254\./.test(check)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(check)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(check)) return true; // CGNAT
  if (check.startsWith('fc') || check.startsWith('fd') || check.startsWith('fe80:') || check.startsWith('ff')) return true;
  if (check === '169.254.169.254' || check === 'fd00:ec2::254') return true; // metadata
  return false;
}

function isSafeRemoteUrl(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch (_) { return false; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || !u.hostname) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false;
  if (host === 'metadata.google.internal' || host === 'metadata' || host.endsWith('.metadata')) return false;
  // reject literal IPs that are private/reserved, including non-standard forms
  if (isPrivateOrReservedIp(host)) return false;
  if (/^(0|127|10|192\.168|169\.254)\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host.includes('%') || host.includes('::ffff:') && isPrivateOrReservedIp(host)) return false;
  return true;
}

function cleanFeedUrl(input) {
  const s = String(input || '').trim();
  return isSafeRemoteUrl(s) && s.length <= 500 ? s : '';
}

async function resolveAndCheckHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (isPrivateOrReservedIp(host) || !isSafeRemoteUrl(`http://${host}`)) {
    throw new Error('unsafe_host');
  }
  const ips = [];
  try {
    const v4 = await dns.resolve4(host).catch(() => []);
    const v6 = await dns.resolve6(host).catch(() => []);
    ips.push(...v4, ...v6);
  } catch (_) {}
  if (!ips.length) {
    try {
      const looked = await dns.lookup(host, { all: true });
      ips.push(...looked.map(x => x.address));
    } catch (_) {}
  }
  if (!ips.length) throw new Error('dns_failed');
  for (const ip of ips) {
    if (isPrivateOrReservedIp(ip)) throw new Error('private_ip');
  }
  return ips;
}

function makePinnedRequest(urlStr, ip, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: ip,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: { ...(options.headers || {}), host: u.host },
      servername: u.hostname,
      timeout: options.timeoutMs || 12000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: { get: (k) => res.headers[String(k).toLowerCase()] || null },
          text: async () => body.toString('utf8'),
          json: async () => JSON.parse(body.toString('utf8')),
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function safeFetch(url, options = {}, fetchImpl = fetch) {
  let current;
  try { current = new URL(String(url)); } catch (_) { throw new Error('invalid_url'); }
  if (!isSafeRemoteUrl(current.href)) throw new Error('unsafe_url');
  const maxRedirects = 3;
  const useInjected = fetchImpl && fetchImpl !== fetch;
  for (let i = 0; i <= maxRedirects; i++) {
    const ips = await resolveAndCheckHost(current.hostname);
    const ip = ips[0];
    let res;
    if (useInjected) {
      res = await fetchImpl(current.href, { ...options, redirect: 'manual' });
    } else {
      res = await makePinnedRequest(current.href, ip, options);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc || i === maxRedirects) throw new Error('bad_redirect');
      const next = new URL(loc, current);
      if (!isSafeRemoteUrl(next.href)) throw new Error('unsafe_redirect');
      current = next;
      continue;
    }
    return res;
  }
  throw new Error('too_many_redirects');
}

function stripLinksAndHandles(text, sourceName = '') {
  let cleaned = String(text || '');

  // Remove only clear full URLs and handles, not partial words
  cleaned = cleaned
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/www\.\S+/gi, ' ')
    .replace(/\b(?:t|telegram)\.me\/\S+/gi, ' ')
    .replace(/\b(?:x|twitter)\.com\/\S+/gi, ' ')
    .replace(/\b[a-z0-9-]+\.(?:com|net|org|io|co|news|me|xyz|tv|app|info|biz|ai)\/\S*/gi, ' ')
    .replace(/(^|\s)@[A-Za-z0-9_]+\b/g, '$1');

  // Attribution lines only (whole line)
  cleaned = cleaned
    .replace(/(?:^|\n)\s*(?:📌|🔗|📰|📢|📣|📡|📍|🏷️|🏷|🏪|🏬|🏛️|🏛|🌐|💎|🚀|🔥|⚡|⚡️|•|-|—|–|\|)?\s*(?:المصدر|منقول\s*من|نقل[ااً]\s*عن|عبر|بواسطة|تابعونا\s*على|اشترك\s*في|للمزيد|قراءة\s*المزيد|اقرأ\s*المزيد|المقال\s*الأصلي|source|via|credit|read\s*more|full\s*story|originally\s*published)\s*[:\-–—|]?\s*[^\n]*/gi, '')
    .replace(/(?:^|\n)\s*(?:قناة|جروب|مجموعة|شبكة|صحيفة|موقع|منصة)\s+[^\n]{2,60}(?=\n|$)/gi, '');

  // Only remove exact whole-word source name if short and not containing numbers
  if (sourceName && String(sourceName).trim().length >= 3 && String(sourceName).trim().length <= 40 && !/\d/.test(sourceName)) {
    const esc = String(sourceName).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned.replace(new RegExp(`(?:^|\\s)${esc}(?:\\s|$)`, 'gi'), ' ');
  }

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

const NEWS_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'after', 'before', 'into', 'over', 'under',
  'على', 'من', 'في', 'إلى', 'عن', 'مع', 'بعد', 'قبل', 'هذا', 'هذه', 'ذلك', 'تلك', 'خلال', 'وسط',
  'تم', 'قد', 'يتم', 'جديد', 'الجديد', 'news', 'خبر', 'عاجل', 'اليوم', 'الآن',
]);

const NEWS_SYNONYMS = [
  [/\b(?:aircraft|airplane|plane|flight)\b|طائرة|طايرة|الطايرة|رحلة جوية/giu, ' aircraft '],
  [/\b(?:india|indian)\b|الهند|هندي|هندية/giu, ' india '],
  [/\b(?:missing|disappeared|disappear|lost contact|no contact)\b|اختفاء|اختفت|اختفى|مفقود|فقد الاتصال|انقطاع الاتصال|انقطع الاتصال/giu, ' aviation_event '],
  [/\b(?:crash|crashed|accident)\b|سقوط|سقط|سقطت|تحطم|تحطمت|حادث طيران/giu, ' aviation_event '],
  [/\b(?:earthquake|quake)\b|زلزال|هزة أرضية/giu, ' earthquake '],
  [/\b(?:explosion|blast)\b|انفجار|انفجرت/giu, ' explosion '],
  [/\b(?:fire|blaze)\b|حريق|اندلاع النيران/giu, ' fire '],
  [/\b(?:arrested|arrest|detained)\b|اعتقال|اعتقلت|احتجاز|أوقف/giu, ' arrest '],
  [/\b(?:killed|dead|deaths|died)\b|قتل|قتلى|وفيات|توفي|وفاة/giu, ' deaths '],
  [/\b(?:election|vote|voting)\b|انتخابات|انتخاب|تصويت/giu, ' election '],
];

function normalizedNewsTokens(text) {
  let normalized = String(text || '')
    .toLowerCase().normalize('NFKC')
    .replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '').replace(/[%٪]/g, ' percent ')
    .replace(/[^\p{L}\p{N}.+-]+/gu, ' ');
  for (const [rx, replacement] of NEWS_SYNONYMS) normalized = normalized.replace(rx, replacement);
  return new Set(normalized.split(/\s+/).filter(t => t.length >= 2 && !NEWS_STOPWORDS.has(t)));
}

function newsSignals(text) {
  const s = String(text || '').toLowerCase().normalize('NFKC');
  const assets = [];
  const assetMap = [
    ['bitcoin', /\b(?:bitcoin|btc)\b|بيتكوين|بتكوين/iu],
    ['ethereum', /\b(?:ethereum|eth)\b|ايثيريوم|إيثيريوم|إيثريوم/iu],
    ['bnb', /\b(?:bnb|binance coin)\b|باينانس\s*كوين/iu],
    ['solana', /\b(?:solana|sol)\b|سولانا/iu],
    ['ton', /\b(?:ton|toncoin)\b|تونكوين/iu],
    ['xrp', /\b(?:xrp|ripple)\b|ريبل/iu],
  ];
  for (const [name, rx] of assetMap) if (rx.test(s)) assets.push(name);
  const direction = /انخفاض|ينخفض|انخفض|هبوط|هبط|تراجع|يتراجع|خسر|خسارة|down|drop|fell|fall|decline|decrease|lower|سقوط/iu.test(s)
    ? 'down'
    : /ارتفاع|يرتفع|ارتفع|صعود|صعد|قفز|زيادة|يزيد|ربح|up|rise|rose|rally|increase|higher|surge/iu.test(s) ? 'up' : '';
  const numbers = [...s.matchAll(/\b\d+(?:[.,]\d+)?\s*[%٪]?|\$\s*\d+(?:[.,]\d+)?/g)]
    .map(m => m[0].replace(/\s+/g, '').replace('٪', '%').replace(',', '.')).sort();
  return { assets, direction, numbers };
}

function areSimilarNews(a, b) {
  const sa = newsSignals(a), sb = newsSignals(b);
  const sharedAssets = sa.assets.filter(x => sb.assets.includes(x));
  const sharedNumbers = sa.numbers.filter(x => sb.numbers.includes(x));
  const ta = normalizedNewsTokens(a), tb = normalizedNewsTokens(b);
  if (ta.size < 4 || tb.size < 4) return false;
  const intersection = [...ta].filter(x => tb.has(x)).length;
  const union = new Set([...ta, ...tb]).size;
  const jaccard = union ? intersection / union : 0;
  // Require strong textual overlap; shared asset+direction+number alone is not enough
  if (sharedAssets.length && sa.direction && sa.direction === sb.direction && sharedNumbers.length && jaccard >= 0.55) return true;
  if (sharedAssets.length && sa.direction && sa.direction === sb.direction && jaccard >= 0.65) return true;
  return jaccard >= 0.78;
}

const hasContent = text => /[\p{L}\p{N}]/u.test(stripLinksAndHandles(text));

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

function parseDate(s) {
  const raw = String(s || '').trim();
  if (!raw) return null;
  // Prefer explicit ISO / RFC822
  let t = Date.parse(raw);
  if (!Number.isFinite(t)) {
    // try common RSS variants
    t = Date.parse(raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  }
  if (!Number.isFinite(t)) return null;
  // reject clearly future or ancient
  const now = Date.now();
  if (t > now + 2 * 3600 * 1000 || t < now - 365 * 864e5) return null;
  return t;
}

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

function formatCleanBilingualPost({ bodyAr, bodyEn, template, sourceName = '', bilingual = false }) {
  const cleanAr = truncate(stripLinksAndHandles(bodyAr, sourceName), 900);
  const cleanEn = truncate(stripLinksAndHandles(bodyEn, sourceName), 900);
  const parts = [];
  if (cleanAr) parts.push(cleanAr);
  if (bilingual && cleanEn && cleanEn.toLowerCase() !== cleanAr.toLowerCase()) {
    parts.push(cleanEn);
  }
  return applyTemplate(template, parts.join('\n'));
}

function formatPriceAlert(item, template) {
  const change = Number(item.change24h) || 0, price = Number(item.price) || 0;
  if (!price || price <= 0) return null;
  const up = change >= 0;
  const dirAr = up ? 'ارتفاع' : 'انخفاض';
  const sign = up ? '+' : '';
  const priceStr = price >= 1 ? price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : price.toFixed(6);
  const body = `${dirAr} ${item.name} (${item.symbol}) بنسبة ${sign}${change.toFixed(2)}% خلال 24 ساعة — السعر $${priceStr}`;
  return applyTemplate(template, body);
}

function verifyInitData(init, token, maxAgeSec = 600, nowSec = Date.now() / 1000) {
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

function splitForTranslation(text, maxLen = 400) {
  const s = String(text || '').trim();
  if (s.length <= maxLen) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('. ', maxLen);
    if (cut < maxLen * 0.4) cut = rest.lastIndexOf(' ', maxLen);
    if (cut < 20) cut = maxLen;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

module.exports = {
  DEFAULT_CHANNELS, DEFAULT_RSS_FEEDS, DEFAULT_X_HANDLES, DEFAULT_TEMPLATE, DEFAULT_BUTTONS, DEFAULT_CUSTOM_EMOJI_PACKS, DEFAULT_PROMO,
  cleanChannelName, cleanTargetChannel, cleanXHandle, cleanFeedUrl, isSafeRemoteUrl, isPrivateOrReservedIp,
  stripLinksAndHandles, toBoldLines, newsHash, hasContent, truncate, isArabic, isPromo, parseDate,
  applyTemplate, polishArabicTranslation, formatCleanBilingualPost, formatPriceAlert, verifyInitData,
  normalizedNewsTokens, newsSignals, areSimilarNews, safeFetch, resolveAndCheckHost, splitForTranslation,
};
