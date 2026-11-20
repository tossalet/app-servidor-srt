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
const os = require('os');
const { spawn } = require('child_process');
const db = require('./db');
const auth = require('./auth');
const { operatorEncoderStatus, encoderChannelsOf } = require('./accessCore');
const drivers = require('./encoderDrivers');

const PANEL_PORT = parseInt(process.env.PORT, 10) || 4000;
// Puertos del proxy: panel + 10 en adelante (panel 2000 -> encoders 2010, 2011...). Grafana usa panel + 1.
const PROXY_BASE = parseInt(process.env.ENCODER_PROXY_PORT, 10) || PANEL_PORT + 10;
const MAX_SLOTS = 50;
const MAX_INPUTS = 8; // encoders de hasta 8 entradas (los habituales: 1, 2 o 4); decoders de hasta 8 canales
const KINDS = ['encoder', 'decoder'];
const CHECK_MS = 10000;
const PROBE_TIMEOUT_MS = 3000;
// Sin handshake en 3 min el router se da por desconectado (con keepalive de 25 s hay uno cada 2 min)
const HANDSHAKE_STALE_S = 180;

const WG_IF = /^[A-Za-z0-9_.-]{1,15}$/.test(process.env.WG_INTERFACE || '') ? process.env.WG_INTERFACE : 'wg0';
const WG_CONF = `/etc/wireguard/${WG_IF}.conf`;
// Dirección pública con la que los routers llegan al servidor (IP o DNS, opcionalmente :puerto)
const WG_ENDPOINT = process.env.WG_ENDPOINT || '';

let io = null;
const encoders = new Map(); // id -> fila de la BBDD (encoders y decoders)
const sites = new Map();    // id -> sitio VPN (tabla vpn_sites)
const siteStatus = new Map(); // id sitio -> estado de su túnel
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
    if (/^localhost$/i.test(host) || (isIPv4(host) && (host.startsWith('127.') || host === '0.0.0.0' || serverAddresses().has(host)))) {
        return { error: 'La IP del equipo no puede ser la del propio servidor' };
    }
    const webPort = parseInt(body.web_port, 10) || (body.https ? 443 : 80);
    if (webPort < 1 || webPort > 65535) return { error: 'Puerto web no válido' };
    const kind = body.kind === undefined || body.kind === '' ? 'encoder' : String(body.kind);
    if (!KINDS.includes(kind)) return { error: 'Tipo de equipo no válido (encoder o decoder)' };
    const decoder = kind === 'decoder';
    // Encoder: señal del servidor que envía cada entrada (channels[0] = entrada 1).
    // Compatibilidad: sin channels, el campo channel es la única entrada.
    // Decoder: salida del servidor que recibe cada uno de sus canales (outputs[0] = canal 1).
    const rawList = decoder
        ? (Array.isArray(body.outputs) ? body.outputs : [null])
        : (Array.isArray(body.channels) ? body.channels : [body.channel]);
    const what = decoder ? 'El decoder puede tener de 1 a %d canales' : 'El encoder puede tener de 1 a %d entradas';
    if (!rawList.length || rawList.length > MAX_INPUTS) return { error: what.replace('%d', MAX_INPUTS) };
    const list = [];
    for (const c of rawList) {
        const v = c === '' || c === null || c === undefined ? null : parseInt(c, 10);
        if (v !== null && Number.isNaN(v)) return { error: decoder ? 'Salida vinculada no válida' : 'Señal vinculada no válida' };
        if (v !== null && list.includes(v)) return { error: decoder ? 'Dos canales del decoder no pueden recibir la misma salida' : 'Dos entradas del encoder no pueden enviar la misma señal' };
        list.push(v);
    }
    const channels = decoder ? [null] : list;
    const channel = channels[0];
    // Cada tipo de equipo tiene sus fabricantes (APIs) posibles
    const driver = body.driver === undefined || body.driver === '' ? 'auto' : String(body.driver);
    if (!(decoder ? drivers.DECODER_DRIVER_CHOICES : drivers.DRIVER_CHOICES).includes(driver)) return { error: 'Fabricante (API) no válido' };
    const apiUser = String(body.api_user || '').trim();
    if (apiUser.length > 64 || /[:\r\n]/.test(apiUser)) return { error: 'Usuario de la API no válido' };
    // api_pass: undefined o '' = conservar la guardada; null = borrarla
    let apiPass;
    if (body.api_pass === null) apiPass = '';
    else if (body.api_pass !== undefined && body.api_pass !== '') {
        apiPass = String(body.api_pass);
        if (apiPass.length > 128 || /[\r\n]/.test(apiPass)) return { error: 'Contraseña de la API no válida' };
    }
    return {
        value: {
            name,
            model: String(body.model || '').trim().slice(0, 64),
            host,
            web_port: webPort,
            https: body.https ? 1 : 0,
            kind,
            channel,
            channels,
            input_channels: channels.length > 1 ? JSON.stringify(channels) : '',
            outputs: decoder ? list : [],
            output_ids: decoder ? JSON.stringify(list) : '',
            notes: String(body.notes || '').slice(0, 500),
            driver,
            api_user: apiUser,
            api_pass: apiPass
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

/* ---- Sitios VPN: un acceso WireGuard por router (o pasarela) del sitio, para todos sus equipos ---- */

// Bloque del peer de un sitio en wg0.conf. Los sitios migrados de la versión anterior (un acceso por
// encoder) conservan su marca antigua # tsst-encoder-<id> hasta que se reescriben.
function siteBlockRe(site) {
    const marks = [`tsst-site-${site.id}`];
    if (site.legacy_encoder_id) marks.push(`tsst-encoder-${site.legacy_encoder_id}`);
    return new RegExp(`\\n?# (${marks.join('|')})\\b[\\s\\S]*?# /\\1\\b\\n?`, 'g');
}

function siteBlock(site) {
    const allowed = [`${site.vpn_ip}/32`, ...(site.vpn_lan ? [site.vpn_lan] : [])].join(', ');
    const safeName = String(site.name).replace(/[\r\n]/g, ' ');
    return `\n# tsst-site-${site.id} ${safeName}\n[Peer]\nPublicKey = ${site.vpn_pubkey}\nPresharedKey = ${site.vpn_psk}\nAllowedIPs = ${allowed}\n# /tsst-site-${site.id}\n`;
}

// Escribe (o quita, con block vacío) el peer del sitio en wg0.conf
async function writeSiteBlock(site, block) {
    const conf = (await fs.promises.readFile(WG_CONF, 'utf8')).replace(siteBlockRe(site), '\n').replace(/\n{3,}/g, '\n\n');
    await fs.promises.writeFile(WG_CONF, conf.replace(/\s*$/, '\n') + (block || ''), { mode: 0o600 });
}

async function applyWg() {
    // syncconf aplica peers sin cortar los túneles que ya están establecidos
    await run('bash', ['-c', `wg syncconf ${WG_IF} <(wg-quick strip ${WG_IF})`]);
}

const inCidr = (ip, cidr) => {
    const c = parseCidr(cidr);
    return !!c && isIPv4(ip) && Math.floor(ipToInt(ip) / c.size) * c.size === c.network;
};

// Redes e IPs del propio servidor (sin el túnel): una LAN de sitio no puede pisarlas y el proxy no
// puede apuntar a ellas
function localNets() {
    const out = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        if (name === WG_IF) continue;
        for (const a of addrs || []) {
            if (a.family !== 'IPv4' && a.family !== 4) continue;
            const c = a.cidr && parseCidr(a.cidr);
            if (c) out.push({ ...c, iface: name, address: a.address });
        }
    }
    return out;
}

function serverAddresses() {
    const set = new Set();
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) if (a.family === 'IPv4' || a.family === 4) set.add(a.address);
    }
    return set;
}

