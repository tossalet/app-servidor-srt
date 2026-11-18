/**
 * AUTENTICACIÓN
 *
 * - Contraseñas con scrypt (sal aleatoria por usuario), formato: scrypt$<sal b64>$<hash b64>
 * - Sesión en cookie HttpOnly firmada con HMAC. El secreto (data/session.secret) y la lista de
 *   sesiones vivas (tabla sessions) persisten, así que reiniciar el servicio no desconecta a nadie.
 * - La sesión termina al cerrar el navegador o salir de él en el móvil: si ningún panel sigue
 *   conectado ni hay peticiones durante SESSION_GRACE_SECONDS, el servidor la revoca. El margen
 *   permite recargar la página y aguanta cortes breves de red.
 * - Cambiar la contraseña o borrar el usuario invalida sus sesiones al instante.
 * - Bloqueo progresivo por IP tras 5 intentos fallidos.
 *
 * Roles: 4 = Admin (todo), 16 = Operador (streams, sin usuarios, puertos ni borrar grabaciones).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const access = require('./access'); // access.js no importa auth.js: sin ciclo

const ROLE_ADMIN = 4;
const ROLE_USER = 16;
const VALID_ROLES = [ROLE_ADMIN, ROLE_USER];
const MIN_PASSWORD = 8;
const COOKIE = 'tsst_sid';
const SESSION_MS = (parseInt(process.env.SESSION_HOURS, 10) || 168) * 3600 * 1000; // Máximo absoluto: 7 días
const GRACE_MS = (parseInt(process.env.SESSION_GRACE_SECONDS, 10) || 60) * 1000; // Sin panel conectado
const MUST_CHANGE_GRACE_MS = 15 * 60 * 1000; // El formulario de cambio de contraseña no abre socket
const SWEEP_MS = 10 * 1000;
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

const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});
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
    // Tras un reinicio, los paneles abiertos tienen el margen completo para reconectar
    const now = Date.now();
    for (const s of await all('SELECT sid, username, pv, exp FROM sessions')) {
        sessions.set(s.sid, { username: s.username, pv: s.pv, exp: s.exp, lastSeen: now, sockets: new Set() });
    }
    setInterval(sweepSessions, SWEEP_MS).unref();
}

/* =======================================
 *  SESIONES (token firmado + lista de sesiones vivas)
 * ======================================= */
const sessions = new Map(); // sid -> { username, pv, exp, lastSeen, sockets }

// Huella de la contraseña actual: si cambia, los tokens antiguos dejan de valer
const passwordVersion = (stored) => crypto.createHash('sha256').update(stored).digest('base64url').slice(0, 12);

