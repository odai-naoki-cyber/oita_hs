'use strict';
/**
 * 大分県 高校スタンプラリー - サーバー
 * Node.js 22+ / Express / node:sqlite(追加のネイティブ依存なし)
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const QRCode = require('qrcode');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
// 公開URL(QRコードに埋め込まれます)。本番では必ず設定してください。
// 例: PUBLIC_URL=https://stamp.example.jp
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'stamp.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS shops (
    id            INTEGER PRIMARY KEY,
    slug          TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL,
    token         TEXT UNIQUE NOT NULL,
    color         TEXT NOT NULL DEFAULT '#14213D',
    accent        TEXT NOT NULL DEFAULT '#F28C28',
    comment       TEXT NOT NULL DEFAULT '',
    logo_file     TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS admins (
    id       INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    salt     TEXT NOT NULL,
    hash     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    sid        TEXT PRIMARY KEY,
    admin_id   INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stamps (
    id         INTEGER PRIMARY KEY,
    visitor    TEXT NOT NULL,
    shop_id    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (visitor, shop_id)
  );
`);

/* ---------- 初期データ ---------- */
const SHOPS = [
  { slug: 'oita-higashi',  name: '大分東',   color: '#1F4E8C', accent: '#F2B33D', comment: '大分東高校へようこそ。' },
  { slug: 'usa-sangyo',    name: '宇佐産業', color: '#2F6B4F', accent: '#F28C28', comment: '宇佐産業高校のスタンプです。' },
  { slug: 'kuju-kogen',    name: '久住高原', color: '#5B7F2B', accent: '#F4D35E', comment: '久住高原の風を感じてください。' },
  { slug: 'hiji-sogo',     name: '日出総合', color: '#B23A48', accent: '#FCBF49', comment: '日出総合高校へようこそ。' },
  { slug: 'hita-rinko',    name: '日田林工', color: '#5C4033', accent: '#8CB369', comment: '日田林工高校の自慢を見ていってください。' },
  { slug: 'mie-sogo',      name: '三重総合', color: '#3A2E7A', accent: '#F28C28', comment: '三重総合高校のスタンプです。' },
  { slug: 'kunisaki',      name: '国東',     color: '#8A2D3B', accent: '#F2CC8F', comment: '国東高校へようこそ。' },
  { slug: 'kusu-miyama',   name: '玖珠美山', color: '#1B7F79', accent: '#F7B267', comment: '玖珠美山高校のスタンプです。' },
  { slug: 'saiki-hono',    name: '佐伯豊南', color: '#0F5C8C', accent: '#EF8354', comment: '佐伯豊南高校へようこそ。' },
];

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM shops').get().c;
  if (count === 0) {
    const ins = db.prepare(
      'INSERT INTO shops (slug, name, token, color, accent, comment, sort_order) VALUES (?,?,?,?,?,?,?)'
    );
    SHOPS.forEach((s, i) =>
      ins.run(s.slug, s.name, crypto.randomBytes(12).toString('hex'), s.color, s.accent, s.comment, i)
    );
  }
  const admins = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
  if (admins === 0) {
    const username = process.env.ADMIN_USER || 'admin';
    let password = process.env.ADMIN_PASSWORD;
    let generated = false;
    if (!password) {
      password = crypto.randomBytes(6).toString('base64url');
      generated = true;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO admins (username, salt, hash) VALUES (?,?,?)').run(
      username, salt, hashPassword(password, salt)
    );
    console.log('------------------------------------------------------------');
    console.log(' 管理者アカウントを作成しました');
    console.log(`   ユーザー名 : ${username}`);
    console.log(`   パスワード : ${password}${generated ? '   (自動生成・初回のみ表示)' : ''}`);
    console.log(' ログイン後、管理画面でパスワードを変更してください。');
    console.log('------------------------------------------------------------');
  }
  const set = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  set.run('event_title', '大分県 高校スタンプラリー');
  set.run('event_message', '9校をめぐって、スタンプを集めよう。');
  set.run('complete_message', 'コンプリートおめでとうございます。受付でこの画面をお見せください。');
  set.run('base_color', '#14213D');
  set.run('accent_color', '#F28C28');
}
seed();

