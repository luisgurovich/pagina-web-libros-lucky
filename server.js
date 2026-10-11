'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');

const app = express();
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const STORAGE_DIR = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : ROOT;
const DATA_DIR = path.join(STORAGE_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'mis-libros.db');
const PORT = Number(process.env.PORT || 10000);
const ADMIN_KEY = String(process.env.ADMIN_KEY || '');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER,
    book_title TEXT NOT NULL,
    reader_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    consent INTEGER NOT NULL CHECK(consent IN (0,1)),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads(created_at);
  CREATE INDEX IF NOT EXISTS idx_downloads_book ON downloads(book_id, book_title);
  CREATE INDEX IF NOT EXISTS idx_downloads_phone ON downloads(phone);
`);

const insertDownload = db.prepare(`
  INSERT INTO downloads (book_id, book_title, reader_name, phone, consent, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const listDownloads = db.prepare(`
  SELECT id, book_id AS bookId, book_title AS bookTitle,
         reader_name AS name, phone, created_at AS date
  FROM downloads
  ORDER BY created_at DESC, id DESC
`);
const getBooksSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsertBooksSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at)
  VALUES ('books', ?, ?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
`);

function nowIso() {
  return new Date().toISOString();
}

function safeEqualText(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function sign(value) {
  return crypto.createHmac('sha256', ADMIN_KEY || 'invalid-admin-key').update(value).digest('base64url');
}

function createAdminToken() {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + 8 * 60 * 60 * 1000,
    nonce: crypto.randomBytes(12).toString('hex')
  }), 'utf8').toString('base64url');
  return payload + '.' + sign(payload);
}

function verifyAdminToken(token) {
  try {
    const [payload, signature] = String(token || '').split('.');
    if (!payload || !signature) return false;
    const expected = sign(payload);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(decoded.exp) > Date.now();
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  if (!verifyAdminToken(req.cookies.mis_libros_admin)) {
    return res.status(401).json({ error: 'Sesión administrativa no válida o vencida.' });
  }
  next();
}

function verifySameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

function cleanText(value, max) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cookieParser());
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

const downloadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    storage: STORAGE_DIR,
    persistentStorageConfigured: Boolean(process.env.STORAGE_DIR)
  });
});

app.get('/api/books', (req, res) => {
  const row = getBooksSetting.get('books');
  if (!row) return res.json({ books: null });
  try {
    const books = JSON.parse(row.value);
    return res.json({ books: Array.isArray(books) ? books : null });
  } catch {
    return res.json({ books: null });
  }
});

app.post('/api/downloads', downloadLimiter, (req, res) => {
  if (!verifySameOrigin(req)) return res.status(403).json({ error: 'Origen no permitido.' });

  const bookId = Number(req.body.bookId);
  const bookTitle = cleanText(req.body.bookTitle, 220);
  const name = cleanText(req.body.name, 160);
  const phone = cleanText(req.body.phone, 80);
  const consent = req.body.consent === true;

  if (!bookTitle || !name || !phone || !consent) {
    return res.status(400).json({ error: 'Nombre, teléfono y autorización son obligatorios.' });
  }

  const date = nowIso();
  insertDownload.run(Number.isFinite(bookId) ? bookId : null, bookTitle, name, phone, 1, date);
  res.status(201).json({ ok: true, date });
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  if (!verifySameOrigin(req)) return res.status(403).json({ error: 'Origen no permitido.' });
  const key = String(req.body.key || '');
  if (!ADMIN_KEY || !safeEqualText(key, ADMIN_KEY)) {
    return res.status(401).json({ error: 'Clave administrativa incorrecta.' });
  }
  res.cookie('mis_libros_admin', createAdminToken(), {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PRODUCTION,
    maxAge: 8 * 60 * 60 * 1000,
    path: '/api/admin'
  });
  res.json({ ok: true });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  res.clearCookie('mis_libros_admin', { path: '/api/admin' });
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ authenticated: verifyAdminToken(req.cookies.mis_libros_admin) });
});

app.get('/api/admin/downloads', requireAdmin, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ downloads: listDownloads.all() });
});

app.put('/api/admin/books', requireAdmin, (req, res) => {
  if (!verifySameOrigin(req)) return res.status(403).json({ error: 'Origen no permitido.' });
  const books = req.body.books;
  if (!Array.isArray(books) || books.length < 1 || books.length > 100) {
    return res.status(400).json({ error: 'Catálogo no válido.' });
  }
  const sanitized = books.map((book, index) => ({
    id: Number.isFinite(Number(book.id)) ? Number(book.id) : index + 1,
    code: cleanText(book.code, 20),
    genre: cleanText(book.genre, 160),
    title: cleanText(book.title, 240),
    subtitle: cleanText(book.subtitle, 240),
    desc: String(book.desc || '').trim().slice(0, 4000),
    pdfUrl: String(book.pdfUrl || '').trim().slice(0, 1200),
    cover: String(book.cover || '').slice(0, 300000)
  }));
  upsertBooksSetting.run(JSON.stringify(sanitized), nowIso());
  res.json({ ok: true, books: sanitized });
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  etag: true,
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (path.extname(filePath).toLowerCase() === '.html') {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Mis Libros IA activo en puerto ' + PORT);
  console.log('Base de datos: ' + DB_FILE);
  console.log('Almacenamiento persistente configurado: ' + Boolean(process.env.STORAGE_DIR));
});
