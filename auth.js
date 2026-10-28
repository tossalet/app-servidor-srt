/**
 * AUTENTICACIÓN
 *
 * - Contraseñas con scrypt (sal aleatoria por usuario), formato: scrypt$<sal b64>$<hash b64>
 * - Sesión en cookie HttpOnly firmada con HMAC. El secreto vive en data/session.secret,
 *   así que reiniciar el servicio no desconecta a nadie.
 * - Cambiar la contraseña o borrar el usuario invalida sus sesiones al instante.
 * - Bloqueo progresivo por IP tras 5 intentos fallidos.
 *
 * Roles: 4 = Admin (todo), 16 = Operador (streams, sin usuarios, puertos ni borrar grabaciones).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const ROLE_ADMIN = 4;
const ROLE_USER = 16;
const VALID_ROLES = [ROLE_ADMIN, ROLE_USER];
const MIN_PASSWORD = 8;
const COOKIE = 'tsst_sid';
const SESSION_MS = (parseInt(process.env.SESSION_HOURS, 10) || 168) * 3600 * 1000; // 7 días
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;

// Secreto de firma persistente
const secretPath = path.join(db.dataDir, 'session.secret');
let secret;
try {
    secret = fs.readFileSync(secretPath);
} catch (e) {
    secret = crypto.randomBytes(32);
    fs.mkdirSync(db.dataDir, { recursive: true });
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
}

/* =======================================
 *  CONTRASEÑAS
 * ======================================= */
const isHashed = (stored) => typeof stored === 'string' && stored.startsWith('scrypt$');

function hashPassword(password) {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16);
        crypto.scrypt(String(password), salt, KEYLEN, SCRYPT, (err, key) => {
            if (err) return reject(err);
            resolve(`scrypt$${salt.toString('base64')}$${key.toString('base64')}`);
        });
    });
}

function verifyPassword(password, stored) {
    return new Promise((resolve) => {
        if (!isHashed(stored)) return resolve(false);
        const [, saltB64, hashB64] = stored.split('$');
        const expected = Buffer.from(hashB64, 'base64');
        crypto.scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, SCRYPT, (err, key) => {
            resolve(!err && crypto.timingSafeEqual(key, expected));
        });
    });
}

// Hash ficticio para que un usuario inexistente tarde lo mismo que uno real (no revela qué usuarios existen)
let dummyHash = null;
hashPassword(crypto.randomBytes(16).toString('hex')).then(h => { dummyHash = h; });

function validatePassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
        return `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`;
    }
    return null;
}

/* =======================================
 *  CACHÉ DE USUARIOS (tabla pequeña: evita una consulta por petición)
 * ======================================= */
const users = new Map(); // username -> { password, role, email, must_change }

function loadUsers() {
    return new Promise((resolve, reject) => {
        db.all('SELECT username, password, role, email, must_change FROM users', [], (err, rows) => {
            if (err) return reject(err);
            users.clear();
            rows.forEach(r => users.set(r.username, r));
            resolve();
        });
    });
}

const run = (sql, params) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { err ? reject(err) : resolve(this); });
});

// Cifra las contraseñas antiguas en texto plano. Las débiles o iguales al usuario se marcan para cambio.
async function init() {
    await db.ready;
    await loadUsers();
    let migrated = 0;
    for (const u of users.values()) {
        if (isHashed(u.password)) continue;
        const weak = u.password === u.username || u.password.length < MIN_PASSWORD;
        await run('UPDATE users SET password = ?, must_change = ? WHERE username = ?',
            [await hashPassword(u.password), weak ? 1 : u.must_change, u.username]);
        migrated++;
    }
    if (migrated) {
        console.log(`[AUTH] ${migrated} contraseña(s) migradas a scrypt`);
        await loadUsers();
    }
}

/* =======================================
 *  SESIONES (token firmado)
 * ======================================= */

// Huella de la contraseña actual: si cambia, los tokens antiguos dejan de valer
const passwordVersion = (stored) => crypto.createHash('sha256').update(stored).digest('base64url').slice(0, 12);

