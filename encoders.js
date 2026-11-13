/**
 * ENCODERS REMOTOS (URAY y similares)
 *
 * - Cada encoder tiene la IP con la que el servidor lo alcanza: la de su LAN detrás del router del
 *   sitio (vía túnel WireGuard) o la del propio túnel si el router redirige el puerto.
 * - Proxy autenticado: la web del encoder se abre en http(s)://IP_DEL_SERVIDOR:<puerto propio>, uno por
 *   encoder (las webs de los encoders usan rutas absolutas y no funcionan bajo un subdirectorio).
 *   Sólo entra quien tiene sesión en el panel; la cookie del panel nunca se reenvía al encoder.
 * - Vigilancia cada 10 s: conexión TCP a la web del encoder y, si tiene túnel, el último handshake
 *   WireGuard del router. Se envía al panel ('encoders_status') y a /metrics.
 * - WireGuard (sólo instalación nativa, el servicio corre como root): el panel crea el acceso de cada
 *   router (claves, IP del túnel y red LAN del sitio) y da su archivo de configuración.
 */
const http = require('http');
const tlsConfig = require('./tlsConfig'); // El proxy usa HTTPS si el panel lo usa
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const { spawn } = require('child_process');
const db = require('./db');
const auth = require('./auth');

const PANEL_PORT = parseInt(process.env.PORT, 10) || 4000;
// Puertos del proxy: panel + 10 en adelante (panel 2000 -> encoders 2010, 2011...). Grafana usa panel + 1.
const PROXY_BASE = parseInt(process.env.ENCODER_PROXY_PORT, 10) || PANEL_PORT + 10;
const MAX_SLOTS = 50;
const CHECK_MS = 10000;
const PROBE_TIMEOUT_MS = 3000;
// Sin handshake en 3 min el router se da por desconectado (con keepalive de 25 s hay uno cada 2 min)
const HANDSHAKE_STALE_S = 180;

const WG_IF = /^[A-Za-z0-9_.-]{1,15}$/.test(process.env.WG_INTERFACE || '') ? process.env.WG_INTERFACE : 'wg0';
const WG_CONF = `/etc/wireguard/${WG_IF}.conf`;
// Dirección pública con la que los routers llegan al servidor (IP o DNS, opcionalmente :puerto)
const WG_ENDPOINT = process.env.WG_ENDPOINT || '';

let io = null;
const encoders = new Map(); // id -> fila de la BBDD
const status = new Map();   // id -> estado de la última comprobación
const proxies = new Map();  // id -> { server, port }

const dbAll = (sql, p = []) => new Promise((ok, ko) => db.all(sql, p, (e, r) => e ? ko(e) : ok(r)));
const dbGet = (sql, p = []) => new Promise((ok, ko) => db.get(sql, p, (e, r) => e ? ko(e) : ok(r)));
const dbRun = (sql, p = []) => new Promise((ok, ko) => db.run(sql, p, function (e) { e ? ko(e) : ok(this); }));

/* =======================================
 *  VALIDACIÓN
 * ======================================= */
const ipToInt = (ip) => ip.split('.').reduce((n, o) => (n * 256) + Number(o), 0);
const intToIp = (n) => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');
const isIPv4 = (s) => net.isIPv4(String(s || ''));

function parseCidr(s) {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(s || '').trim());
    if (!m || !isIPv4(m[1])) return null;
    const prefix = Number(m[2]);
    if (prefix < 8 || prefix > 32) return null;
    const size = 2 ** (32 - prefix);
    const network = Math.floor(ipToInt(m[1]) / size) * size;
    return { network, prefix, size, text: `${intToIp(network)}/${prefix}` };
}
const overlaps = (a, b) => a.network < b.network + b.size && b.network < a.network + a.size;

