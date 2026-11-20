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

function cleanChannelName(input) {
  if (!input) return '';
  return String(input)
    .trim()
    .replace(/^https?:\/\/(t\.me|telegram\.me)\/s\//i, '')
    .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '')
    .replace(/^@+/, '')
    .split('/')[0]
    .split('?')[0]
    .trim();
}

function cleanTargetChannel(input) {
  if (!input) return '';
  const raw = String(input).trim();
  if (/^-?\d+$/.test(raw)) return raw;
  const cleaned = raw
    .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '')
    .replace(/^@+/, '')
    .split('/')[0]
    .trim();
  return cleaned ? `@${cleaned}` : '';
}

function cleanXHandle(input) {
  if (!input) return '';
  const s = String(input).trim();
  if (/^https?:\/\//i.test(s)) return s;
  return s.replace(/^@+/, '').split('/')[0].split('?')[0].trim();
}

function stripLinksAndHandles(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/www\.\S+/gi, '')
    .replace(/t\.me\/\S+/gi, '')
    .replace(/@[A-Za-z0-9_]+/g, '')
    .replace(/[\*_`]+/g, '')
    .replace(/[ \t]+/g, ' ')
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

function applyTemplate(template, body) {
  const tpl = template && String(template).trim() ? String(template) : DEFAULT_TEMPLATE;
  const boldContent = toBoldLines(body);
  if (/\{\{\s*NEWS\s*\}\}/i.test(tpl)) {
    return tpl.replace(/\{\{\s*NEWS\s*\}\}/gi, boldContent);
  }
  const lines = tpl.split('\n');
  const mid = Math.max(1, Math.floor(lines.length / 2));
  return [...lines.slice(0, mid), boldContent, ...lines.slice(mid)].join('\n');
}

function formatCleanBilingualPost({ bodyAr, bodyEn, template }) {
  const cleanAr = stripLinksAndHandles(bodyAr).slice(0, 550);
  const cleanEn = stripLinksAndHandles(bodyEn).slice(0, 550);
  const parts = [];
  if (cleanAr) parts.push(cleanAr);
  if (cleanEn && cleanEn.toLowerCase() !== cleanAr.toLowerCase()) parts.push(cleanEn);
  const body = parts.join('\n');
  return applyTemplate(template, body);
}

function formatPriceAlert(item, template) {
  const up = item.change24h >= 0;
  const dirAr = up ? 'ارتفاع' : 'انخفاض';
  const dirEn = up ? 'UP' : 'DOWN';
  const sign = up ? '+' : '';
  const priceStr =
    item.price >= 1
      ? Number(item.price).toLocaleString('en-US', { maximumFractionDigits: 2 })
      : Number(item.price).toFixed(6);

  const body = [
    `${dirAr} ${item.name} (${item.symbol}) بنسبة ${sign}${item.change24h.toFixed(2)}% خلال 24 ساعة — السعر $${priceStr}`,
    `${item.symbol} ${dirEn} ${sign}${item.change24h.toFixed(2)}% (24h) — Price $${priceStr}`,
  ].join('\n');

  return applyTemplate(template, body);
}

module.exports = {
  DEFAULT_CHANNELS,
  DEFAULT_RSS_FEEDS,
  DEFAULT_X_HANDLES,
  DEFAULT_TEMPLATE,
  cleanChannelName,
  cleanTargetChannel,
  cleanXHandle,
  stripLinksAndHandles,
  toBoldLines,
  newsHash,
  applyTemplate,
  formatCleanBilingualPost,
  formatPriceAlert,
};