function sign(data) {
    return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function createToken(username) {
    const u = users.get(username);
    const payload = Buffer.from(JSON.stringify({ u: username, pv: passwordVersion(u.password), exp: Date.now() + SESSION_MS })).toString('base64url');
    return `${payload}.${sign(payload)}`;
}

// Devuelve el usuario de la sesión o null
function readToken(token) {
    if (!token || typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const sig = Buffer.from(token.slice(dot + 1));
    const good = Buffer.from(sign(payload));
    if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        const u = users.get(data.u);
        if (!u || data.exp < Date.now() || data.pv !== passwordVersion(u.password)) return null;
        return { username: u.username, role: u.role, email: u.email, mustChange: !!u.must_change };
    } catch (e) {
        return null;
    }
}

function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

const sessionFromHeaders = (headers) => readToken(parseCookies(headers.cookie)[COOKIE]);

function setSessionCookie(req, res, username) {
    res.cookie(COOKIE, createToken(username), {
        httpOnly: true,
        sameSite: 'strict', // Protege contra CSRF desde otras webs
        secure: req.secure,
        maxAge: SESSION_MS,
        path: '/'
    });
}

/* =======================================
 *  BLOQUEO POR FUERZA BRUTA
 * ======================================= */
const failures = new Map(); // ip -> { count, until }
const MAX_FAILS = 5;

function lockedFor(ip) {
    const f = failures.get(ip);
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}

function registerFailure(ip) {
    const f = failures.get(ip) || { count: 0, until: 0 };
    f.count++;
    if (f.count >= MAX_FAILS) {
        // 30 s, 60 s, 120 s... hasta 15 min
        f.until = Date.now() + Math.min(30000 * 2 ** (f.count - MAX_FAILS), 15 * 60 * 1000);
    }
    failures.set(ip, f);
}

/* =======================================
 *  MIDDLEWARE
 * ======================================= */

// Recursos accesibles sin sesión: la pantalla de login y lo que necesita para pintarse
const PUBLIC_PATHS = new Set(['/login.html', '/js/login.js', '/css/style.css', '/api/auth/login', '/api/status']);
const PUBLIC_PREFIXES = ['/images/'];
// Lo único que puede hacer un usuario con cambio de contraseña pendiente
const MUST_CHANGE_ALLOWED = new Set(['/api/auth/me', '/api/auth/password', '/api/auth/logout']);

function requireAuth(req, res, next) {
    if (PUBLIC_PATHS.has(req.path) || PUBLIC_PREFIXES.some(p => req.path.startsWith(p))) return next();

    const user = sessionFromHeaders(req.headers);
    if (!user) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autenticado' });
        return res.redirect('/login.html');
    }
    if (user.mustChange && !MUST_CHANGE_ALLOWED.has(req.path)) {
        if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'password_change_required' });
        return res.redirect('/login.html');
    }
    req.user = user;
    next();
}

function requireAdmin(req, res, next) {
    if (req.user && req.user.role === ROLE_ADMIN) return next();
    res.status(403).json({ error: 'Sólo administradores' });
}

// socket.io: sin sesión válida no hay telemetría
function socketAuth(socket, next) {
    const user = sessionFromHeaders(socket.request.headers);
    if (!user || user.mustChange) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
}

/* =======================================
 *  RUTAS
 * ======================================= */
function publicUser(u) {
    return { username: u.username, role: u.role, email: u.email || '', mustChange: !!u.must_change };
}

function countAdmins() {
    let n = 0;
    for (const u of users.values()) if (u.role === ROLE_ADMIN) n++;
    return n;
}