function validateEncoder(body) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 64) return { error: 'El nombre es obligatorio (máximo 64 caracteres)' };
    const host = String(body.host || '').trim();
    if (!isIPv4(host) && !/^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(host)) {
        return { error: 'IP o nombre del encoder no válido' };
    }
    // El proxy no debe dar acceso a servicios del propio servidor (Prometheus, /metrics...)
    if (/^localhost$/i.test(host) || (isIPv4(host) && (host.startsWith('127.') || host === '0.0.0.0'))) {
        return { error: 'La IP del encoder no puede ser la del propio servidor' };
    }
    const webPort = parseInt(body.web_port, 10) || (body.https ? 443 : 80);
    if (webPort < 1 || webPort > 65535) return { error: 'Puerto web no válido' };
    const channel = body.channel === '' || body.channel === null || body.channel === undefined ? null : parseInt(body.channel, 10);
    if (channel !== null && Number.isNaN(channel)) return { error: 'Entrada vinculada no válida' };
    return {
        value: {
            name,
            model: String(body.model || '').trim().slice(0, 64),
            host,
            web_port: webPort,
            https: body.https ? 1 : 0,
            channel,
            notes: String(body.notes || '').slice(0, 500)
        }
    };
}

/* =======================================
 *  WIREGUARD
 * ======================================= */
function run(cmd, args, input) {
    return new Promise((resolve, reject) => {
        let child;
        try { child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return reject(e); }
        let out = '', err = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('error', reject);
        // Si el comando termina sin leer la entrada (p. ej. "wg show" sin interfaz wg0), escribirle da
        // EPIPE; sin este manejador ese error tumbaba todo el servidor. El fallo real llega por 'close'.
        child.stdin.on('error', () => {});
        child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error((err || out).trim() || `${cmd} terminó con código ${code}`)));
        child.stdin.end(input || '');
    });
}

let wgCache = { at: 0, info: null };

// Estado del servidor WireGuard: subred del túnel, puerto y clave pública
async function wgInfo(force) {
    if (!force && wgCache.info && Date.now() - wgCache.at < 30000) return wgCache.info;
    const info = { available: false, interface: WG_IF, endpoint: WG_ENDPOINT };
    try {
        if (process.platform !== 'linux') throw new Error('WireGuard sólo se gestiona en el mini PC (Linux)');
        if (process.getuid && process.getuid() !== 0) throw new Error('El servicio no corre como root');
        const conf = await fs.promises.readFile(WG_CONF, 'utf8').catch(() => { throw new Error(`No existe ${WG_CONF}: activa WireGuard en el instalador`); });
        const iface = conf.split(/^\s*\[Peer\]/m)[0];
        const addr = /^\s*Address\s*=\s*([^\s,]+)/mi.exec(iface);
        const priv = /^\s*PrivateKey\s*=\s*(\S+)/mi.exec(iface);
        const lp = /^\s*ListenPort\s*=\s*(\d+)/mi.exec(iface);
        const subnet = addr && parseCidr(addr[1]);
        if (!subnet || !priv) throw new Error(`${WG_CONF} no tiene Address o PrivateKey`);
        info.serverIp = addr[1].split('/')[0];
        info.subnet = subnet.text;
        info.listenPort = lp ? Number(lp[1]) : 51820;
        info.publicKey = await run('wg', ['pubkey'], priv[1] + '\n');
        info.up = await run('wg', ['show', WG_IF, 'public-key']).then(() => true, () => false);
        info.available = true;
    } catch (e) {
        info.reason = e.code === 'ENOENT' ? 'No está instalado wireguard-tools' : e.message;
    }
    wgCache = { at: Date.now(), info };
    return info;
}

// "wg show dump": por cada peer, último handshake, endpoint y bytes
async function wgPeers() {
    const out = await run('wg', ['show', WG_IF, 'dump']).catch(() => '');
    const peers = new Map();
    out.split('\n').slice(1).forEach(line => {
        const f = line.split('\t');
        if (f.length < 8) return;
        peers.set(f[0], { endpoint: f[2] === '(none)' ? '' : f[2], handshake: Number(f[4]) || 0, rx: Number(f[5]) || 0, tx: Number(f[6]) || 0 });
    });
    return peers;
}

const peerBlockRe = (id) => new RegExp(`\\n?# tsst-encoder-${id}\\b[\\s\\S]*?# /tsst-encoder-${id}\\n?`, 'g');