const getSettings = () => {
  const o = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) o[r.key] = r.value;
  return o;
};

/* ---------- ロゴ(既定はSVGを自動生成) ---------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 各校ごとに異なる図形(地域・学科のモチーフ)。上半分(y=16〜60)に収め、校名は下の帯に置く
const MOTIFS = {
  'oita-higashi': (c, a) => `<circle cx="50" cy="44" r="9" fill="${a}"/><path d="M18 60 L50 22 L82 60 Z" fill="${a}" opacity=".35"/><path d="M26 60 L50 30 L74 60 Z" fill="${a}"/>`,              // 山と朝日
  'usa-sangyo':   (c, a) => `<rect x="26" y="40" width="48" height="20" rx="3" fill="${a}"/><path d="M34 40 V28 H44 V36 L54 28 V36 L64 28 V40" fill="${a}"/><rect x="60" y="20" width="7" height="20" fill="${a}"/>`, // 工場
  'kuju-kogen':   (c, a) => `<path d="M14 60 Q28 30 44 48 Q60 22 86 60 Z" fill="${a}"/><circle cx="72" cy="28" r="6" fill="${a}" opacity=".6"/>`,                                     // 高原の稜線と日
  'hiji-sogo':    (c, a) => `<circle cx="50" cy="34" r="10" fill="${a}"/><path d="M16 52 Q33 40 50 52 T84 52" fill="none" stroke="${a}" stroke-width="6" stroke-linecap="round"/>`,           // 海と日の出
  'hita-rinko':   (c, a) => `<path d="M50 16 L68 38 H32 Z" fill="${a}"/><path d="M50 28 L74 54 H26 Z" fill="${a}" opacity=".8"/><rect x="46" y="54" width="8" height="7" fill="${a}"/>`,   // 杉
  'mie-sogo':     (c, a) => `<circle cx="36" cy="40" r="15" fill="${a}"/><circle cx="64" cy="40" r="15" fill="${a}" opacity=".7"/><circle cx="50" cy="40" r="5" fill="${c}"/>`,             // 重なる円
  'kunisaki':     (c, a) => `<path d="M50 14 L57 34 L78 34 L61 46 L67 62 L50 52 L33 62 L39 46 L22 34 L43 34 Z" fill="${a}"/>`,                                                           // 星(半島の灯)
  'kusu-miyama':  (c, a) => `<path d="M14 60 L38 26 L52 46 L66 24 L88 60 Z" fill="${a}"/>`,                                                                                                // 連なる山
  'saiki-hono':   (c, a) => `<path d="M16 38 Q33 26 50 38 T84 38" fill="none" stroke="${a}" stroke-width="6" stroke-linecap="round"/><path d="M16 54 Q33 42 50 54 T84 54" fill="none" stroke="${a}" stroke-width="6" stroke-linecap="round" opacity=".7"/>`, // 波
};

function generatedLogoSvg(shop) {
  const motif = (MOTIFS[shop.slug] || (() => ''))(shop.color, shop.accent);
  const label = esc(shop.name);
  // 文字数に応じてサイズを調整(帯の幅=約64に収める)
  const n = [...shop.name].length;
  const fs = n <= 2 ? 17 : n === 3 ? 15 : 12.5;
  const id = 'c' + shop.id;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="${label}">
  <defs><clipPath id="${id}"><circle cx="50" cy="50" r="48"/></clipPath></defs>
  <circle cx="50" cy="50" r="48" fill="${shop.color}"/>
  <g clip-path="url(#${id})">
    <g>${motif}</g>
    <rect x="0" y="68" width="100" height="32" fill="#ffffff" opacity=".96"/>
    <rect x="0" y="66.5" width="100" height="2.5" fill="${shop.accent}"/>
  </g>
  <circle cx="50" cy="50" r="45" fill="none" stroke="${shop.accent}" stroke-width="1.4" opacity=".85"/>
  <text x="50" y="86" text-anchor="middle" font-family="'Zen Maru Gothic','Hiragino Maru Gothic ProN','Yu Gothic','Meiryo',sans-serif" font-weight="700" font-size="${fs}" fill="${shop.color}">${label}</text>
</svg>`;
}

const logoUrl = (shop) =>
  shop.logo_file ? `/uploads/${shop.logo_file}` : `/api/logo/${shop.slug}.svg`;

const publicShop = (s) => ({
  id: s.id, slug: s.slug, name: s.name, color: s.color, accent: s.accent,
  comment: s.comment, logo: logoUrl(s),
});

/* ---------- アプリ ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: (res) => res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'"),
}));
app.use(express.static(path.join(__dirname, 'public')));

/* --- 参加者向けAPI --- */
app.get('/api/event', (req, res) => {
  const s = getSettings();
  const shops = db.prepare('SELECT * FROM shops ORDER BY sort_order, id').all().map(publicShop);
  res.json({
    title: s.event_title, message: s.event_message, completeMessage: s.complete_message,
    baseColor: s.base_color, accentColor: s.accent_color, shops,
  });
});

