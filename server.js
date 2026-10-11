'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const app = express();
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 10000);
const ADMIN_KEY = String(process.env.ADMIN_KEY || '');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const STORAGE_API_BASE = String(process.env.PORTAL_STORAGE_API || '').replace(/\/+$/, '');
const STORAGE_API_KEY = String(process.env.MIS_LIBROS_INTERNAL_KEY || '');

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

async function storageRequest(route, options = {}) {
  if (!STORAGE_API_BASE || !STORAGE_API_KEY) {
    const error = new Error('El almacenamiento persistente no está configurado.');
    error.status = 503;
    throw error;
  }

  const headers = {
    'x-mis-libros-key': STORAGE_API_KEY,
    ...(options.body ? {'Content-Type':'application/json'} : {}),
    ...(options.headers || {})
  };

  let response;
  try {
    response = await fetch(STORAGE_API_BASE + route, {
      ...options,
      headers,
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    const error = new Error('El almacenamiento persistente no está disponible temporalmente.');
    error.status = 503;
    throw error;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Error del almacenamiento persistente.');
    error.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    throw error;
  }
  return data;
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cookieParser());
app.use(express.json({ limit: '400kb' }));
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

app.get('/healthz', async (req, res) => {
  try {
    const storage = await storageRequest('/status');
    res.json({
      ok: true,
      storageBackend: 'Portal IA',
      persistentStorage: Boolean(storage.persistentStorage),
      database: storage.database || null
    });
  } catch (error) {
    res.status(503).json({ ok:false, error:error.message });
  }
});

app.get('/api/books', async (req, res) => {
  try {
    const data = await storageRequest('/books', { method:'GET' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ books: Array.isArray(data.books) ? data.books : null });
  } catch (error) {
    res.status(error.status || 503).json({ error:error.message });
  }
});

app.post('/api/downloads', downloadLimiter, async (req, res) => {
  if (!verifySameOrigin(req)) return res.status(403).json({ error: 'Origen no permitido.' });

  const bookId = Number(req.body.bookId);
  const bookTitle = cleanText(req.body.bookTitle, 220);
  const name = cleanText(req.body.name, 160);
  const phone = cleanText(req.body.phone, 80);
  const consent = req.body.consent === true;

  if (!bookTitle || !name || !phone || !consent) {
    return res.status(400).json({ error: 'Nombre, teléfono y autorización son obligatorios.' });
  }

  try {
    const data = await storageRequest('/downloads', {
      method:'POST',
      body:JSON.stringify({
        bookId:Number.isFinite(bookId) ? bookId : null,
        bookTitle,
        name,
        phone,
        consent:true
      })
    });
    res.status(201).json(data);
  } catch (error) {
    res.status(error.status || 503).json({ error:error.message });
  }
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

app.get('/api/admin/downloads', requireAdmin, async (req, res) => {
  try {
    const data = await storageRequest('/downloads', { method:'GET' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ downloads: Array.isArray(data.downloads) ? data.downloads : [] });
  } catch (error) {
    res.status(error.status || 503).json({ error:error.message });
  }
});

app.put('/api/admin/books', requireAdmin, async (req, res) => {
  if (!verifySameOrigin(req)) return res.status(403).json({ error: 'Origen no permitido.' });
  const books = req.body.books;
  if (!Array.isArray(books) || books.length < 1 || books.length > 100) {
    return res.status(400).json({ error: 'Catálogo no válido.' });
  }

  try {
    const data = await storageRequest('/books', {
      method:'PUT',
      body:JSON.stringify({books})
    });
    res.json(data);
  } catch (error) {
    res.status(error.status || 503).json({ error:error.message });
  }
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
  console.log('Almacenamiento remoto: ' + (STORAGE_API_BASE || 'NO CONFIGURADO'));
});