// Sitio al que pertenece un equipo: el que tiene su IP en la LAN del sitio o es la IP del túnel del
// router (equipos a los que se llega por un puerto redirigido)
function siteOfHost(host) {
    if (!isIPv4(host)) return null;
    for (const s of sites.values()) {
        if (host === s.vpn_ip || (s.vpn_lan && inCidr(host, s.vpn_lan))) return s;
    }
    return null;
}
const siteOf = (enc) => siteOfHost(enc.host);

function validateSite(body) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 64) return { error: 'El nombre del sitio es obligatorio (máximo 64 caracteres)' };
    const videoVia = body.video_via === 'public' ? 'public' : 'tunnel';
    const videoHost = String(body.video_host || '').trim();
    if (videoHost && (videoHost.length > 253 || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(videoHost))) {
        return { error: 'Dirección pública no válida (ej. tsst.dyndns.tv o 203.0.113.10, sin puerto)' };
    }
    if (videoVia === 'public' && !videoHost) return { error: 'Indica la dirección pública del servidor por la que llega el vídeo' };
    return { value: { name, notes: String(body.notes || '').slice(0, 500), lan: String(body.lan || '').trim(), videoVia, videoHost } };
}

// Dirección del servidor que usan los decoders de un sitio para recibir sus salidas
const siteVideoHost = (site, info) => (site.video_via === 'public' && site.video_host) ? site.video_host : (info.serverIp || null);

// Comprueba la red LAN de un sitio: no puede pisar el túnel, otro sitio ni una red del servidor
// (si no, el servidor mandaría su propio tráfico por el túnel y perdería la red de la oficina)
function checkLan(lanText, subnet, exceptId) {
    if (!lanText) return null;
    const lan = parseCidr(lanText);
    if (!lan || lan.prefix < 16) throw new Error('Red LAN del sitio no válida (ej. 192.168.101.0/24)');
    if (subnet && overlaps(lan, subnet)) throw new Error('La red LAN del sitio no puede solaparse con la del túnel');
    for (const n of localNets()) {
        if (overlaps(lan, n)) {
            throw new Error(`La red ${lan.text} es la del propio servidor (${n.iface} ${n.text}): deja la LAN vacía y llega a los equipos por puertos redirigidos en el router del sitio`);
        }
    }
    for (const other of sites.values()) {
        const o = other.id !== exceptId && parseCidr(other.vpn_lan);
        if (o && overlaps(o, lan)) {
            throw new Error(`La red ${lan.text} ya la usa el sitio "${other.name}": deja la LAN vacía y llega a los equipos por puertos redirigidos en el router`);
        }
    }
    return lan;
}