app.get('/api/logo/:slug.svg', (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE slug = ?').get(req.params.slug);
  if (!shop) return res.status(404).end();
  res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(generatedLogoSvg(shop));
});

function getVisitor(req, res) {
  let v = req.cookies.visitor;
  if (!v || !/^[a-f0-9]{32}$/.test(v)) {
    v = crypto.randomBytes(16).toString('hex');
    res.cookie('visitor', v, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 180 });
  }
  return v;
}

// 自分の台紙(取得済みスタンプ)
app.get('/api/me', (req, res) => {
  const v = getVisitor(req, res);
  const rows = db.prepare(
    'SELECT shop_id, created_at FROM stamps WHERE visitor = ? ORDER BY created_at'
  ).all(v);
  res.json({ stamps: rows.map((r) => ({ shopId: r.shop_id, at: r.created_at })) });
});

// スタンプ取得(各校のQRコードから呼ばれる)
app.post('/api/stamp', (req, res) => {
  const token = String(req.body?.token || '');
  const shop = db.prepare('SELECT * FROM shops WHERE token = ?').get(token);
  if (!shop) return res.status(404).json({ error: 'このQRコードは無効です。会場のQRコードを読み直してください。' });
  const v = getVisitor(req, res);
  const r = db.prepare('INSERT OR IGNORE INTO stamps (visitor, shop_id, created_at) VALUES (?,?,?)')
    .run(v, shop.id, Date.now());
  const total = db.prepare('SELECT COUNT(*) AS c FROM shops').get().c;
  const have = db.prepare('SELECT COUNT(*) AS c FROM stamps WHERE visitor = ?').get(v).c;
  res.json({
    shop: publicShop(shop),
    isNew: r.changes > 0,
    collected: have,
    total,
    complete: have >= total,
  });
});

