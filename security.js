/**
 * SEGURIDAD HTTP DEL PANEL
 *
 * Todo en memoria y O(1) por petición: no toca el camino del vídeo (data plane, FFmpeg, SRT).
 *
 * - Cabeceras: CSP, anti-iframe, nosniff, Referrer-Policy, Permissions-Policy y, con HTTPS, HSTS.
 *   Las respuestas de /api no se guardan en caché (llevan URLs con passphrase, usuarios...).
 * - CSRF: además de la cookie SameSite=Strict, las peticiones que cambian algo (POST, PUT, DELETE...)
 *   tienen que venir del propio panel (cabecera Origin/Referer). Así tampoco puede mandarlas la web
 *   de un encoder abierta por el proxy (mismo equipo, otro puerto: el navegador sí le pasa la cookie).
 * - Límite de peticiones a /api por IP (ventana de 1 minuto). Vídeo, audio, HLS y miniaturas no cuentan.
 * - Vigilancia: escaneos típicos (/.env, /wp-admin...), CSRF rechazado, 401/403/429 repetidos.
 *   Si una IP pasa del umbral, aviso en el log y por Telegram (uno cada 30 min por IP).
 * - Errores: el cliente nunca ve trazas ni rutas internas.
 * - Al arrancar revisa la configuración (NODE_ENV, HTTPS, METRICS_TOKEN, permisos del .env).
 *
 * Variables opcionales: RATE_LIMIT_PER_MIN (600), RATE_LIMIT_WRITES_PER_MIN (120),
 * TRUSTED_ORIGINS (orígenes extra permitidos, separados por comas, p. ej. un proxy inverso).
 */
const fs = require('fs');
const path = require('path');
const tlsConfig = require('./tlsConfig');

const PROD = process.env.NODE_ENV === 'production';

// Texto seguro para el log: sin saltos de línea ni caracteres de control (evita falsear entradas)
const clean = (v, max = 80) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, max);

/* =======================================
 *  CABECERAS
 * ======================================= */
// El panel usa onclick="..." y style="..." en el HTML: 'unsafe-inline' es imprescindible.
// Aun así, la CSP impide cargar scripts de otros dominios, enviar datos fuera ni meter el panel en un iframe.
const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:", // hls.js
    "font-src 'self' data:",
    "connect-src 'self'", // API y socket (ws/wss del mismo origen)
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
].join('; ');

// HSTS sólo si todo el equipo va por HTTPS: el navegador lo aplica a todos los puertos del nombre,
// y Grafana por HTTP (GRAFANA_PROTOCOL distinto de https) dejaría de abrir. Con IP no se aplica nunca.
const HSTS = tlsConfig.enabled && !(process.env.GRAFANA_PORT && process.env.GRAFANA_PROTOCOL !== 'https');

function headers(req, res, next) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (HSTS) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
}

/* =======================================
 *  CSRF: MISMO ORIGEN
 * ======================================= */
const TRUSTED = new Set((process.env.TRUSTED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean));
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// true si la petición viene del propio panel. Sin Origin ni Referer (curl, scripts) se acepta:
// los navegadores siempre mandan Origin en POST/PUT/DELETE y en los WebSocket.
function sameOrigin(h) {
    const src = h.origin || h.referer;
    if (!src) return true;
    if (src === 'null') return false;
    try {
        const u = new URL(src);
        return u.host === h.host || TRUSTED.has(u.origin);
    } catch (e) {
        return false;
    }
}

function csrf(req, res, next) {
    if (SAFE_METHODS.has(req.method) || sameOrigin(req.headers)) return next();
    flag(req.ip, 10, `petición ${req.method} ${clean(req.path)} desde otro origen (${clean(req.headers.origin || req.headers.referer)})`);
    res.status(403).json({ error: 'Origen no permitido' });
}

/* =======================================
 *  LÍMITE DE PETICIONES
 * ======================================= */
const WINDOW_MS = 60 * 1000;
const LIMIT_ALL = parseInt(process.env.RATE_LIMIT_PER_MIN, 10) || 600;
const LIMIT_WRITES = parseInt(process.env.RATE_LIMIT_WRITES_PER_MIN, 10) || 120;
const counters = new Map(); // ip -> { start, all, writes }
// Flujos continuos (audio en directo, vídeo con saltos por rangos): no cuentan
const UNLIMITED = /^\/api\/(audio\/|media\/play$)/;

function rateLimit(req, res, next) {
    if (!req.path.startsWith('/api/') || UNLIMITED.test(req.path)) return next();
    const now = Date.now();
    let c = counters.get(req.ip);
    if (!c || now - c.start >= WINDOW_MS) {
        c = { start: now, all: 0, writes: 0 };
        counters.set(req.ip, c);
    }
    c.all++;
    if (!SAFE_METHODS.has(req.method)) c.writes++;
    if (c.all > LIMIT_ALL || c.writes > LIMIT_WRITES) {
        const wait = Math.ceil((c.start + WINDOW_MS - now) / 1000);
        res.setHeader('Retry-After', String(wait));
        return res.status(429).json({ error: `Demasiadas peticiones. Espera ${wait} s.` });
    }
    next();
}

