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
const PUBLIC_BASE_URL = 'https://mis-libros-ia-publico-luis-gurovich.onrender.com';
const SEO_BOOKS_FILE = path.join(PUBLIC_DIR, 'books-seo.json');
const PUBLIC_FRONTEND_ORIGIN = 'https://mis-libros-ia-publico-luis-gurovich.onrender.com';

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

function verifyPublicOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host') || origin === PUBLIC_FRONTEND_ORIGIN;
  } catch {
    return false;
  }
}

function publicCors(req, res, next) {
  const origin = req.get('origin');
  if (origin === PUBLIC_FRONTEND_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', PUBLIC_FRONTEND_ORIGIN);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function cleanText(value, max) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'libro';
}

function canonicalBookPath(book) {
  const code = String(book.code || book.id || '').padStart(3, '0');
  return '/libros/' + code + '-' + slugify(book.title);
}

function loadFallbackSeoBooks() {
  try {
    const raw = require('fs').readFileSync(SEO_BOOKS_FILE, 'utf8');
    const books = JSON.parse(raw);
    return Array.isArray(books) ? books : [];
  } catch {
    return [];
  }
}

async function getPublicBooks() {
  try {
    const data = await storageRequest('/books', { method:'GET' });
    if (Array.isArray(data.books) && data.books.length) return data.books;
  } catch {}
  return loadFallbackSeoBooks();
}

function renderBookSeoPage(book) {
  const canonicalPath = canonicalBookPath(book);
  const canonicalUrl = PUBLIC_BASE_URL + canonicalPath;
  const title = cleanText(book.title, 220);
  const description = cleanText(book.detailDescription || book.desc, 1000);
  const genre = cleanText(book.genre, 220);
  const subtitle = cleanText(book.subtitle, 220);
  const code = cleanText(book.code, 20);

  const schema = {
    '@context':'https://schema.org',
    '@type':'Book',
    name:title,
    description,
    genre:genre || undefined,
    author:{'@type':'Person', name:'Luis Gurovich'},
    url:canonicalUrl,
    isPartOf:{
      '@type':'CollectionPage',
      name:'Mis Libros IA — Luis Gurovich',
      url:PUBLIC_BASE_URL + '/'
    }
  };
  const jsonLd = JSON.stringify(schema).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — Luis Gurovich</title>
<meta name="description" content="${escapeHtml(description.slice(0, 300))}">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
<link rel="canonical" href="${canonicalUrl}">
<meta property="og:type" content="book">
<meta property="og:locale" content="es_CL">
<meta property="og:site_name" content="Mis Libros IA — Luis Gurovich">
<meta property="og:title" content="${escapeHtml(title)} — Luis Gurovich">
<meta property="og:description" content="${escapeHtml(description.slice(0, 300))}">
<meta property="og:url" content="${canonicalUrl}">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">${jsonLd}</script>
<style>
body{margin:0;background:#14141c;color:#ede7d9;font:17px/1.65 Georgia,serif}
main{max-width:820px;margin:0 auto;padding:64px 28px 80px}
a{color:#d9ab5f}
.eyebrow{font:12px/1.4 Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#d9ab5f}
h1{font-size:46px;line-height:1.05;margin:14px 0 10px}
.subtitle{font-style:italic;color:#ece4d1;margin:0 0 28px}
.meta{font:13px/1.5 Arial,sans-serif;color:#b9b2a5;margin-bottom:28px}
.card{background:#f3eee2;color:#1b1b22;padding:30px;border-radius:3px}
.cta{display:inline-block;margin-top:28px;background:#b98a3d;color:#14141c;text-decoration:none;padding:12px 18px;font:600 14px Arial,sans-serif}
.back{display:inline-block;margin-top:20px;font:14px Arial,sans-serif}
</style>
</head>
<body>
<main>
<div class="eyebrow">Luis Gurovich · Biblioteca digital</div>
<h1>${escapeHtml(title)}</h1>
${subtitle ? '<p class="subtitle">' + escapeHtml(subtitle) + '</p>' : ''}
<div class="meta">${code ? 'Código ' + escapeHtml(code) + ' · ' : ''}${genre ? escapeHtml(genre) : 'Libro digital'}</div>
<div class="card">
<h2>Acerca de este libro</h2>
<p>${escapeHtml(description)}</p>
<a class="cta" href="/#catalogo">Leer / descargar desde el catálogo</a>
</div>
<a class="back" href="/">← Volver a Mis Libros IA</a>
</main>
</body>
</html>`;
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

app.get('/robots.txt', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Allow: /\n' +
    'Sitemap: ' + PUBLIC_BASE_URL + '/sitemap.xml\n'
  );
});

app.get('/sitemap.xml', async (req, res) => {
  const books = await getPublicBooks();
  const urls = [
    PUBLIC_BASE_URL + '/',
    ...books.map(book => PUBLIC_BASE_URL + canonicalBookPath(book))
  ];
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(url => '  <url><loc>' + escapeHtml(url) + '</loc></url>').join('\n') +
    '\n</urlset>\n';
  res.type('application/xml').send(xml);
});

app.get('/libros/:bookRef', async (req, res) => {
  const books = await getPublicBooks();
  const ref = String(req.params.bookRef || '');
  const code = ref.split('-')[0];
  const book = books.find(item =>
    String(item.code || item.id || '').padStart(3, '0') === code ||
    slugify(item.title) === ref
  );
  if (!book) return res.status(404).send('Libro no encontrado.');

  const canonicalPath = canonicalBookPath(book);
  if (req.path !== canonicalPath) return res.redirect(301, canonicalPath);

  res.setHeader('Cache-Control', 'public, max-age=900');
  res.type('html').send(renderBookSeoPage(book));
});

app.use('/api', (req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

app.use('/api/books', publicCors);
app.use('/api/downloads', publicCors);

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
  if (!verifyPublicOrigin(req)) return res.status(403).json({ error: 'Origen no permitido.' });

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

async function migrateBook9PdfUrl() {
  const targetUrl = 'https://drive.google.com/uc?export=download&id=1I_7HylupyosrR-fe_m8WM3jmLyrQ3UMr';
  try {
    const data = await storageRequest('/books', { method:'GET' });
    if (!Array.isArray(data.books) || !data.books.length) return;
    const books = data.books.map(book => ({...book}));
    const book9 = books.find(book => Number(book.id) === 9 || String(book.code) === '009');
    if (!book9) return;
    if (book9.pdfUrl === targetUrl) {
      console.log('Libro 9: enlace PDF de Google Drive ya configurado.');
      return;
    }
    book9.pdfUrl = targetUrl;
    await storageRequest('/books', {
      method:'PUT',
      body:JSON.stringify({books})
    });
    console.log('Libro 9: enlace PDF migrado correctamente a Google Drive.');
  } catch (error) {
    console.error('No fue posible migrar el enlace PDF del libro 9: ' + error.message);
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('Mis Libros IA activo en puerto ' + PORT);
  console.log('Almacenamiento remoto: ' + (STORAGE_API_BASE || 'NO CONFIGURADO'));
  storageRequest('/status')
    .then(async status => {
      console.log('Almacenamiento persistente remoto verificado: ' + Boolean(status.persistentStorage));
      await migrateBook9PdfUrl();
    })
    .catch(error => console.error('No fue posible verificar el almacenamiento remoto: ' + error.message));
});
