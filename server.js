// Bell Coin: Express API + Telegram bot + SQLite
const express = require('express'), crypto = require('crypto'), path = require('path');
const Database = require('better-sqlite3'), TelegramBot = require('node-telegram-bot-api');
const { BOT_TOKEN, WEBAPP_URL, BOT_LINK, PORT = 3000 } = process.env;
const RATE = 25, DAY = 864e5, REF_BONUS = 50;
const db = new Database('bell.db');
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT,
  balance REAL DEFAULT 0, started INTEGER, refs INTEGER DEFAULT 0)`);

const accrued = u => RATE * Math.min(Date.now() - u.started, DAY) / 36e5;

// تحقق من initData اللي بيبعتها تليجرام (مينفعش حد يزوّر مستخدم)
function verify(init) {
  const p = new URLSearchParams(init), hash = p.get('hash'); p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const ok = crypto.createHmac('sha256', key).update(str).digest('hex') === hash;
  return ok ? { user: JSON.parse(p.get('user')), start: p.get('start_param') } : null;
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res, next) => {
  const v = verify(req.get('x-init') || '');
  if (!v) return res.sendStatus(401);
  let u = db.prepare('SELECT * FROM users WHERE id=?').get(v.user.id);
  if (!u) {
    db.prepare('INSERT INTO users(id,name,started) VALUES(?,?,?)').run(v.user.id, v.user.first_name, Date.now());
    const ref = /^r(\d+)$/.exec(v.start || '');
    if (ref && +ref[1] !== v.user.id && db.prepare('SELECT 1 FROM users WHERE id=?').get(+ref[1])) {
      db.prepare('UPDATE users SET balance=balance+?, refs=refs+1 WHERE id=?').run(REF_BONUS, +ref[1]);
      db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(REF_BONUS, v.user.id);
    }
    u = db.prepare('SELECT * FROM users WHERE id=?').get(v.user.id);
  }
  req.u = u; next();
});
const view = u => ({ now: Date.now(), balance: u.balance, rate: RATE, started: u.started,
  refs: u.refs, name: u.name, link: `${BOT_LINK}?startapp=r${u.id}` });

app.get('/api/me', (req, res) => res.json(view(req.u)));
app.post('/api/claim', (req, res) => {
  const a = accrued(req.u);
  db.prepare('UPDATE users SET balance=balance+?, started=? WHERE id=?').run(a, Date.now(), req.u.id);
  res.json(view(db.prepare('SELECT * FROM users WHERE id=?').get(req.u.id)));
});
app.listen(PORT, () => console.log('API on', PORT));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
bot.onText(/\/start/, msg => bot.sendMessage(msg.chat.id,
  '🔔 Welcome to Bell Coin!\nRing the bell, collect coins every day and invite friends.',
  { reply_markup: { inline_keyboard: [[{ text: '🔔 Open Bell Coin', web_app: { url: WEBAPP_URL } }]] } }));
