'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const isHttps = req => !!(req.socket.encrypted || (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https'));
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUB = path.join(__dirname, 'public');
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const CATS = ['phone', 'tablet', 'accessory', 'charger'];
const STATUSES = ['جدید', 'در حال پردازش', 'ارسال شده', 'تحویل شده', 'لغو شده', 'در انتظار پرداخت', 'پرداخت شده', 'پرداخت ناموفق'];
const ZP_MERCHANT = process.env.ZARINPAL_MERCHANT || '';
const ZP_SANDBOX = process.env.ZARINPAL_SANDBOX === '1';
const ZP_UNIT = Number(process.env.ZARINPAL_UNIT || 10); // مبلغ به تومان × این عدد = مبلغ ارسالی. قبل از اجرای واقعی در مستندات درگاه بررسی کنید
const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3000';
const SESSION_MS = 2 * 60 * 60 * 1000;
const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon'};
const SEC = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const sessions = new Map(); // token -> expiry
const fails = new Map();    // ip -> {n, until}
const rates = new Map();    // key -> {n, reset}

// ---------- helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const httpErr = (code, msg) => Object.assign(new Error(msg || 'error'), {code});
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, min, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
const safeUrl = u => u === '' || (u.length <= 500 && (/^https:\/\/[^\s"'<>]+$/i.test(u) || /^\/uploads\/[a-z0-9.]+$/.test(u)));
const cookie = (v, maxAge, secure) => `sid=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

function json(res, code, obj, extra = {}) {
  res.writeHead(code, {...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra});
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { req.destroy(); return reject(httpErr(413, 'حجم درخواست زیاد است')); }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(httpErr(400, 'JSON نامعتبر')); }
    });
    req.on('error', reject);
  });
}

function hit(map, key, max, windowMs) {
  const now = Date.now();
  let r = map.get(key);
  if (!r || r.reset < now) { r = {n: 0, reset: now + windowMs}; map.set(key, r); }
  r.n++;
  return r.n <= max;
}

const clientIp = req => (TRUST_PROXY && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;

// ---------- password hashing (scrypt) ----------
function hashPass(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(p, salt, 64).toString('hex');
}
function checkPass(p, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(p, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- database (JSON file, atomic writes) ----------
function defaultDb() {
  return {
    settings: {shop: 'فروشگاه موبایل', phone: '989120000000', intro: 'گوشی و لوازم اصل با ضمانت و ارسال سریع', adminHash: ''},
    products: [
      {id: 'p1', name: 'iPhone 13 - 128GB', brand: 'Apple', cat: 'phone', price: 35000000, oldPrice: 37000000, stock: 3, img: '', desc: 'سالم، باتری ۹۲٪'},
      {id: 'p2', name: 'Samsung Galaxy A54', brand: 'Samsung', cat: 'phone', price: 14500000, oldPrice: 0, stock: 5, img: '', desc: 'رم ۸ گیگ'},
    ],
    orders: [],
  };
}

function save() {
  fs.mkdirSync(path.dirname(DB_FILE), {recursive: true});
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : defaultDb();
if (!db.settings.adminHash) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.settings.adminHash = hashPass(pw);
  save();
  if (!process.env.ADMIN_PASSWORD) console.log('رمز اولیه مدیر (فقط یک بار نمایش داده می‌شود):', pw);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v < now) sessions.delete(k);
}, 60000).unref();

// ---------- validation ----------
function cleanProduct(b) {
  const name = str(b.name, 80), cat = CATS.includes(b.cat) ? b.cat : null;
  const price = int(b.price, 0, 1e12), oldPrice = int(b.oldPrice ?? 0, 0, 1e12), stock = int(b.stock, 0, 100000);
  const img = str(b.img, 500);
  if (!name || !cat || price === null || oldPrice === null || stock === null || !safeUrl(img)) return null;
  return {name, brand: str(b.brand, 40), cat, price, oldPrice, stock, img, desc: str(b.desc, 200)};
}

// ---------- session ----------
function getSid(req) {
  const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]{43})/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function isAdmin(req) {
  const sid = getSid(req);
  const exp = sid && sessions.get(sid);
  if (!exp || exp < Date.now()) { if (sid) sessions.delete(sid); return null; }
  sessions.set(sid, Date.now() + SESSION_MS);
  return sid;
}

// ---------- handlers ----------
const publicSettings = s => ({shop: s.shop, phone: s.phone, intro: s.intro});

async function createOrder(req, res, ip) {
  if (!hit(rates, 'order:' + ip, 10, 60000)) return json(res, 429, {error: 'درخواست زیاد. کمی صبر کنید'});
  const b = await readBody(req);
  const name = str(b.name, 60), phone = str(b.phone, 15), address = str(b.address, 300);
  if (!name || !/^[0-9+ ]{7,15}$/.test(phone) || !address) return json(res, 400, {error: 'اطلاعات ناقص است'});
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 30) return json(res, 400, {error: 'سبد خالی است'});

  const want = new Map();
  for (const it of b.items) {
    const id = str(it && it.id, 40), qty = int(it && it.qty, 1, 99);
    if (!id || qty === null) return json(res, 400, {error: 'آیتم نامعتبر'});
    want.set(id, (want.get(id) || 0) + qty);
  }
  const lines = [];
  for (const [id, qty] of want) {
    const pr = db.products.find(x => x.id === id);
    if (!pr) return json(res, 404, {error: 'محصول یافت نشد'});
    if (pr.stock < qty) return json(res, 409, {error: `موجودی «${pr.name}» کافی نیست`});
    lines.push({id, name: pr.name, price: pr.price, qty});
  }
  const online = b.pay === 'online';
  if (online && !ZP_MERCHANT) return json(res, 400, {error: 'پرداخت آنلاین فعال نیست'});
  // All checks passed. Node runs single-threaded, so this block is atomic.
  for (const l of lines) db.products.find(x => x.id === l.id).stock -= l.qty;
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const order = {
    id: 'O' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
    createdAt: new Date().toISOString(), name, phone, address, items: lines, total, status: STATUSES[0],
  };
  order.status = online ? 'در انتظار پرداخت' : STATUSES[0];
  db.orders.push(order);
  save();
  if (!online) {
    sms(phone, `سفارش شما ثبت شد. کد پیگیری: ${order.id}`);
    return json(res, 201, {id: order.id, total});
  }
  try {
    order.authority = await zpRequest(order);
    save();
    return json(res, 201, {id: order.id, total, payUrl: `${ZP_START}/pg/StartPay/${order.authority}`});
  } catch (e) {
    console.error('payment request error:', e.message);
    restoreStock(order);
    order.status = 'پرداخت ناموفق';
    save();
    return json(res, 502, {error: 'اتصال به درگاه پرداخت ناموفق بود. دوباره تلاش کنید'});
  }
}

async function login(req, res, ip) {
  const f = fails.get(ip) || {n: 0, until: 0};
  if (f.until > Date.now()) return json(res, 429, {error: 'تلاش زیاد؛ ۱۵ دقیقه صبر کنید'});
  const b = await readBody(req);
  const pw = typeof b.password === 'string' && b.password.length <= 200 ? b.password : '';
  if (!pw || !checkPass(pw, db.settings.adminHash)) {
    f.n++;
    if (f.n >= 5) { f.until = Date.now() + 15 * 60000; f.n = 0; }
    fails.set(ip, f);
    await sleep(400);
    return json(res, 401, {error: 'رمز اشتباه است'});
  }
  fails.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_MS);
  return json(res, 200, {ok: true}, {'Set-Cookie': cookie(token, SESSION_MS / 1000, isHttps(req))});
}

async function updateSettings(req, res) {
  const b = await readBody(req);
  const shop = str(b.shop, 60), phone = str(b.phone, 15), intro = str(b.intro, 200);
  const np = typeof b.newPassword === 'string' ? b.newPassword : '';
  if (!shop || !/^\d{7,15}$/.test(phone)) return json(res, 400, {error: 'اطلاعات نامعتبر'});
  if (np && (np.length < 10 || np.length > 200)) return json(res, 400, {error: 'رمز باید ۱۰ تا ۲۰۰ کاراکتر باشد'});
  Object.assign(db.settings, {shop, phone, intro});
  if (np) { db.settings.adminHash = hashPass(np); sessions.clear(); }
  save();
  return json(res, 200, {ok: true, passwordChanged: !!np});
}

async function adminApi(req, res, p, ip) {
  const m = req.method;
  if (m === 'POST' && p === '/api/admin/login') return login(req, res, ip);
  const sid = isAdmin(req);
  if (!sid) return json(res, 401, {error: 'ورود لازم است'});
  if (m === 'POST' && p === '/api/admin/logout') {
    sessions.delete(sid);
    return json(res, 200, {ok: true}, {'Set-Cookie': cookie('', 0, isHttps(req))});
  }
  if (m === 'GET' && p === '/api/admin/state')
    return json(res, 200, {settings: publicSettings(db.settings), products: db.products, orders: db.orders});
  if (m === 'PUT' && p === '/api/admin/settings') return updateSettings(req, res);
  if (m === 'POST' && p === '/api/admin/upload') return upload(req, res);
  if (m === 'POST' && p === '/api/admin/products') {
    const data = cleanProduct(await readBody(req));
    if (!data) return json(res, 400, {error: 'اطلاعات محصول نامعتبر است'});
    const prod = {id: 'p' + crypto.randomBytes(6).toString('hex'), ...data};
    db.products.push(prod); save();
    return json(res, 201, prod);
  }
  const pm = p.match(/^\/api\/admin\/products\/([A-Za-z0-9_-]{1,40})$/);
  if (pm) {
    const idx = db.products.findIndex(x => x.id === pm[1]);
    if (idx < 0) return json(res, 404, {error: 'یافت نشد'});
    if (m === 'PUT') {
      const data = cleanProduct(await readBody(req));
      if (!data) return json(res, 400, {error: 'اطلاعات محصول نامعتبر است'});
      db.products[idx] = {id: pm[1], ...data}; save();
      return json(res, 200, db.products[idx]);
    }
    if (m === 'DELETE') { db.products.splice(idx, 1); save(); return json(res, 200, {ok: true}); }
  }
  const om = p.match(/^\/api\/admin\/orders\/([A-Za-z0-9]{1,40})$/);
  if (om && m === 'PATCH') {
    const b = await readBody(req);
    const o = db.orders.find(x => x.id === om[1]);
    if (!o) return json(res, 404, {error: 'یافت نشد'});
    if (!STATUSES.includes(b.status)) return json(res, 400, {error: 'وضعیت نامعتبر'});
    o.status = b.status; save();
    return json(res, 200, {ok: true});
  }
  return json(res, 404, {error: 'یافت نشد'});
}

// ---------- SMS (Kavenegar) ----------
const KAVENEGAR_KEY = process.env.KAVENEGAR_KEY || '';
function sms(phone, text) {
  if (!KAVENEGAR_KEY) return;
  fetch(`https://api.kavenegar.com/v1/${encodeURIComponent(KAVENEGAR_KEY)}/sms/send.json`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({receptor: phone.replace(/\D/g, ''), message: text}).toString(),
  }).catch(e => console.error('SMS error:', e.message));
}