/* --- 管理者認証 --- */
const loginAttempts = new Map(); // ip -> {count, until}
function rateLimited(ip) {
  const e = loginAttempts.get(ip);
  return e && e.until > Date.now() && e.count >= 5;
}
function noteFailure(ip) {
  const e = loginAttempts.get(ip) || { count: 0, until: 0 };
  e.count += 1;
  e.until = Date.now() + 10 * 60 * 1000;
  loginAttempts.set(ip, e);
}

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  if (rateLimited(ip)) return res.status(429).json({ error: 'ログインに失敗した回数が多すぎます。10分後にもう一度お試しください。' });
  const { username = '', password = '' } = req.body || {};
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username));
  let ok = false;
  if (admin) {
    const a = Buffer.from(hashPassword(String(password), admin.salt), 'hex');
    const b = Buffer.from(admin.hash, 'hex');
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (!ok) {
    noteFailure(ip);
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います。' });
  }
  loginAttempts.delete(ip);
  const sid = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (sid, admin_id, expires_at) VALUES (?,?,?)')
    .run(sid, admin.id, Date.now() + 1000 * 60 * 60 * 8);
  res.cookie('sid', sid, {
    httpOnly: true, sameSite: 'strict', maxAge: 1000 * 60 * 60 * 8,
    secure: PUBLIC_URL.startsWith('https://'),
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE sid = ?').run(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

function requireAdmin(req, res, next) {
  const sid = req.cookies.sid;
  if (sid) {
    const row = db.prepare(
      'SELECT s.admin_id, a.username FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.sid = ? AND s.expires_at > ?'
    ).get(sid, Date.now());
    if (row) { req.admin = row; return next(); }
  }
  res.status(401).json({ error: 'ログインが必要です。' });
}

/* --- 管理API --- */
const HEX = /^#[0-9a-fA-F]{6}$/;

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ username: req.admin.username }));

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const settings = getSettings();
  const shops = db.prepare('SELECT * FROM shops ORDER BY sort_order, id').all().map((s) => ({
    ...publicShop(s),
    token: s.token,
    scanUrl: `${PUBLIC_URL}/s/${s.token}`,
    stampCount: db.prepare('SELECT COUNT(*) AS c FROM stamps WHERE shop_id = ?').get(s.id).c,
  }));
  const visitors = db.prepare('SELECT COUNT(DISTINCT visitor) AS c FROM stamps').get().c;
  const total = shops.length;
  const completed = db.prepare(
    'SELECT COUNT(*) AS c FROM (SELECT visitor FROM stamps GROUP BY visitor HAVING COUNT(*) >= ?)'
  ).get(total).c;
  res.json({ settings, shops, visitors, completed, publicUrl: PUBLIC_URL });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const map = { event_title: b.title, event_message: b.message, complete_message: b.completeMessage };
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === 'string') up.run(k, v.slice(0, 200));
  }
  if (HEX.test(b.baseColor || '')) up.run('base_color', b.baseColor);
  if (HEX.test(b.accentColor || '')) up.run('accent_color', b.accentColor);
  res.json({ ok: true });
});

app.put('/api/admin/shops/:id', requireAdmin, (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(Number(req.params.id));
  if (!shop) return res.status(404).json({ error: '店舗が見つかりません。' });
  const b = req.body || {};
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 30) : shop.name;
  const color = HEX.test(b.color || '') ? b.color : shop.color;
  const accent = HEX.test(b.accent || '') ? b.accent : shop.accent;
  const comment = typeof b.comment === 'string' ? b.comment.slice(0, 200) : shop.comment;
  db.prepare('UPDATE shops SET name=?, color=?, accent=?, comment=? WHERE id=?')
    .run(name, color, accent, comment, shop.id);
  res.json({ ok: true });
});