function sign(data) {
    return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

function createToken(username) {
    const u = users.get(username);
    const sid = crypto.randomBytes(16).toString('base64url');
    const pv = passwordVersion(u.password);
    const exp = Date.now() + SESSION_MS;
    sessions.set(sid, { username, pv, exp, lastSeen: Date.now(), sockets: new Set() });
    run('INSERT INTO sessions (sid, username, pv, exp) VALUES (?, ?, ?, ?)', [sid, username, pv, exp])
        .catch(err => console.error('[AUTH] No se pudo guardar la sesión:', err.message));
    const payload = Buffer.from(JSON.stringify({ u: username, sid, pv, exp })).toString('base64url');
    return `${payload}.${sign(payload)}`;
}

// Revoca la sesión y expulsa sus paneles, que al recargar acaban en el login
function revokeSession(sid) {
    const s = sessions.get(sid);
    if (!s) return;
    sessions.delete(sid);
    for (const socket of s.sockets) socket.disconnect(true);
    run('DELETE FROM sessions WHERE sid = ?', [sid])
        .catch(err => console.error('[AUTH] No se pudo borrar la sesión:', err.message));
}

function sweepSessions() {
    const now = Date.now();
    for (const [sid, s] of sessions) {
        const u = users.get(s.username);
        if (!u || s.exp < now || s.pv !== passwordVersion(u.password)) {
            revokeSession(sid);
        } else if (s.sockets.size) {
            s.lastSeen = now;
        } else if (now - s.lastSeen > (u.must_change ? MUST_CHANGE_GRACE_MS : GRACE_MS)) {
            revokeSession(sid);
            console.log(`[AUTH] Sesión de ${s.username} cerrada: el navegador ya no está conectado`);
        }
    }
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
        const session = sessions.get(data.sid);
        if (!session || !u || data.exp < Date.now() || data.pv !== passwordVersion(u.password)) return null;
        session.lastSeen = Date.now();
        return { username: u.username, role: u.role, email: u.email, mustChange: !!u.must_change, sid: data.sid };
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
    // Sin maxAge: cookie de sesión, el navegador la descarta al cerrarse
    res.cookie(COOKIE, createToken(username), {
        httpOnly: true,
        sameSite: 'strict', // Protege contra CSRF desde otras webs
        secure: req.secure,
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
const PUBLIC_PATHS = new Set(['/login.html', '/js/login.js', '/css/style.css', '/favicon.svg', '/api/auth/login', '/api/status']);
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
    // La sesión sigue viva mientras tenga al menos un panel conectado
    const session = sessions.get(user.sid);
    session.sockets.add(socket);
    socket.on('disconnect', () => {
        session.sockets.delete(socket);
        session.lastSeen = Date.now();
    });
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
            require('./telegram').login(username, ip, false);
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        }
        failures.delete(ip);
        setSessionCookie(req, res, u.username);
        console.log(`[AUTH] Login de ${u.username} desde ${ip}`);
        require('./telegram').login(u.username, ip, true);
        res.json(publicUser(u));
    });

    app.post('/api/auth/logout', (req, res) => {
        revokeSession(req.user.sid);
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
        // Contraseña nueva: sesiones fuera. Rol nuevo: se cierra el socket y el panel se recarga con el rol actual
        if (password !== u.password || role !== u.role) kickSockets(u.username);
        console.log(`[AUTH] ${req.user.username} editó el usuario ${u.username}`);
        res.json(publicUser(users.get(u.username)));
    });

    app.delete('/api/users/:username', requireAdmin, async (req, res) => {
        const u = users.get(req.params.username);
        if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
        if (u.username === req.user.username) return res.status(400).json({ error: 'No puedes borrar tu propia cuenta' });
        if (u.role === ROLE_ADMIN && countAdmins() <= 1) return res.status(400).json({ error: 'Debe quedar al menos un administrador' });

        // Sus entradas pasan al admin que lo borra y sus asignaciones desaparecen
        await access.dropUser(u.username, req.user.username);
        await run('DELETE FROM users WHERE username = ?', [u.username]);
        await loadUsers();
        kickSockets(u.username);
        console.log(`[AUTH] ${req.user.username} borró el usuario ${u.username}`);
        io.emit('db_update', { event: 'inputs_changed' });
        res.json({ deleted: 1 });
    });

    /* ---------- Entradas de cada usuario (sólo admin) ---------- */

    // owned: las que ha creado (o le han pasado); assigned: las que el admin le deja ver
    app.get('/api/users/:username/access', requireAdmin, (req, res) => {
        const u = users.get(req.params.username);
        if (!u) return res.status(404).json({ error: 'Not found' });
        res.json({
            owned: access.ownedBy(u.username).map(Number),
            assigned: access.grantsOf(u.username).map(Number),
            encoders: access.encodersOf(u.username),
        });
    });

    // Sustituye las asignaciones. Se ignoran los canales que no existen y los que ya son suyos.
    app.put('/api/users/:username/access', requireAdmin, async (req, res) => {
        const u = users.get(req.params.username);
        if (!u) return res.status(404).json({ error: 'Not found' });
        const list = req.body && req.body.channels;
        if (!Array.isArray(list)) return res.status(400).json({ error: 'channels debe ser una lista' });
        const encList = req.body.encoders;
        if (encList !== undefined && !Array.isArray(encList)) return res.status(400).json({ error: 'encoders debe ser una lista' });

        const existing = new Set((await all('SELECT channel FROM inputs')).map(r => Number(r.channel)));
        const owned = new Set(access.ownedBy(u.username).map(Number));
        const channels = list.map(Number).filter(ch => Number.isInteger(ch) && existing.has(ch) && !owned.has(ch));

        await access.setGrants(u.username, channels);
        console.log(`[AUTH] ${req.user.username} asignó a ${u.username} las entradas [${channels.join(', ')}]`);
        if (encList !== undefined) {
            // Encoders: sólo con la ventana Control (sin su web, VPN ni edición). Cada uno entero
            // (inputs null) o sólo algunas entradas, cada una con su main y su sub.
            // Formato: [id] o [{ id, inputs: null | [0, 2...] }]
            const encIds = new Set((await all('SELECT id FROM encoders')).map(r => Number(r.id)));
            const grants = [];
            for (const item of encList) {
                const id = Number(item && typeof item === 'object' ? item.id : item);
                if (!Number.isInteger(id) || !encIds.has(id) || grants.some(g => g.id === id)) continue;
                let inputs = item && typeof item === 'object' && Array.isArray(item.inputs) ? item.inputs.map(Number) : null;
                if (inputs) {
                    inputs = [...new Set(inputs.filter(n => Number.isInteger(n) && n >= 0 && n < 64))].sort((a, b) => a - b);
                    if (!inputs.length) continue; // ninguna entrada = no asignado
                }
                grants.push({ id, inputs });
            }
            await access.setEncoderGrants(u.username, grants);
            console.log(`[AUTH] ${req.user.username} asignó a ${u.username} los encoders [${grants.map(g => g.inputs ? `${g.id} (entradas ${g.inputs.map(n => n + 1).join(',')})` : g.id).join(', ')}]`);
            require('./encoders').notify();
        }
        io.emit('db_update', { event: 'inputs_changed' });
        res.json({ assigned: access.grantsOf(u.username).map(Number), encoders: access.encodersOf(u.username) });
    });
}

// Para validar el propietario de una entrada (server.js)
const hasUser = (username) => users.has(String(username || ''));

module.exports = {
    init,
    hasUser,
    requireAuth,
    requireAdmin,
    socketAuth,
    sessionFromHeaders,
    registerRoutes,
    COOKIE,
    ROLE_ADMIN,
    ROLE_USER
};