async function applyWg() {
    // syncconf aplica peers sin cortar los túneles que ya están establecidos
    await run('bash', ['-c', `wg syncconf ${WG_IF} <(wg-quick strip ${WG_IF})`]);
}

async function createPeer(enc, lanText) {
    const info = await wgInfo(true);
    if (!info.available) throw new Error(info.reason);
    if (enc.vpn_pubkey) throw new Error('Este encoder ya tiene acceso VPN');

    const subnet = parseCidr(info.subnet);
    let lan = null;
    if (lanText) {
        lan = parseCidr(lanText);
        if (!lan || lan.prefix < 16) return Promise.reject(new Error('Red LAN del sitio no válida (ej. 192.168.101.0/24)'));
        if (overlaps(lan, subnet)) throw new Error('La red LAN del sitio no puede solaparse con la del túnel');
        for (const other of encoders.values()) {
            const o = other.id !== enc.id && parseCidr(other.vpn_lan);
            if (o && overlaps(o, lan)) throw new Error(`La red ${lan.text} ya la usa "${other.name}": cada sitio necesita una LAN distinta`);
        }
    }

    // Primera IP libre del túnel (la .1 suele ser el servidor)
    const used = new Set([info.serverIp, ...[...encoders.values()].map(e => e.vpn_ip).filter(Boolean)]);
    let ip = null;
    for (let n = subnet.network + 2; n < subnet.network + subnet.size - 1; n++) {
        if (!used.has(intToIp(n))) { ip = intToIp(n); break; }
    }
    if (!ip) throw new Error('No quedan IPs libres en la subred del túnel');

    const priv = await run('wg', ['genkey']);
    const pub = await run('wg', ['pubkey'], priv + '\n');
    const psk = await run('wg', ['genpsk']);
    const allowed = [`${ip}/32`, ...(lan ? [lan.text] : [])].join(', ');
    const safeName = enc.name.replace(/[\r\n]/g, ' ');
    const block = `\n# tsst-encoder-${enc.id} ${safeName}\n[Peer]\nPublicKey = ${pub}\nPresharedKey = ${psk}\nAllowedIPs = ${allowed}\n# /tsst-encoder-${enc.id}\n`;

    const conf = (await fs.promises.readFile(WG_CONF, 'utf8')).replace(peerBlockRe(enc.id), '\n');
    await fs.promises.writeFile(WG_CONF, conf.replace(/\s*$/, '\n') + block, { mode: 0o600 });
    await dbRun('UPDATE encoders SET vpn_ip = ?, vpn_lan = ?, vpn_pubkey = ?, vpn_privkey = ?, vpn_psk = ? WHERE id = ?',
        [ip, lan ? lan.text : '', pub, priv, psk, enc.id]);

    const warnings = [];
    if (info.up) {
        await applyWg().catch(e => warnings.push(`No se pudo aplicar en caliente: ${e.message}`));
        // wg-quick sólo crea las rutas al arrancar; para la LAN del sitio la añadimos ya
        if (lan) await run('ip', ['route', 'replace', lan.text, 'dev', WG_IF]).catch(e => warnings.push(`Ruta ${lan.text}: ${e.message}`));
    } else {
        warnings.push(`La interfaz ${WG_IF} no está levantada (systemctl start wg-quick@${WG_IF})`);
    }
    return warnings;
}

async function removePeer(enc) {
    if (!enc.vpn_pubkey) return;
    try {
        const conf = await fs.promises.readFile(WG_CONF, 'utf8');
        await fs.promises.writeFile(WG_CONF, conf.replace(peerBlockRe(enc.id), '\n').replace(/\n{3,}/g, '\n\n'), { mode: 0o600 });
        await run('wg', ['set', WG_IF, 'peer', enc.vpn_pubkey, 'remove']).catch(() => {});
        if (enc.vpn_lan) await run('ip', ['route', 'del', enc.vpn_lan, 'dev', WG_IF]).catch(() => {});
    } catch (e) {
        console.error(`[ENCODERS] Quitando el peer de ${enc.name}:`, e.message);
    }
    await dbRun("UPDATE encoders SET vpn_ip = '', vpn_lan = '', vpn_pubkey = '', vpn_privkey = '', vpn_psk = '' WHERE id = ?", [enc.id]);
}