function registerRoutes(app, io) {
    // Cierra los websockets de un usuario (borrado o contraseña cambiada)
    const kickSockets = (username) => {
        for (const s of io.sockets.sockets.values()) {
            if (s.data.user && s.data.user.username === username) s.disconnect(true);
        }
    };

    app.post('/api/auth/login', async (req, res) => {
        const ip = req.ip;
        const wait = lockedFor(ip);
        if (wait) return res.status(429).json({ error: `Demasiados intentos. Espera ${wait} s.` });

        const { username, password } = req.body || {};
        const u = users.get(String(username || ''));
        const ok = await verifyPassword(password || '', u ? u.password : dummyHash);
        if (!u || !ok) {
            registerFailure(ip);
            console.warn(`[AUTH] Login fallido para "${username}" desde ${ip}`);
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        }
        failures.delete(ip);
        setSessionCookie(req, res, u.username);
        console.log(`[AUTH] Login de ${u.username} desde ${ip}`);
        res.json(publicUser(u));
    });

    app.post('/api/auth/logout', (req, res) => {
        res.clearCookie(COOKIE, { path: '/' });
        res.json({ ok: true });
    });

    app.get('/api/auth/me', (req, res) => {
        res.json(publicUser(users.get(req.user.username)));
    });

    // Cambio de la propia contraseña (pide la actual)
    app.post('/api/auth/password', async (req, res) => {
        const { currentPassword, newPassword } = req.body || {};
        const u = users.get(req.user.username);
        if (!(await verifyPassword(currentPassword || '', u.password))) {
            return res.status(400).json({ error: 'La contraseña actual no es correcta' });
        }
        const invalid = validatePassword(newPassword);
        if (invalid) return res.status(400).json({ error: invalid });
        if (newPassword === currentPassword) return res.status(400).json({ error: 'La nueva contraseña debe ser distinta' });

        await run('UPDATE users SET password = ?, must_change = 0 WHERE username = ?', [await hashPassword(newPassword), u.username]);
        await loadUsers();
        kickSockets(u.username); // Otras sesiones abiertas quedan invalidadas
        setSessionCookie(req, res, u.username); // Esta sigue activa con el token nuevo
        res.json({ ok: true });
    });

    /* ---------- Gestor de usuarios (sólo admin) ---------- */

    app.get('/api/users', requireAdmin, (req, res) => {
        res.json([...users.values()].map(publicUser).sort((a, b) => a.username.localeCompare(b.username)));
    });

    app.post('/api/users', requireAdmin, async (req, res) => {
        const { username, password, email } = req.body || {};
        const role = parseInt(req.body.role, 10) || ROLE_USER;
        if (!username || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
            return res.status(400).json({ error: 'Usuario: 3-32 caracteres (letras, números, . _ -)' });
        }
        if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Rol no válido' });
        const invalid = validatePassword(password);
        if (invalid) return res.status(400).json({ error: invalid });
        if (users.has(username)) return res.status(409).json({ error: 'Ese usuario ya existe' });

        // must_change opcional: el admin da una contraseña temporal y el usuario la cambia al entrar
        await run('INSERT INTO users (username, password, role, email, must_change) VALUES (?, ?, ?, ?, ?)',
            [username, await hashPassword(password), role, email || '', req.body.mustChange ? 1 : 0]);
        await loadUsers();
        console.log(`[AUTH] ${req.user.username} creó el usuario ${username}`);
        res.status(201).json(publicUser(users.get(username)));
    });

    // Editar rol, email o restablecer contraseña
    app.put('/api/users/:username', requireAdmin, async (req, res) => {
        const u = users.get(req.params.username);
        if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });

        const role = req.body.role !== undefined ? parseInt(req.body.role, 10) : u.role;
        if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Rol no válido' });
        if (u.role === ROLE_ADMIN && role !== ROLE_ADMIN && countAdmins() <= 1) {
            return res.status(400).json({ error: 'Debe quedar al menos un administrador' });
        }
        const email = req.body.email !== undefined ? String(req.body.email) : u.email;

        let password = u.password;
        let mustChange = req.body.mustChange !== undefined ? (req.body.mustChange ? 1 : 0) : u.must_change;
        if (req.body.password) {
            const invalid = validatePassword(req.body.password);
            if (invalid) return res.status(400).json({ error: invalid });
            password = await hashPassword(req.body.password);
        }

        await run('UPDATE users SET role = ?, email = ?, password = ?, must_change = ? WHERE username = ?',
            [role, email, password, mustChange, u.username]);
        await loadUsers();
        if (password !== u.password) kickSockets(u.username);
        console.log(`[AUTH] ${req.user.username} editó el usuario ${u.username}`);
        res.json(publicUser(users.get(u.username)));
    });

    app.delete('/api/users/:username', requireAdmin, async (req, res) => {
        const u = users.get(req.params.username);
        if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
        if (u.username === req.user.username) return res.status(400).json({ error: 'No puedes borrar tu propia cuenta' });
        if (u.role === ROLE_ADMIN && countAdmins() <= 1) return res.status(400).json({ error: 'Debe quedar al menos un administrador' });

        await run('DELETE FROM users WHERE username = ?', [u.username]);
        await loadUsers();
        kickSockets(u.username);
        console.log(`[AUTH] ${req.user.username} borró el usuario ${u.username}`);
        res.json({ deleted: 1 });
    });
}

module.exports = {
    init,
    requireAuth,
    requireAdmin,
    socketAuth,
    sessionFromHeaders,
    registerRoutes,
    ROLE_ADMIN,
    ROLE_USER
};
