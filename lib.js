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
];

const DEFAULT_TEMPLATE = [
  '⚡ عاجل {{NEWS}}',
  '',
  '',
  '👻 ADMIN (https://t.me/g_h_o_s_t_14)|👿  𝐆𝐇𝐎𝐒𝐓 (https://t.me/CRGhosts21) | ✈️Alkatiba21 (https://t.me/Alkatiba21) | 💬Group (https://t.me/HETANCR22)| 🗯 Referral  (https://t.me/REFERRA21)| 🎥 youtube  (https://www.youtube.com/@GHOSTS21-CG)|💬Twitter (https://x.com/Ghost_818)|📸Instagram (https://www.instagram.com/mr1997art/)|📨 Share (https://t.me/share/url?url=https://t.me/Alkatiba21&text=Hey%20You)',
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

function newsHash(text) {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return crypto.createHash('sha256').update(norm).digest('hex');
}

function applyTemplate(template, body) {
  const tpl = template && String(template).trim() ? String(template) : DEFAULT_TEMPLATE;
  const content = String(body || '').trim();
  if (/\{\{\s*NEWS\s*\}\}/i.test(tpl)) {
    return tpl.replace(/\{\{\s*NEWS\s*\}\}/gi, content);
  }
  const lines = tpl.split('\n');
  const mid = Math.max(1, Math.floor(lines.length / 2));
  return [...lines.slice(0, mid), content, ...lines.slice(mid)].join('\n');
}

function formatBilingualNews({ titleAr, titleEn, bodyAr, bodyEn, source, url, template }) {
  const arHead = titleAr ? `📌 *${titleAr}*` : '📌 *تحديث عاجل*';
  const enHead = titleEn ? `🌐 *${titleEn}*` : '🌐 *Market Update*';
  const arBlock = bodyAr ? `${arHead}\n${bodyAr}` : arHead;
  const enBlock = bodyEn ? `${enHead}\n${bodyEn}` : enHead;
  const meta = [
    source ? `📡 المصدر / Source: ${source}` : '',
    url ? `🔗 ${url}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const combined = `${arBlock}\n\n${enBlock}${meta ? `\n\n${meta}` : ''}`;
  return applyTemplate(template, combined);
}

function formatPriceAlert(item, template) {
  const up = item.change24h >= 0;
  const arrow = up ? '📈 ارتفاع' : '📉 انخفاض';
  const arrowEn = up ? 'UP' : 'DOWN';
  const sign = up ? '+' : '';
  const priceStr =
    item.price >= 1
      ? Number(item.price).toLocaleString('en-US', { maximumFractionDigits: 2 })
      : Number(item.price).toFixed(6);

  const body = [
    `${arrow} *${item.name} (${item.symbol})* — *${sign}${item.change24h.toFixed(2)}%* (24h)`,
    `💵 السعر الحالي: *$${priceStr}*`,
    '',
    `📊 *${item.symbol} ${arrowEn} ${sign}${item.change24h.toFixed(2)}%* (24h)`,
    `💵 Current Price: *$${priceStr}*`,
  ].join('\n');

  return applyTemplate(template, body);
}

function escapeMarkdown(text) {
  return String(text || '').replace(/([_*`\[])/g, '\\$1');
}

module.exports = {
  DEFAULT_CHANNELS,
  DEFAULT_RSS_FEEDS,
  DEFAULT_TEMPLATE,
  cleanChannelName,
  cleanTargetChannel,
  newsHash,
  applyTemplate,
  formatBilingualNews,
  formatPriceAlert,
  escapeMarkdown,
};
