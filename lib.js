// Pure logic (no network, no database): levels, mining accrual, Telegram + TON Connect verification.
const crypto = require('crypto');

const DAY = 864e5;
const LEVELS = [
  { name: 'Free',     min: 0,    daily: 500 },
  { name: 'Tin',      min: 1000, daily: 700 },
  { name: 'Copper',   min: 2000, daily: 800 },
  { name: 'Brass',    min: 3000, daily: 900 },
  { name: 'Silver',   min: 4000, daily: 1000 },
  { name: 'BELLGRAM', min: 5000, daily: 1100 },
];
const levelFor = bal => { const v = Number(bal) || 0; let i = 0; while (i < LEVELS.length - 1 && v >= LEVELS[i + 1].min) i++; return i; };
const dailyFor = bal => LEVELS[levelFor(bal)].daily;
const round6 = n => Math.round(n * 1e6) / 1e6;

// Mining accrues in segments: `acc` is what was settled earlier in the session,
// then `rate` (BELL/day) runs from `seg_start` until the session ends (started + 24h).
const pending = (u, now) => u.acc + (u.rate / DAY) * Math.max(0, Math.min(now, u.started + DAY) - u.seg_start);

// Telegram Mini App initData (HMAC) check (7 days default TTL to avoid annoying session expirations).
function verifyInitData(init, token, maxAgeSec = 7 * 86400, nowSec = Date.now() / 1000) {
  if (!init || !token) return null;
  const p = new URLSearchParams(init), hash = p.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calc = crypto.createHmac('sha256', key).update(str).digest();
  if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), calc)) return null;
  const ad = Number(p.get('auth_date'));
  if (!ad || nowSec - ad > maxAgeSec || ad > nowSec + 300) return null;
  let user; try { user = JSON.parse(p.get('user')); } catch (e) { return null; }
  if (!user || !Number.isSafeInteger(user.id)) return null;
  return { user, start: p.get('start_param') };
}

// TON Connect ownership proof: the payload is bound to the Telegram user and expires.
function mkPayload(secret, uid, now = Date.now(), ttl = 600000) {
  const base = `${uid}.${now + ttl}`;
  const mac = crypto.createHmac('sha256', secret).update('tonproof:' + base).digest('hex').slice(0, 32);
  return `${base}.${mac}`;
}
function checkPayload(secret, uid, payload, now = Date.now()) {
  const m = /^(\d+)\.(\d+)\.([0-9a-f]{32})$/.exec(String(payload));
  if (!m || Number(m[1]) !== uid || Number(m[2]) < now) return false;
  const mac = crypto.createHmac('sha256', secret).update(`tonproof:${m[1]}.${m[2]}`).digest('hex').slice(0, 32);
  return crypto.timingSafeEqual(Buffer.from(m[3]), Buffer.from(mac));
}

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
async function verifyTonProof({ account, proof }, { secret, uid, domain, getPublicKey, now = Date.now() }) {
  if (!account || !proof || !proof.domain) return { ok: false, error: 'bad_request' };
  const m = /^(-?\d+):([0-9a-f]{64})$/i.exec(String(account.address || ''));
  if (!m) return { ok: false, error: 'bad_address' };
  
  const dom = String(proof.domain.value || '').toLowerCase();
  const expectedDom = String(domain || '').toLowerCase().replace(/:\d+$/, '');
  if (dom !== expectedDom && dom !== String(domain || '').toLowerCase()) return { ok: false, error: 'domain' };
  
  if (!checkPayload(secret, uid, proof.payload, now)) return { ok: false, error: 'payload' };
  
  const ts = Number(proof.timestamp);
  if (!Number.isSafeInteger(ts) || ts * 1000 < now - 900000 || ts * 1000 > now + 120000) return { ok: false, error: 'expired' };
  
  let pubHex = String(account.publicKey || '').toLowerCase();
  if (pubHex && !/^[0-9a-f]{64}$/.test(pubHex)) return { ok: false, error: 'pubkey' };

  let real = null;
  try { real = await getPublicKey(account.address); } catch (e) { real = null; }
  if (real) {
    real = String(real).toLowerCase();
    if (pubHex && real !== pubHex) return { ok: false, error: 'pubkey' };
    pubHex = real;
  }
  if (!/^[0-9a-f]{64}$/.test(pubHex)) return { ok: false, error: 'pubkey' };

  try {
    const wc = Buffer.alloc(4); wc.writeInt32BE(parseInt(m[1], 10));
    const domBytes = Buffer.from(String(proof.domain.value || ''), 'utf8');
    const dl = Buffer.alloc(4); dl.writeUInt32LE(domBytes.length);
    const tb = Buffer.alloc(8); tb.writeBigUInt64LE(BigInt(ts));
    const msg = Buffer.concat([Buffer.from('ton-proof-item-v2/'), wc, Buffer.from(m[2], 'hex'), dl, domBytes, tb, Buffer.from(String(proof.payload))]);
    const full = Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect'), crypto.createHash('sha256').update(msg).digest()]);
    const digest = crypto.createHash('sha256').update(full).digest();
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(pubHex, 'hex')]), format: 'der', type: 'spki' });
    const ok = crypto.verify(null, digest, key, Buffer.from(String(proof.signature), 'base64'));
    return ok ? { ok: true, address: `${parseInt(m[1], 10)}:${m[2].toLowerCase()}` } : { ok: false, error: 'signature' };
  } catch (e) { return { ok: false, error: 'signature' }; }
}

module.exports = { DAY, LEVELS, levelFor, dailyFor, round6, pending, verifyInitData, mkPayload, checkPayload, verifyTonProof };