async function createSite({ name, notes, lan: lanText, videoVia, videoHost }) {
    const info = await wgInfo(true);
    if (!info.available) throw new Error(info.reason);
    const subnet = parseCidr(info.subnet);
    const lan = checkLan(lanText, subnet, null);

    // Primera IP libre del túnel (la .1 suele ser el servidor)
    const used = new Set([info.serverIp, ...[...sites.values()].map(s => s.vpn_ip).filter(Boolean)]);
    let ip = null;
    for (let n = subnet.network + 2; n < subnet.network + subnet.size - 1; n++) {
        if (!used.has(intToIp(n))) { ip = intToIp(n); break; }
    }
    if (!ip) throw new Error('No quedan IPs libres en la subred del túnel');

    const priv = await run('wg', ['genkey']);
    const pub = await run('wg', ['pubkey'], priv + '\n');
    const psk = await run('wg', ['genpsk']);
    const r = await dbRun('INSERT INTO vpn_sites (name, notes, vpn_ip, vpn_lan, vpn_pubkey, vpn_privkey, vpn_psk, video_via, video_host) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [name, notes, ip, lan ? lan.text : '', pub, priv, psk, videoVia || 'tunnel', videoHost || '']);
    const site = { id: r.lastID, name, notes, video_via: videoVia || 'tunnel', video_host: videoHost || '', vpn_ip: ip, vpn_lan: lan ? lan.text : '', vpn_pubkey: pub, vpn_privkey: priv, vpn_psk: psk, legacy_encoder_id: null };
    try {
        await writeSiteBlock(site, siteBlock(site));
    } catch (e) {
        await dbRun('DELETE FROM vpn_sites WHERE id = ?', [site.id]).catch(() => {});
        throw new Error(`No se pudo escribir ${WG_CONF}: ${e.message}`);
    }
    return { id: site.id, warnings: await applySite(info, null, site.vpn_lan) };
}

// Aplica en caliente el cambio de un sitio: peers y la ruta de su LAN (wg-quick sólo las crea al arrancar)
async function applySite(info, oldLan, newLan) {
    const warnings = [];
    if (!info.up) {
        warnings.push(`La interfaz ${WG_IF} no está levantada (systemctl start wg-quick@${WG_IF})`);
        return warnings;
    }
    await applyWg().catch(e => warnings.push(`No se pudo aplicar en caliente: ${e.message}`));
    if (oldLan && oldLan !== newLan) await run('ip', ['route', 'del', oldLan, 'dev', WG_IF]).catch(() => {});
    if (newLan) await run('ip', ['route', 'replace', newLan, 'dev', WG_IF]).catch(e => warnings.push(`Ruta ${newLan}: ${e.message}`));
    return warnings;
}

async function updateSite(site, { name, notes, lan: lanText, videoVia, videoHost }) {
    let lanOut = site.vpn_lan;
    let warnings = [];
    if (lanText !== site.vpn_lan) {
        // Cambiar la LAN reescribe el peer con las mismas claves: el router no hay que tocarlo
        const info = await wgInfo(true);
        if (!info.available) throw new Error(info.reason);
        const lan = checkLan(lanText, parseCidr(info.subnet), site.id);
        lanOut = lan ? lan.text : '';
        await writeSiteBlock(site, siteBlock({ ...site, name, vpn_lan: lanOut }));
        await dbRun('UPDATE vpn_sites SET legacy_encoder_id = NULL WHERE id = ?', [site.id]);
        warnings = await applySite(info, site.vpn_lan, lanOut);
    }
    await dbRun('UPDATE vpn_sites SET name = ?, notes = ?, vpn_lan = ?, video_via = ?, video_host = ? WHERE id = ?',
        [name, notes, lanOut, videoVia || 'tunnel', videoHost || '', site.id]);
    return warnings;
}

async function deleteSite(site) {
    try {
        await writeSiteBlock(site, '');
        await run('wg', ['set', WG_IF, 'peer', site.vpn_pubkey, 'remove']).catch(() => {});
        if (site.vpn_lan) await run('ip', ['route', 'del', site.vpn_lan, 'dev', WG_IF]).catch(() => {});
    } catch (e) {
        console.error(`[ENCODERS] Quitando el peer del sitio ${site.name}:`, e.message);
    }
    await dbRun('DELETE FROM vpn_sites WHERE id = ?', [site.id]);
}

async function clientConfig(site) {
    const info = await wgInfo();
    let endpoint = WG_ENDPOINT || 'IP_PUBLICA_DEL_SERVIDOR';
    if (!/:\d+$/.test(endpoint)) endpoint += `:${info.listenPort || 51820}`;
    return [
        `# Sitio "${site.name}" -> servidor TSST`,
        `# IP del router en el túnel: ${site.vpn_ip}${site.vpn_lan ? ` · LAN del sitio: ${site.vpn_lan}` : ' · sin LAN enrutada (puertos redirigidos)'}`,
        '[Interface]',
        `PrivateKey = ${site.vpn_privkey}`,
        `Address = ${site.vpn_ip}/32`,
        '',
        '[Peer]',
        `PublicKey = ${info.publicKey || 'CLAVE_PUBLICA_DEL_SERVIDOR'}`,
        `PresharedKey = ${site.vpn_psk}`,
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
    // La web del encoder es sólo para administradores: un operador usa la ventana Control del panel
    if (user.role !== auth.ROLE_ADMIN) {
        return page(res, 403, 'Sólo administradores', 'La web del encoder la abre un administrador. Desde el panel, en Encoders, usa el botón Control para ajustar la codificación y las emisiones.');
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
        // Con el proxy en HTTPS, las webs de estos equipos piden sus datos y su login a http://<host>
        // y el navegador lo bloquea (contenido mixto): campos vacíos y login que no entra. Así el
        // navegador convierte esas peticiones (y los ws://) a https:// del mismo proxy.
        if (tlsConfig.enabled && /text\/html/i.test(h['content-type'] || '')) {
            const csp = h['content-security-policy'];
            if (!csp) h['content-security-policy'] = 'upgrade-insecure-requests';
            else if (!/upgrade-insecure-requests/i.test(String(csp))) h['content-security-policy'] = `${csp}; upgrade-insecure-requests`;
        }
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
    if (user.role !== auth.ROLE_ADMIN) return socket.destroy();
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

/* =======================================
 *  API DEL ENCODER (control y telemetría, ver encoderDrivers.js)
 * ======================================= */
const detected = new Map();   // id -> driver detectado con 'auto'
const detectFailAt = new Map(); // id -> último intento fallido de detección (no reintentar cada 10 s)
const REDETECT_MS = 60000;

async function resolveDriver(enc) {
    if (enc.driver === 'none') return null;
    if (enc.driver && enc.driver !== 'auto') return enc.driver;
    if (detected.has(enc.id)) return detected.get(enc.id);
    const last = detectFailAt.get(enc.id);
    if (last && Date.now() - last < REDETECT_MS) throw new drivers.ApiError('API no reconocida: elige el fabricante en el encoder o usa su web', 'EUNKNOWN');
    try {
        const r = enc.kind === 'decoder' ? await drivers.detectDecoder(enc) : await drivers.detect(enc);
        detected.set(enc.id, r.driver);
        detectFailAt.delete(enc.id);
        console.log(`[ENCODERS] ${enc.name}: API detectada ${drivers.DRIVERS[r.driver].label}`);
        if (r.error) throw r.error;
        return r.driver;
    } catch (e) {
        if (e.code === 'EUNKNOWN') detectFailAt.set(enc.id, Date.now());
        throw e;
    }
}

function forgetDriver(id) {
    detected.delete(id);
    detectFailAt.delete(id);
}

// Las URLs SRT pueden llevar la passphrase: en el estado de la tarjeta y para operadores se oculta
const maskPass = (u) => String(u || '').replace(/(passphrase=)[^&]*/gi, '$1***');

const driverLabel = (d) => (d && drivers.DRIVERS[d] ? drivers.DRIVERS[d].label : '');

async function pollApi(enc) {
    if (enc.driver === 'none') return null;
    let driver = null;
    try {
        driver = await resolveDriver(enc);
        const t = await drivers.impl(driver).poll(enc);
        if (t.decoder) t.urls = (t.urls || []).map(maskPass);
        return { ok: true, driver, label: driverLabel(driver), ...t, at: Date.now() };
    } catch (e) {
        // Si el equipo deja de hablar esa API (lo han cambiado por otro), se vuelve a detectar
        if (enc.driver === 'auto' && (e.code === 'EFORMAT' || e.code === 'ENOTFOUND_API')) forgetDriver(enc.id);
        driver = driver || detected.get(enc.id) || (enc.driver !== 'auto' ? enc.driver : null);
        return { ok: false, driver, label: driverLabel(driver), error: e.message, auth: e.code === 'EAUTH', at: Date.now() };
    }
}

async function withDriver(enc) {
    const driver = await resolveDriver(enc);
    if (!driver) throw new drivers.ApiError('Este encoder no tiene control por API (fabricante: ninguno)', 'ENODRIVER');
    return { driver, api: drivers.impl(driver) };
}

// Tras una orden se refresca su telemetría sin esperar a la siguiente vuelta
async function refreshOne(enc) {
    const st = status.get(enc.id);
    if (!st || !st.online) return;
    st.api = await pollApi(enc);
    if (io) require('./access').broadcast('encoders_status', statusList());
}

let checking = false;
async function checkAll() {
    if (checking || (!encoders.size && !sites.size)) return;
    checking = true;
    try {
        // Túnel de cada sitio: lo comparten todos sus equipos
        const peers = sites.size ? await wgPeers() : new Map();
        const now = Date.now() / 1000;
        siteStatus.clear();
        for (const s of sites.values()) {
            const p = peers.get(s.vpn_pubkey);
            const age = p && p.handshake ? now - p.handshake : null;
            siteStatus.set(s.id, { up: age !== null && age < HANDSHAKE_STALE_S, handshakeAge: age, endpoint: p ? p.endpoint : '', rx: p ? p.rx : 0, tx: p ? p.tx : 0 });
        }
        await Promise.all([...encoders.values()].map(async (enc) => {
            const r = await probe(enc.host, enc.web_port);
            const prev = status.get(enc.id) || {};
            const site = siteOf(enc);
            const vpn = site ? { ...siteStatus.get(site.id), site: site.id } : null;
            if (prev.online !== undefined && prev.online !== r.ok) {
                console.log(`[ENCODERS] ${enc.name} (${enc.host}) ${r.ok ? 'en línea' : `sin conexión: ${r.error}`}`);
                require('./telegram').encoder(enc.name, enc.host, r.ok, r.error, enc.kind);
            }
            // La API sólo se consulta si la web responde (si no, cada vuelta esperaría el timeout)
            const api = r.ok ? await pollApi(enc) : (prev.api ? { ...prev.api, ok: false, error: 'Sin conexión' } : null);
            // Aviso por entrada cuando cambia su señal de vídeo
            if (api && api.ok && prev.api && prev.api.ok) {
                const multi = (api.inputs || []).length > 1;
                for (const inp of api.inputs || []) {
                    const before = (prev.api.inputs || []).find(x => x.id === inp.id);
                    if (!before || typeof before.signal !== 'boolean' || typeof inp.signal !== 'boolean' || before.signal === inp.signal) continue;
                    const which = multi ? ` (entrada ${inp.id + 1})` : '';
                    console.log(`[ENCODERS] ${enc.name}${which}: ${inp.signal ? 'vuelve la señal de entrada' : 'sin señal de entrada'}`);
                    require('./telegram').encoderInput(enc.name + which, inp.signal);
                }
            }
            status.set(enc.id, {
                api,
                online: r.ok,
                responseMs: r.ms,
                error: r.ok ? '' : r.error,
                lastSeen: r.ok ? Date.now() : (prev.lastSeen || null),
                checkedAt: Date.now(),
                vpn,
                proxyError: prev.proxyError
            });
        }));
        if (io) {
            const access = require('./access'); // require perezoso: evita ciclo de carga
            access.broadcast('encoders_status', statusList());
            access.broadcast('vpn_sites_status', siteStatusList()); // sólo administradores (filterFor falla cerrado)
        }
    } finally {
        checking = false;
    }
}

function statusList() {
    return [...encoders.keys()].map(id => ({ id, ...(status.get(id) || {}) }));
}

function siteStatusList() {
    return [...sites.keys()].map(id => ({ id, ...(siteStatus.get(id) || {}) }));
}

// Salida del servidor que recibe cada canal de un decoder: [canal 1, canal 2...]
function decoderOutputsOf(row) {
    try {
        const v = JSON.parse(row.output_ids || '[]');
        if (Array.isArray(v) && v.length) return v.map(x => (x === null || x === undefined || x === '' ? null : Number(x)));
    } catch { /* columna corrupta: como si no hubiera */ }
    return [null];
}

// Sitio tal como lo ve el admin (sin claves): su túnel y qué equipos van por él
function publicSite(s) {
    return {
        id: s.id, name: s.name, notes: s.notes, vpn_ip: s.vpn_ip, vpn_lan: s.vpn_lan,
        video_via: s.video_via || 'tunnel', video_host: s.video_host || '',
        status: siteStatus.get(s.id) || null,
        devices: [...encoders.values()].filter(e => siteOf(e) === s).map(e => ({ id: e.id, name: e.name, kind: e.kind || 'encoder' }))
    };
}

/* =======================================
 *  API
 * ======================================= */
function publicEncoder(enc, user) {
    // Las columnas vpn_* son de la versión anterior (el acceso iba en cada encoder): ya no se usan
    const { vpn_privkey, vpn_psk, vpn_pubkey, vpn_ip, vpn_lan, api_pass, input_channels, output_ids, ...rest } = enc;
    const kind = enc.kind || 'encoder';
    const channels = encoderChannelsOf(enc).map(c => (c === null ? null : Number(c)));
    const site = siteOf(enc);
    const out = {
        ...rest, kind, channels, outputs: kind === 'decoder' ? decoderOutputsOf(enc) : [],
        api_has_pass: !!api_pass, proxy_port: PROXY_BASE + enc.proxy_slot,
        vpn: !!site, site: site ? { id: site.id, name: site.name, vpn_ip: site.vpn_ip, vpn_lan: site.vpn_lan } : null,
        status: status.get(enc.id) || null
    };
    if (user && user.role !== auth.ROLE_ADMIN) { // el operador no ve cómo llegar al equipo
        for (const k of ['host', 'web_port', 'site', 'api_user', 'api_has_pass']) delete out[k];
        // De las salidas que recibe un decoder, sólo las que el operador ve
        out.outputs = out.outputs.map(o => (o !== null && require('./access').canSeeOutput(user, o) ? o : null));
        // Sólo las entradas que le ha asignado el admin (o todas); de la VPN sólo si está arriba
        delete out.proxy_port;
        const visible = require('./access').visibleEncoderInputs(user, enc.id);
        if (visible) {
            out.channels = channels.map((c, i) => (visible.has(i) ? c : null));
            out.channel = out.channels[0];
            out.visible_inputs = [...visible].sort((a, b) => a - b);
        }
        out.status = operatorEncoderStatus(out.status, visible);
    }
    return out;
}

async function reload() {
    const siteRows = await dbAll('SELECT * FROM vpn_sites ORDER BY id');
    sites.clear();
    siteRows.forEach(s => sites.set(s.id, s));
    for (const id of [...siteStatus.keys()]) if (!sites.has(id)) siteStatus.delete(id);
    const rows = await dbAll('SELECT * FROM encoders ORDER BY id');
    const ids = new Set(rows.map(r => r.id));
    for (const id of [...encoders.keys()]) {
        if (!ids.has(id)) { encoders.delete(id); status.delete(id); stopProxy(id); forgetDriver(id); }
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

    // Comprobaciones que necesitan la BBDD: las salidas del decoder existen y la IP encaja con el
    // sitio elegido (su LAN o la IP del router en el túnel)
    const checkDevice = async (value, body) => {
        const outs = value.outputs.filter(o => o !== null);
        if (outs.length) {
            const found = new Set((await dbAll(`SELECT id FROM outputs WHERE id IN (${outs.map(() => '?').join(',')})`, outs)).map(r => r.id));
            const missing = outs.find(o => !found.has(o));
            if (missing !== undefined) return `La salida ${missing} no existe`;
        }
        if (body.site_id !== undefined && body.site_id !== null && body.site_id !== '') {
            const site = sites.get(parseInt(body.site_id, 10));
            if (!site) return 'El sitio VPN elegido no existe';
            if (siteOfHost(value.host) !== site) {
                return site.vpn_lan
                    ? `La IP ${value.host} no es del sitio "${site.name}": usa una IP de su LAN (${site.vpn_lan}) o la del router en el túnel (${site.vpn_ip}) con un puerto redirigido`
                    : `La IP ${value.host} no es del sitio "${site.name}": ese sitio no enruta su LAN, usa la IP del router en el túnel (${site.vpn_ip}) con el puerto que redirige a este equipo`;
            }
        }
        return null;
    };

    app.post('/api/encoders', auth.requireAdmin, wrap(async (req, res) => {
        const { error, value } = validateEncoder(req.body || {});
        if (error) return res.status(400).json({ error });
        const bad = await checkDevice(value, req.body);
        if (bad) return res.status(400).json({ error: bad });
        const slot = freeSlot();
        if (slot < 0) return res.status(400).json({ error: `Máximo ${MAX_SLOTS} equipos` });
        const r = await dbRun(`INSERT INTO encoders (name, model, kind, host, web_port, https, channel, input_channels, output_ids, notes, proxy_slot, driver, api_user, api_pass) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [value.name, value.model, value.kind, value.host, value.web_port, value.https, value.channel, value.input_channels, value.output_ids, value.notes, slot, value.driver, value.api_user, value.api_pass || '']);
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
        const bad = await checkDevice(value, req.body);
        if (bad) return res.status(400).json({ error: bad });
        // Sin usuario de API no se guarda contraseña; si no se envía una nueva, se conserva la anterior
        const pass = !value.api_user ? '' : (value.api_pass !== undefined ? value.api_pass : encoders.get(id).api_pass);
        await dbRun('UPDATE encoders SET name = ?, model = ?, kind = ?, host = ?, web_port = ?, https = ?, channel = ?, input_channels = ?, output_ids = ?, notes = ?, driver = ?, api_user = ?, api_pass = ? WHERE id = ?',
            [value.name, value.model, value.kind, value.host, value.web_port, value.https, value.channel, value.input_channels, value.output_ids, value.notes, value.driver, value.api_user, pass, id]);
        forgetDriver(id); // la IP o el fabricante pueden haber cambiado
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
        // El túnel es del sitio: borrar un equipo no corta a los demás equipos del sitio
        await dbRun('DELETE FROM encoders WHERE id = ?', [id]);
        await dbRun('DELETE FROM encoder_access WHERE encoder_id = ?', [id]);
        await reload();
        await require('./access').reload();
        notify();
        res.json({ deleted: true });
    }));

    /* ---- Sitios VPN (sólo administradores): un acceso WireGuard por router o pasarela del sitio ---- */
    const siteParam = (req, res) => {
        const site = sites.get(parseInt(req.params.id, 10));
        if (!site) res.status(404).json({ error: 'Sitio no encontrado' });
        return site;
    };

    app.get('/api/vpn-sites', auth.requireAdmin, (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json([...sites.values()].map(publicSite));
    });

    app.post('/api/vpn-sites', auth.requireAdmin, wrap(async (req, res) => {
        const { error, value } = validateSite(req.body || {});
        if (error) return res.status(400).json({ error });
        const { id, warnings } = await createSite(value);
        await reload();
        notify();
        checkAll().catch(() => {});
        res.status(201).json({ ...publicSite(sites.get(id)), warnings });
    }));

    app.put('/api/vpn-sites/:id', auth.requireAdmin, wrap(async (req, res) => {
        const site = siteParam(req, res);
        if (!site) return;
        const { error, value } = validateSite(req.body || {});
        if (error) return res.status(400).json({ error });
        const warnings = await updateSite(site, value);
        await reload();
        notify();
        checkAll().catch(() => {});
        res.json({ ...publicSite(sites.get(site.id)), warnings });
    }));

    app.delete('/api/vpn-sites/:id', auth.requireAdmin, wrap(async (req, res) => {
        const site = siteParam(req, res);
        if (!site) return;
        await deleteSite(site);
        await reload();
        notify();
        res.json({ deleted: true });
    }));

    // Archivo para importar en el router del sitio (lleva su clave privada: sólo administradores)
    app.get('/api/vpn-sites/:id/wireguard.conf', auth.requireAdmin, wrap(async (req, res) => {
        const site = siteParam(req, res);
        if (!site) return;
        const file = `tsst-${site.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || site.id}.conf`;
        res.set('Cache-Control', 'no-store');
        res.attachment(file).type('text/plain').send(await clientConfig(site));
    }));

    /* ---- Control por API: el admin y los operadores con el encoder asignado.
     *      El operador ajusta la codificación, arranca/para emisiones y graba; cambiar a dónde
     *      emite (URL, puerto) y reiniciar el equipo es sólo para administradores. ---- */
    const busy = new Set(); // una orden a la vez por encoder: estos firmwares no toleran escrituras simultáneas
    const control = (fn) => async (req, res) => {
        const id = parseInt(req.params.id, 10);
        const enc = encoders.get(id);
        if (!enc || !require('./access').canSeeEncoder(req.user, id)) return res.status(404).json({ error: 'No encontrado' });
        const st = status.get(id);
        if (st && st.online === false) return res.status(409).json({ error: `${enc.name} no responde: ${st.error || 'sin conexión'}` });
        try {
            await fn(req, res, enc);
        } catch (e) {
            // Nunca 401: el panel lo interpreta como sesión caducada y vuelve al login. Un fallo de
            // credenciales del encoder es un fallo del equipo remoto (502, con code EAUTH).
            const code = e.code === 'EINVAL' || e.code === 'ENODRIVER' ? 400 : 502;
            res.status(code).json({ error: e.message, code: e.code });
        }
    };
    const order = (label, fn) => control(async (req, res, enc) => {
        if (busy.has(enc.id)) return res.status(409).json({ error: 'Hay otra orden en curso para este encoder' });
        busy.add(enc.id);
        try {
            const { driver, api } = await withDriver(enc);
            const what = await fn(req, api, enc, driver);
            console.log(`[ENCODERS] ${req.user.username} → ${enc.name}: ${label}${what ? ` (${what})` : ''}`);
            refreshOne(enc).catch(() => {});
            res.json({ ok: true });
        } finally {
            busy.delete(enc.id);
        }
    });

    // Cada entrada del encoder lleva la señal del servidor a la que va vinculada; un operador
    // sólo ve y maneja las entradas cuya señal tiene asignada
    const withLinks = (enc, state, user) => {
        const chans = encoderChannelsOf(enc);
        const visible = require('./access').visibleEncoderInputs(user, enc.id);
        const inputs = (state.inputs || [])
            .filter(i => visible === null || visible.has(Number(i.id)))
            .map(i => ({ ...i, channel: chans[i.id] != null ? Number(chans[i.id]) : null }));
        return { ...state, inputs };
    };
    // Localiza el stream/emisión de la orden y comprueba que el usuario ve su entrada
    const target = (req, enc, state, what) => {
        const found = drivers.locate(state, what);
        if (!found || !require('./access').canSeeEncoderInput(req.user, enc.id, found.input.id)) {
            throw new drivers.ApiError(what.streamId !== undefined ? 'Ese stream no existe en el encoder' : 'Esa emisión no existe en el encoder', 'EINVAL');
        }
        return found;
    };

    app.get('/api/encoders/:id/control', control(async (req, res, enc) => {
        const { driver, api } = await withDriver(enc);
        if (enc.kind === 'decoder') {
            const state = await api.state(enc);
            const admin = req.user.role === auth.ROLE_ADMIN;
            if (!admin) {
                state.urls = state.urls.map(maskPass);
                if (state.srt) state.srt.channels = state.srt.channels.map(c => ({ ...c, passphrase: c.passphrase ? '***' : '' }));
            }
            // Dirección del servidor tal como la ve el decoder, para montar la URL de sus salidas:
            // la del túnel (o la pública que diga su sitio VPN), o la de la red del servidor en la que está
            let serverAddress = null;
            if (admin) {
                const site = siteOf(enc);
                if (site) serverAddress = siteVideoHost(site, await wgInfo());
                else {
                    const net = localNets().find(n => inCidr(enc.host, n.text));
                    serverAddress = net ? net.address : null;
                }
            }
            res.set('Cache-Control', 'no-store');
            return res.json({ driver, label: driverLabel(driver), canEditUrls: admin, outputs: decoderOutputsOf(enc), serverAddress, ...state });
        }
        const state = withLinks(enc, await api.state(enc), req.user);
        res.set('Cache-Control', 'no-store');
        res.json({ driver, label: driverLabel(driver), canEditUrls: req.user.role === auth.ROLE_ADMIN, ...state });
    }));

    app.post('/api/encoders/:id/control/stream/:sid', order('cambia la codificación', async (req, api, enc) => {
        const ref = drivers.parseStreamId(req.params.sid); // 'entrada:stream' (un número suelto = entrada 1)
        const state = await api.state(enc);
        const { input, stream } = target(req, enc, state, { streamId: `${ref.input}:${ref.index}` });
        const p = drivers.validateStreamParams(req.body || {}, state.caps);
        if (p.rc !== undefined && Array.isArray(stream.rcs) && stream.rcs.length && !stream.rcs.includes(p.rc)) {
            throw new drivers.ApiError(`Este stream no admite el modo ${p.rc}`, 'EINVAL');
        }
        if (p.profile !== undefined) {
            if (!(stream.profiles || []).includes(p.profile)) throw new drivers.ApiError('Este encoder no permite elegir el profile H.264', 'EINVAL');
            if ((p.codec || stream.codec) !== 'H.264') throw new drivers.ApiError('El profile sólo se aplica en H.264', 'EINVAL');
        }
        await api.setStream(enc, stream.id, p);
        return `entrada ${input.id + 1} · ${stream.name}: ${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' ')}`;
    }));

    app.post('/api/encoders/:id/control/output/:oid', order('cambia una salida', async (req, api, enc) => {
        target(req, enc, await api.state(enc), { outputId: req.params.oid });
        const body = req.body || {};
        const p = {};
        if (body.enabled !== undefined) p.enabled = !!body.enabled;
        if (body.url !== undefined) {
            if (req.user.role !== auth.ROLE_ADMIN) throw new drivers.ApiError('Sólo un administrador puede cambiar a dónde emite el encoder', 'EINVAL');
            const url = String(body.url).trim();
            if (!url || url.length > 512 || /[\s"'<>]/.test(url)) throw new drivers.ApiError('URL no válida', 'EINVAL');
            p.url = url;
        }
        if (body.port !== undefined) {
            // El puerto de escucha también decide a dónde hay que conectarse: como la URL, sólo admin
            if (req.user.role !== auth.ROLE_ADMIN) throw new drivers.ApiError('Sólo un administrador puede cambiar el puerto de escucha del encoder', 'EINVAL');
            const port = Number(body.port);
            if (!Number.isInteger(port) || port < 1 || port > 65535) throw new drivers.ApiError('Puerto: entre 1 y 65535', 'EINVAL');
            p.port = port;
        }
        if (!Object.keys(p).length) throw new drivers.ApiError('No hay cambios que aplicar', 'EINVAL');
        await api.setOutput(enc, req.params.oid, p);
        return `${req.params.oid}${p.enabled !== undefined ? (p.enabled ? ' activada' : ' parada') : ''}${p.url ? ` → ${p.url.replace(/passphrase=[^&]*/i, 'passphrase=***')}` : ''}${p.port ? ` → puerto ${p.port}` : ''}`;
    }));

    // Grabación local en el propio encoder (USB, SD, NAS): start | stop | pause | resume
    app.post('/api/encoders/:id/control/record/:rid', order('controla la grabación', async (req, api, enc) => {
        if (typeof api.setRecord !== 'function') throw new drivers.ApiError('Este encoder no graba en local por API', 'EINVAL');
        const found = drivers.locate(await api.state(enc), { recordId: req.params.rid });
        if (!found || !require('./access').canSeeEncoderInput(req.user, enc.id, found.input.id)) {
            throw new drivers.ApiError('Esa grabación no existe en el encoder', 'EINVAL');
        }
        const command = String((req.body && req.body.command) || '');
        if (!['start', 'stop', 'pause', 'resume'].includes(command)) throw new drivers.ApiError('Orden de grabación no válida', 'EINVAL');
        await api.setRecord(enc, found.record.id, command);
        return `grabación ${found.record.label}: ${command}`;
    }));

    // Decoder: qué streams reproduce y cómo divide la pantalla. Cambiar a dónde se conecta es,
    // como las URLs de emisión de un encoder, sólo para administradores.
    app.post('/api/encoders/:id/control/decoder', auth.requireAdmin, order('cambia lo que reproduce el decoder', async (req, api, enc) => {
        if (enc.kind !== 'decoder' || typeof api.setConfig !== 'function') throw new drivers.ApiError('Este equipo no es un decoder', 'EINVAL');
        const body = req.body || {};
        const p = {};
        if (body.split !== undefined && body.split !== '') {
            const split = Number(body.split);
            if (!drivers.DEC_SPLITS.some(s => s.value === split)) throw new drivers.ApiError('División de pantalla no válida', 'EINVAL');
            p.split = split;
        }
        if (body.urls !== undefined) {
            if (!Array.isArray(body.urls) || body.urls.length > 4) throw new drivers.ApiError('URLs no válidas', 'EINVAL');
            p.urls = body.urls.map(u => (u === null ? null : drivers.validateDecoderUrl(u)));
        }
        if (!Object.keys(p).length) throw new drivers.ApiError('No hay cambios que aplicar', 'EINVAL');
        await api.setConfig(enc, p);
        const shown = (p.urls || []).map((u, i) => (u === null ? null : `C${i + 1} ${maskPass(u) || '(vacío)'}`)).filter(Boolean).join(', ');
        return [p.split !== undefined ? `división ${p.split}` : '', shown].filter(Boolean).join(' · ');
    }));

    // Apartado SRT del decoder (pasa el decoder a reproducir SRT, como su web)
    app.post('/api/encoders/:id/control/decoder-srt', auth.requireAdmin, order('cambia el SRT que recibe el decoder', async (req, api, enc) => {
        if (enc.kind !== 'decoder' || typeof api.setSrt !== 'function') throw new drivers.ApiError('Este equipo no es un decoder con SRT', 'EINVAL');
        const body = req.body || {};
        const p = {};
        if (body.split !== undefined && body.split !== '') {
            const split = Number(body.split);
            if (!drivers.DEC_SRT_SPLITS.some(s => s.value === split)) throw new drivers.ApiError('División de pantalla no válida', 'EINVAL');
            p.split = split;
        }
        if (body.channels !== undefined) {
            if (!Array.isArray(body.channels) || body.channels.length > 4) throw new drivers.ApiError('Canales SRT no válidos', 'EINVAL');
            p.channels = body.channels.map((c, i) => drivers.validateDecoderSrt(c, i + 1));
        }
        if (!Object.keys(p).length) throw new drivers.ApiError('No hay cambios que aplicar', 'EINVAL');
        await api.setSrt(enc, p);
        const shown = (p.channels || []).map((c, i) => (!c ? null : `SRT${i + 1} ${!c.enabled ? 'off' : c.mode === 'listener' ? `listener :${c.listenPort}` : `${c.host}:${c.port}`}`)).filter(Boolean).join(', ');
        return [p.split !== undefined ? `división ${p.split}` : '', shown].filter(Boolean).join(' · ');
    }));

    app.post('/api/encoders/:id/control/hdmi', order('cambia la resolución HDMI', async (req, api, enc) => {
        if (enc.kind !== 'decoder' || typeof api.setHdmiMode !== 'function') throw new drivers.ApiError('Este equipo no es un decoder', 'EINVAL');
        const mode = String((req.body && req.body.mode) || '');
        if (!/^[A-Za-z0-9_.-]{1,32}$/.test(mode)) throw new drivers.ApiError('Resolución no válida', 'EINVAL');
        await api.setHdmiMode(enc, mode);
        return mode;
    }));

    app.post('/api/encoders/:id/control/reboot', auth.requireAdmin, order('reinicia el encoder', async (req, api, enc) => {
        await api.reboot(enc);
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
        if (st.api) {
            r.gauge('tsst_encoder_api_up', '1 si la API de control del encoder responde', l, st.api.ok ? 1 : 0);
            if (st.api.ok && typeof st.api.cpu === 'number') r.gauge('tsst_encoder_cpu_percent', 'Uso de CPU del encoder', l, st.api.cpu);
            const chans = encoderChannelsOf(enc);
            for (const inp of (st.api.ok && st.api.inputs) || []) {
                // Cada entrada lleva la señal del servidor a la que está vinculada
                const li = { encoder: enc.id, name: enc.name, input: inp.id + 1, channel: chans[inp.id] ?? '' };
                if (typeof inp.signal === 'boolean') r.gauge('tsst_encoder_input_signal', '1 si la entrada del encoder recibe vídeo (HDMI/SDI)', li, inp.signal ? 1 : 0);
                if (typeof inp.streaming === 'boolean') r.gauge('tsst_encoder_streaming', '1 si la entrada del encoder tiene alguna emisión (SRT/RTMP) activa', li, inp.streaming ? 1 : 0);
                if (typeof inp.recording === 'boolean') r.gauge('tsst_encoder_recording', '1 si el encoder está grabando en local (USB, SD o NAS) esa entrada', li, inp.recording ? 1 : 0);
                for (const s of inp.streams || []) {
                    if (s.bitrate) r.gauge('tsst_encoder_bitrate_kbps', 'Bitrate configurado en el stream del encoder (0 main, 1 sub)', { ...li, stream: s.index === 0 ? 'main' : s.index === 1 ? 'sub' : `sub${s.index}` }, s.bitrate);
                }
            }
        }
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

module.exports = { init, registerRoutes, addMetrics, shutdown, statusList, notify, _test: { parseCidr, inCidr, validateEncoder, stripPanelCookie, siteBlockRe, decoderOutputsOf } };