// ロゴ登録: data URL(PNG/JPEG/WebP/SVG)を受け取って保存
const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
app.post('/api/admin/shops/:id/logo', requireAdmin, (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(Number(req.params.id));
  if (!shop) return res.status(404).json({ error: '店舗が見つかりません。' });
  const m = /^data:([\w+/.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl || ''));
  if (!m || !LOGO_TYPES[m[1]]) return res.status(400).json({ error: 'PNG・JPEG・WebP・SVGのいずれかを選んでください。' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'ファイルサイズは2MB以下にしてください。' });
  if (m[1] === 'image/svg+xml') {
    // SVG内のスクリプトを含むものは受け付けない
    const text = buf.toString('utf8');
    if (/<script|on\w+\s*=|javascript:|<foreignObject/i.test(text)) {
      return res.status(400).json({ error: 'スクリプトを含むSVGは登録できません。' });
    }
  }
  const file = `${shop.slug}-${Date.now()}.${LOGO_TYPES[m[1]]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  if (shop.logo_file) fs.rmSync(path.join(UPLOAD_DIR, path.basename(shop.logo_file)), { force: true });
  db.prepare('UPDATE shops SET logo_file = ? WHERE id = ?').run(file, shop.id);
  res.json({ ok: true, logo: `/uploads/${file}` });
});

app.delete('/api/admin/shops/:id/logo', requireAdmin, (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(Number(req.params.id));
  if (!shop) return res.status(404).json({ error: '店舗が見つかりません。' });
  if (shop.logo_file) fs.rmSync(path.join(UPLOAD_DIR, path.basename(shop.logo_file)), { force: true });
  db.prepare('UPDATE shops SET logo_file = NULL WHERE id = ?').run(shop.id);
  res.json({ ok: true, logo: `/api/logo/${shop.slug}.svg` });
});

// QRを作り直す(古いQRは無効になります)
app.post('/api/admin/shops/:id/regenerate-token', requireAdmin, (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(Number(req.params.id));
  if (!shop) return res.status(404).json({ error: '店舗が見つかりません。' });
  db.prepare('UPDATE shops SET token = ? WHERE id = ?').run(crypto.randomBytes(12).toString('hex'), shop.id);
  res.json({ ok: true });
});

app.post('/api/admin/password', requireAdmin, (req, res) => {
  const { current = '', next = '' } = req.body || {};
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.admin_id);
  const a = Buffer.from(hashPassword(String(current), admin.salt), 'hex');
  const b = Buffer.from(admin.hash, 'hex');
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
    return res.status(400).json({ error: '現在のパスワードが違います。' });
  }
  if (String(next).length < 8) return res.status(400).json({ error: '新しいパスワードは8文字以上にしてください。' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE admins SET salt=?, hash=? WHERE id=?').run(salt, hashPassword(String(next), salt), admin.id);
  db.prepare('DELETE FROM sessions WHERE admin_id = ? AND sid != ?').run(admin.id, req.cookies.sid);
  res.json({ ok: true });
});

app.post('/api/admin/reset-stamps', requireAdmin, (req, res) => {
  if (req.body?.confirm !== 'RESET') return res.status(400).json({ error: '確認文字列が違います。' });
  db.prepare('DELETE FROM stamps').run();
  res.json({ ok: true });
});

// 管理画面用: 各校のQR画像(PNG)。?size=ピクセル
app.get('/api/admin/qr/:id.png', requireAdmin, async (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(Number(req.params.id));
  if (!shop) return res.status(404).end();
  const size = Math.min(2000, Math.max(200, Number(req.query.size) || 800));
  const png = await QRCode.toBuffer(`${PUBLIC_URL}/s/${shop.token}`, { width: size, margin: 2, errorCorrectionLevel: 'M' });
  res.type('image/png').set('Cache-Control', 'no-store').send(png);
});

// 全体の入口QR(アプリのトップへ)
app.get('/api/qr/app.png', async (req, res) => {
  const size = Math.min(2000, Math.max(200, Number(req.query.size) || 800));
  const png = await QRCode.toBuffer(`${PUBLIC_URL}/`, { width: size, margin: 2, errorCorrectionLevel: 'M' });
  res.type('image/png').send(png);
});

/* --- ページ --- */
// 各校QRの着地点。ページ側がtokenを読み取ってスタンプAPIを呼ぶ
app.get('/s/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'stamp.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.use((req, res) => res.status(404).send('ページが見つかりません。'));

// 期限切れセッションの掃除
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 60 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`スタンプラリーを起動しました: ${PUBLIC_URL}`);
  console.log(`  参加者用  : ${PUBLIC_URL}/`);
  console.log(`  管理画面  : ${PUBLIC_URL}/admin`);
});