async function clientConfig(enc) {
    const info = await wgInfo();
    let endpoint = WG_ENDPOINT || 'IP_PUBLICA_DEL_SERVIDOR';
    if (!/:\d+$/.test(endpoint)) endpoint += `:${info.listenPort || 51820}`;
    return [
        `# Router del encoder "${enc.name}" -> servidor TSST`,
        `# IP del router en el túnel: ${enc.vpn_ip}${enc.vpn_lan ? ` · LAN del sitio: ${enc.vpn_lan}` : ''}`,
        '[Interface]',
        `PrivateKey = ${enc.vpn_privkey}`,
        `Address = ${enc.vpn_ip}/32`,
        '',
        '[Peer]',
        `PublicKey = ${info.publicKey || 'CLAVE_PUBLICA_DEL_SERVIDOR'}`,
        `PresharedKey = ${enc.vpn_psk}`,
        `Endpoint = ${endpoint}`,
        `AllowedIPs = ${info.subnet || '10.8.0.0/24'}`,
        'PersistentKeepalive = 25',
        ''
    ].join('\n');
}

/* =======================================
 *  PROXY A LA WEB DEL ENCODER
 * ======================================= */
function page(res, code, title, text) {
    if (res.headersSent) return res.end();
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center">
<div><h2>${title}</h2><p style="color:#94a3b8">${text}</p></div></body>`);
}

// La cookie de sesión del panel no sale nunca hacia el encoder
function stripPanelCookie(cookie) {
    if (!cookie) return '';
    return cookie.split(';').map(c => c.trim()).filter(c => c && !c.startsWith(`${auth.COOKIE}=`)).join('; ');
}

function forwardHeaders(req, enc) {
    const headers = { ...req.headers };
    const origin = `${enc.https ? 'https' : 'http'}://${enc.host}${(enc.https ? enc.web_port !== 443 : enc.web_port !== 80) ? `:${enc.web_port}` : ''}`;
    headers.host = origin.replace(/^https?:\/\//, '');
    const cookie = stripPanelCookie(req.headers.cookie);
    if (cookie) headers.cookie = cookie; else delete headers.cookie;
    // Algunas webs comprueban Origin/Referer: se presentan como si se abrieran en local
    if (headers.origin) headers.origin = origin;
    if (headers.referer) {
        try { const u = new URL(headers.referer); headers.referer = origin + u.pathname + u.search; } catch { delete headers.referer; }
    }
    headers['x-forwarded-for'] = req.socket.remoteAddress || '';
    return { headers, origin };
}

function sessionOk(req) {
    const user = auth.sessionFromHeaders(req.headers);
    return user && !user.mustChange ? user : null;
}

function handleRequest(id, req, res) {
    const enc = encoders.get(id);
    if (!enc) return page(res, 404, 'Encoder no encontrado', 'Este encoder se ha borrado del panel.');
    const user = sessionOk(req);
    if (!user) {
        return page(res, 401, 'Inicia sesión en el panel', `Abre el panel TSST en el puerto ${PANEL_PORT}, inicia sesión y vuelve a abrir el encoder desde la sección Encoders.`);
    }
    if (!require('./access').canSeeEncoder(user, id)) { // require perezoso: evita ciclo de carga
        return page(res, 404, 'Encoder no encontrado', 'Este encoder no está asignado a tu usuario.');
    }
    const { headers, origin } = forwardHeaders(req, enc);
    const lib = enc.https ? https : http;
    const preq = lib.request({
        host: enc.host, port: enc.web_port, method: req.method, path: req.url, headers,
        rejectUnauthorized: false, // los encoders suelen llevar certificados autofirmados
        timeout: 20000
    }, (pres) => {
        const h = { ...pres.headers };
        // Redirecciones absolutas al encoder -> relativas al proxy
        if (h.location && h.location.startsWith(origin)) h.location = h.location.slice(origin.length) || '/';
        // Cookies del encoder: sin Domain (es la IP del servidor) ni Secure (el proxy puede ir por HTTP)
        if (h['set-cookie']) h['set-cookie'] = h['set-cookie'].map(c => c.replace(/;\s*domain=[^;]*/ig, '').replace(/;\s*secure/ig, '').replace(/;\s*samesite=none/ig, '; SameSite=Lax'));
        delete h['strict-transport-security'];
        res.writeHead(pres.statusCode || 502, h);
        pres.pipe(res);
    });
    preq.on('timeout', () => preq.destroy(new Error('Tiempo de espera agotado')));
    preq.on('error', (err) => page(res, 502, `No se puede conectar con ${enc.name}`,
        `${enc.host}:${enc.web_port} no responde (${err.code || err.message}). Comprueba que el router del sitio tiene el túnel levantado y que el encoder está encendido.`));
    req.pipe(preq);
}

// WebSocket (algunas webs de encoder lo usan para el estado en vivo)
function handleUpgrade(id, req, socket, head) {
    const enc = encoders.get(id);
    const user = sessionOk(req);
    if (!enc || !user) return socket.destroy();
    if (!require('./access').canSeeEncoder(user, id)) return socket.destroy();
    const { headers } = forwardHeaders(req, enc);
    const opts = { host: enc.host, port: enc.web_port };
    const upstream = enc.https ? tls.connect({ ...opts, rejectUnauthorized: false, servername: isIPv4(enc.host) ? undefined : enc.host }) : net.connect(opts);
    upstream.setTimeout(20000, () => upstream.destroy());
    upstream.once(enc.https ? 'secureConnect' : 'connect', () => {
        upstream.setTimeout(0);
        let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(headers)) (Array.isArray(v) ? v : [v]).forEach(x => { raw += `${k}: ${x}\r\n`; });
        upstream.write(raw + '\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
}

function startProxy(enc) {
    const port = PROXY_BASE + enc.proxy_slot;
    const current = proxies.get(enc.id);
    if (current && current.port === port) return;
    stopProxy(enc.id);
    const server = tlsConfig.createServer((req, res) => handleRequest(enc.id, req, res));
    server.on('upgrade', (req, socket, head) => handleUpgrade(enc.id, req, socket, head));
    server.on('error', (err) => {
        console.error(`[ENCODERS] Proxy de "${enc.name}" en el puerto ${port}: ${err.message}`);
        const st = status.get(enc.id) || {};
        status.set(enc.id, { ...st, proxyError: err.code === 'EADDRINUSE' ? `El puerto ${port} está ocupado` : err.message });
    });
    server.listen(port);
    proxies.set(enc.id, { server, port });
}

function stopProxy(id) {
    const p = proxies.get(id);
    if (!p) return;
    p.server.close();
    proxies.delete(id);
}

/* =======================================
 *  VIGILANCIA
 * ======================================= */
function probe(host, port) {
    return new Promise((resolve) => {
        const t0 = process.hrtime.bigint();
        const sock = net.connect({ host, port });
        const done = (ok, error) => {
            sock.destroy();
            resolve({ ok, ms: ok ? Number(process.hrtime.bigint() - t0) / 1e6 : null, error });
        };
        sock.setTimeout(PROBE_TIMEOUT_MS, () => done(false, 'Sin respuesta'));
        sock.once('connect', () => done(true));
        sock.once('error', (e) => done(false, e.code === 'ECONNREFUSED' ? 'Puerto web cerrado' : (e.code || e.message)));
    });
}

let checking = false;
async function checkAll() {
    if (checking || !encoders.size) return;
    checking = true;
    try {
        const anyVpn = [...encoders.values()].some(e => e.vpn_pubkey);
        const peers = anyVpn ? await wgPeers() : new Map();
        const now = Date.now() / 1000;
        await Promise.all([...encoders.values()].map(async (enc) => {
            const r = await probe(enc.host, enc.web_port);
            const prev = status.get(enc.id) || {};
            let vpn = null;
            if (enc.vpn_pubkey) {
                const p = peers.get(enc.vpn_pubkey);
                const age = p && p.handshake ? now - p.handshake : null;
                vpn = { up: age !== null && age < HANDSHAKE_STALE_S, handshakeAge: age, endpoint: p ? p.endpoint : '', rx: p ? p.rx : 0, tx: p ? p.tx : 0 };
            }
            if (prev.online !== undefined && prev.online !== r.ok) {
                console.log(`[ENCODERS] ${enc.name} (${enc.host}) ${r.ok ? 'en línea' : `sin conexión: ${r.error}`}`);
                require('./telegram').encoder(enc.name, enc.host, r.ok, r.error);
            }
            status.set(enc.id, {
                online: r.ok,
                responseMs: r.ms,
                error: r.ok ? '' : r.error,
                lastSeen: r.ok ? Date.now() : (prev.lastSeen || null),
                checkedAt: Date.now(),
                vpn,
                proxyError: prev.proxyError
            });
        }));
        if (io) require('./access').broadcast('encoders_status', statusList()); // require perezoso: evita ciclo de carga
    } finally {
        checking = false;
    }
}

function statusList() {
    return [...encoders.keys()].map(id => ({ id, ...(status.get(id) || {}) }));
}

/* =======================================
 *  API
 * ======================================= */
function publicEncoder(enc, user) {
    const { vpn_privkey, vpn_psk, ...rest } = enc;
    const out = { ...rest, proxy_port: PROXY_BASE + enc.proxy_slot, vpn: !!enc.vpn_pubkey, status: status.get(enc.id) || null };
    if (user && user.role !== auth.ROLE_ADMIN) { // el operador no ve cómo llegar al encoder
        for (const k of ['host', 'web_port', 'vpn_ip', 'vpn_lan', 'vpn_pubkey']) delete out[k];
    }
    return out;
}

async function reload() {
    const rows = await dbAll('SELECT * FROM encoders ORDER BY id');
    const ids = new Set(rows.map(r => r.id));
    for (const id of [...encoders.keys()]) {
        if (!ids.has(id)) { encoders.delete(id); status.delete(id); stopProxy(id); }
    }
    rows.forEach(r => { encoders.set(r.id, r); startProxy(r); });
}

function freeSlot(exceptId) {
    const used = new Set([...encoders.values()].filter(e => e.id !== exceptId).map(e => e.proxy_slot));
    for (let s = 0; s < MAX_SLOTS; s++) if (!used.has(s)) return s;
    return -1;
}

const notify = () => { if (io) io.emit('db_update', { event: 'encoders_changed' }); };
const wrap = (fn) => (req, res) => fn(req, res).catch(err => res.status(400).json({ error: err.message }));

function registerRoutes(app) {
    app.get('/api/encoders', (req, res) => {
        const access = require('./access'); // require perezoso: evita ciclo de carga
        res.json([...encoders.values()]
            .filter(e => access.canSeeEncoder(req.user, e.id))
            .map(e => publicEncoder(e, req.user)));
    });

    app.get('/api/encoders/vpn', auth.requireAdmin, wrap(async (req, res) => {
        const info = await wgInfo(req.query.refresh === '1');
        const { publicKey, ...rest } = info;
        res.json({ ...rest, proxyBase: PROXY_BASE });
    }));

    app.post('/api/encoders', auth.requireAdmin, wrap(async (req, res) => {
        const { error, value } = validateEncoder(req.body || {});
        if (error) return res.status(400).json({ error });
        const slot = freeSlot();
        if (slot < 0) return res.status(400).json({ error: `Máximo ${MAX_SLOTS} encoders` });
        const r = await dbRun(`INSERT INTO encoders (name, model, host, web_port, https, channel, notes, proxy_slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [value.name, value.model, value.host, value.web_port, value.https, value.channel, value.notes, slot]);
        await reload();
        await require('./access').reload();
        notify();
        checkAll();
        res.status(201).json(publicEncoder(encoders.get(r.lastID)));
    }));

    app.put('/api/encoders/:id', auth.requireAdmin, wrap(async (req, res) => {
        const id = parseInt(req.params.id, 10);
        if (!encoders.has(id)) return res.status(404).json({ error: 'No encontrado' });
        const { error, value } = validateEncoder(req.body || {});
        if (error) return res.status(400).json({ error });
        await dbRun('UPDATE encoders SET name = ?, model = ?, host = ?, web_port = ?, https = ?, channel = ?, notes = ? WHERE id = ?',
            [value.name, value.model, value.host, value.web_port, value.https, value.channel, value.notes, id]);
        await reload();
        await require('./access').reload();
        notify();
        checkAll();
        res.json(publicEncoder(encoders.get(id)));
    }));

    app.delete('/api/encoders/:id', auth.requireAdmin, wrap(async (req, res) => {
        const id = parseInt(req.params.id, 10);
        const enc = encoders.get(id);
        if (!enc) return res.status(404).json({ error: 'No encontrado' });
        await removePeer(enc);
        await dbRun('DELETE FROM encoders WHERE id = ?', [id]);
        await reload();
        await require('./access').reload();
        notify();
        res.json({ deleted: true });
    }));

    app.post('/api/encoders/:id/vpn', auth.requireAdmin, wrap(async (req, res) => {
        const id = parseInt(req.params.id, 10);
        const enc = encoders.get(id);
        if (!enc) return res.status(404).json({ error: 'No encontrado' });
        const warnings = await createPeer(enc, String((req.body && req.body.lan) || '').trim());
        await reload();
        notify();
        res.json({ ...publicEncoder(encoders.get(id)), warnings });
    }));

    app.delete('/api/encoders/:id/vpn', auth.requireAdmin, wrap(async (req, res) => {
        const id = parseInt(req.params.id, 10);
        const enc = encoders.get(id);
        if (!enc) return res.status(404).json({ error: 'No encontrado' });
        await removePeer(enc);
        await reload();
        notify();
        res.json(publicEncoder(encoders.get(id)));
    }));

    // Archivo para importar en el router (lleva su clave privada: sólo administradores)
    app.get('/api/encoders/:id/wireguard.conf', auth.requireAdmin, wrap(async (req, res) => {
        const enc = encoders.get(parseInt(req.params.id, 10));
        if (!enc || !enc.vpn_pubkey) return res.status(404).json({ error: 'Este encoder no tiene acceso VPN' });
        const file = `tsst-${enc.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || enc.id}.conf`;
        res.set('Cache-Control', 'no-store');
        res.attachment(file).type('text/plain').send(await clientConfig(enc));
    }));
}

/* =======================================
 *  MÉTRICAS
 * ======================================= */
function addMetrics(r) {
    for (const enc of encoders.values()) {
        const st = status.get(enc.id);
        const l = { encoder: enc.id, name: enc.name, channel: enc.channel ?? '' };
        if (!st || st.online === undefined) continue;
        r.gauge('tsst_encoder_up', '1 si la web del encoder responde', l, st.online ? 1 : 0);
        if (st.responseMs !== null) r.gauge('tsst_encoder_response_seconds', 'Tiempo de conexión TCP a la web del encoder', l, st.responseMs / 1000);
        if (st.vpn) {
            r.gauge('tsst_encoder_vpn_up', '1 si el router del encoder tiene el túnel WireGuard activo', l, st.vpn.up ? 1 : 0);
            if (st.vpn.handshakeAge !== null) r.gauge('tsst_encoder_vpn_handshake_age_seconds', 'Segundos desde el último handshake WireGuard', l, st.vpn.handshakeAge);
            r.counter('tsst_encoder_vpn_received_bytes_total', 'Bytes recibidos por el túnel del encoder', l, st.vpn.rx);
            r.counter('tsst_encoder_vpn_sent_bytes_total', 'Bytes enviados por el túnel del encoder', l, st.vpn.tx);
        }
    }
}

async function init(socketIo) {
    io = socketIo;
    await db.ready;
    await reload().catch(err => console.error('[ENCODERS] Error cargando encoders', err));
    setInterval(() => checkAll().catch(err => console.error('[ENCODERS]', err)), CHECK_MS).unref();
    checkAll().catch(() => {});
}

function shutdown() {
    for (const id of [...proxies.keys()]) stopProxy(id);
}

module.exports = { init, registerRoutes, addMetrics, shutdown, statusList, _test: { parseCidr, validateEncoder, stripPanelCookie } };