// ---------- Payment (Zarinpal v4) ----------
const ZP_BASE = ZP_SANDBOX ? 'https://sandbox.zarinpal.com' : 'https://payment.zarinpal.com';
const ZP_START = ZP_SANDBOX ? 'https://sandbox.zarinpal.com' : 'https://www.zarinpal.com';
const restoreStock = o => o.items.forEach(l => { const p = db.products.find(x => x.id === l.id); if (p) p.stock += l.qty; });
async function zpPost(endpoint, body) {
  const r = await fetch(ZP_BASE + endpoint, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
    body: JSON.stringify(body),
  });
  return r.json();
}
async function zpRequest(o) {
  const d = await zpPost('/pg/v4/payment/request.json', {
    merchant_id: ZP_MERCHANT, amount: o.total * ZP_UNIT,
    callback_url: `${PUBLIC_URL}/api/pay/callback?order=${encodeURIComponent(o.id)}`,
    description: 'سفارش ' + o.id, metadata: {mobile: o.phone},
  });
  if (!d.data || d.data.code !== 100) throw new Error('zarinpal request failed');
  return d.data.authority;
}
async function payCallback(res, url) {
  const id = url.searchParams.get('order') || '', auth = url.searchParams.get('Authority') || '';
  const go = v => { res.writeHead(302, {...SEC, Location: '/?paid=' + encodeURIComponent(v)}); res.end(); };
  const o = db.orders.find(x => x.id === id);
  if (!o) return go('fail');
  if (o.status === 'پرداخت شده') return go(o.id);
  if (o.status !== 'در انتظار پرداخت' || o.authority !== auth) return go('fail');

  let verified = false, ref = '';
  if (url.searchParams.get('Status') === 'OK') {
    try {
      const d = await zpPost('/pg/v4/payment/verify.json', {merchant_id: ZP_MERCHANT, amount: o.total * ZP_UNIT, authority: auth});
      verified = !!d.data && (d.data.code === 100 || d.data.code === 101);
      ref = d.data ? String(d.data.ref_id ?? '') : '';
    } catch (e) { console.error('verify error:', e.message); }
  }
  if (verified) {
    o.status = 'پرداخت شده'; o.refId = ref; save();
    sms(o.phone, `پرداخت سفارش ${o.id} با موفقیت انجام شد. از خرید شما متشکریم.`);
    return go(o.id);
  }
  restoreStock(o); o.status = 'پرداخت ناموفق'; save();
  return go('fail');
}