/* =======================================
 *  ACTIVIDAD SOSPECHOSA
 * ======================================= */
const WATCH_WINDOW_MS = 10 * 60 * 1000;
const THRESHOLD = 30; // puntos en 10 min
const REALERT_MS = 30 * 60 * 1000;
const suspects = new Map(); // ip -> { start, score, reasons: Set, alerted }
// Rutas que sólo pide un escáner de vulnerabilidades: el panel no tiene nada parecido
const SCAN = /(^|\/)(\.env|\.git|\.svn|\.aws|\.ssh|\.htaccess|\.DS_Store|wp-(admin|login|content|includes)|wordpress|phpmyadmin|pma|xmlrpc\.php|cgi-bin|actuator|boaform|HNAP1|vendor\/phpunit|server-status|config\.json|backup|\.sql$|\.bak$|\.php$|\.asp$|\.aspx$|\.jsp$)/i;

const TRAVERSAL = /(^|[\/\\]|%2f|%5c)(\.|%2e){2}([\/\\]|%2f|%5c|$)|\\|%5c|%00/i;

function flag(ip, points, reason) {
    const now = Date.now();
    let s = suspects.get(ip);
    if (!s || now - s.start >= WATCH_WINDOW_MS) {
        s = { start: now, score: 0, reasons: new Set(), alerted: s ? s.alerted : 0 };
        suspects.set(ip, s);
    }
    s.score += points;
    if (s.reasons.size < 5) s.reasons.add(reason);
    if (s.score >= THRESHOLD && now - s.alerted >= REALERT_MS) {
        s.alerted = now;
        const why = [...s.reasons].join('; ');
        console.warn(`[SECURITY] ⚠️ Actividad sospechosa desde ${ip}: ${why}`);
        try {
            require('./telegram').notify(`🚨 Actividad sospechosa en el panel desde ${ip}: ${why}.`, { important: true });
        } catch (e) { /* Telegram no disponible */ }
    }
}

// Va el primero: también ve las peticiones que acaban en el login o en un 404
function watch(req, res, next) {
    // "/images/../index.html" saltaría el login por un prefijo público. Los navegadores nunca
    // mandan ".." ni "\" en la ruta: sólo lo hace quien está probando
    if (TRAVERSAL.test(req.path)) {
        flag(req.ip, 5, `ruta con ".." (${clean(req.path, 60)})`);
        return res.status(400).end();
    }
    if (SCAN.test(req.path)) {
        flag(req.ip, 5, `busca ${clean(req.path, 60)}`);
        return res.status(404).end();
    }
    res.on('finish', () => {
        const code = res.statusCode;
        if (code === 401 && req.path === '/api/auth/login') flag(req.ip, 3, 'contraseñas incorrectas');
        else if (code === 401) flag(req.ip, 1, 'peticiones sin sesión');
        else if (code === 403) flag(req.ip, 2, `accesos denegados${req.user ? ` (usuario ${clean(req.user.username, 32)})` : ''}`);
        else if (code === 429) flag(req.ip, 1, 'supera el límite de peticiones');
    });
    next();
}

// Limpieza de contadores viejos para que la memoria no crezca con IPs que ya no vuelven
setInterval(() => {
    const now = Date.now();
    for (const [ip, c] of counters) if (now - c.start >= WINDOW_MS) counters.delete(ip);
    for (const [ip, s] of suspects) if (now - s.start >= WATCH_WINDOW_MS && now - s.alerted >= REALERT_MS) suspects.delete(ip);
}, 60 * 1000).unref();

/* =======================================
 *  ERRORES
 * ======================================= */
// Express sin este manejador enseña la traza (rutas del servidor) fuera de producción
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
    const status = Number(err.status || err.statusCode) || 500;
    if (status >= 500) console.error(`[HTTP] ${req.method} ${clean(req.path)}:`, err && err.stack ? err.stack : err);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status >= 500 ? 'Error interno del servidor' : 'Petición no válida' });
}

/* =======================================
 *  REVISIÓN DE LA CONFIGURACIÓN AL ARRANCAR
 * ======================================= */
function audit() {
    const warn = (m) => console.warn(`[SECURITY] ⚠️ ${m}`);
    if (!PROD) warn('NODE_ENV no es "production": modo desarrollo (más trazas en el log). En el servidor debe ser production.');
    if (!tlsConfig.enabled) warn('Panel por HTTP: usuarios y contraseñas viajan sin cifrar por la red. Configura TLS_CERT_FILE y TLS_KEY_FILE.');
    const token = process.env.METRICS_TOKEN || '';
    if (token && token.length < 24) warn('METRICS_TOKEN es corto (menos de 24 caracteres). Genera uno con: openssl rand -hex 24');
    if (process.platform !== 'win32') {
        const envFile = path.join(__dirname, '.env');
        try {
            if (fs.statSync(envFile).mode & 0o077) {
                fs.chmodSync(envFile, 0o600);
                console.log('[SECURITY] .env sólo legible por su propietario (chmod 600)');
            }
        } catch (e) { /* sin .env (Docker) */ }
    }
}

module.exports = { headers, csrf, rateLimit, watch, errorHandler, audit, sameOrigin, _test: { flag, suspects, counters, clean } };