// ---------- Image upload (validated by magic bytes) ----------
const UPLOADS = path.join(PUB, 'uploads');
async function upload(req, res) {
  const b = await readBody(req, 3 * 1024 * 1024);
  const m = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.data || '');
  if (!m) return json(res, 400, {error: 'فرمت تصویر نامعتبر است'});
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > 2 * 1024 * 1024) return json(res, 413, {error: 'حجم تصویر بیش از ۲ مگابایت است'});
  const head = buf.subarray(0, 12);
  const ok = (m[2] === 'jpeg' && head[0] === 0xff && head[1] === 0xd8) ||
             (m[2] === 'png' && head.subarray(0, 4).toString('hex') === '89504e47') ||
             (m[2] === 'webp' && head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP');
  if (!ok) return json(res, 400, {error: 'محتوای فایل تصویر معتبر نیست'});
  const ext = {jpeg: 'jpg', png: 'png', webp: 'webp'}[m[2]];
  const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
  fs.mkdirSync(UPLOADS, {recursive: true});
  fs.writeFileSync(path.join(UPLOADS, name), buf);
  return json(res, 201, {url: '/uploads/' + name});
}

async function api(req, res, url) {
  const m = req.method, p = url.pathname, ip = clientIp(req);
  if (m !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json'))
    return json(res, 415, {error: 'نوع درخواست نامعتبر'});
  if (m === 'GET' && p === '/api/shop')
    return json(res, 200, {settings: publicSettings(db.settings), products: db.products});
  if (m === 'POST' && p === '/api/orders') return createOrder(req, res, ip);
  if (m === 'GET' && p === '/api/pay/callback') return payCallback(res, url);
  if (p.startsWith('/api/admin/')) return adminApi(req, res, p, ip);
  return json(res, 404, {error: 'یافت نشد'});
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, {error: 'روش نامعتبر'});
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return json(res, 400, {error: 'مسیر نامعتبر'}); }
  if (p === '/') p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep)) return json(res, 403, {error: 'دسترسی ممنوع'});
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, {error: 'یافت نشد'});
    res.writeHead(200, {...SEC, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (typeof e.code === 'number') return json(res, e.code, {error: e.message});
    console.error(e);
    return json(res, 500, {error: 'خطای داخلی سرور'});
  }
});

server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.listen(PORT, () => console.log(`Shop running on http://localhost:${PORT}`));
