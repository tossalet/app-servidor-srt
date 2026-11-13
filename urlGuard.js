// Validación de URLs que escriben los operadores: no pueden usar direcciones
// de este servidor ni claves RTMP de señales que no ven. Módulo puro.
const os = require('os');

const ERR_LOCAL = 'No puedes usar direcciones de este servidor como origen o destino';
const ERR_FORMATO = 'Formato de URL no permitido';
const SCHEMES = new Set(['disk', 'rtmp', 'rtmps', 'srt', 'udp', 'rtsp', 'http', 'https']);
const ERR_CLAVE = 'Esa clave RTMP ya la usa otra señal';

function serverLocalHosts() {
    const hosts = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) hosts.add(String(a.address).toLowerCase());
    }
    return hosts;
}

// Descompone la URL a mano: new URL() no admite srt://:9000 ni udp://@:5000
function parse(url) {
    const m = String(url || '').trim().match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/);
    if (!m) return null;
    const [, scheme, authority, path, query] = m;
    let auth = authority;
    let at = false;
    if (scheme.toLowerCase() === 'udp' && auth.startsWith('@')) { at = true; auth = auth.slice(1); }
    else if (auth.includes('@')) auth = auth.slice(auth.lastIndexOf('@') + 1);
    let host;
    if (auth.startsWith('[')) host = auth.slice(1, auth.indexOf(']') === -1 ? undefined : auth.indexOf(']'));
    else host = auth.replace(/:\d*$/, '');
    return {
        scheme: scheme.toLowerCase(), host: host.toLowerCase(), at, path,
        params: new URLSearchParams(query || '')
    };
}

// IPv6 -> 8 grupos de 16 bits, o null si no es válida. Admite "::" y IPv4 incrustada.
function parseIPv6(h) {
    h = h.split('%')[0];
    const dbl = h.split('::');
    if (dbl.length > 2) return null;
    const toGroups = (part) => {
        if (part === '') return [];
        const out = [];
        const segs = part.split(':');
        for (let i = 0; i < segs.length; i++) {
            const sg = segs[i];
            if (i === segs.length - 1 && sg.includes('.')) {
                const q = sg.split('.');
                if (q.length !== 4 || !q.every(x => /^\d{1,3}$/.test(x) && +x <= 255)) return null;
                out.push((+q[0] << 8) | +q[1], (+q[2] << 8) | +q[3]);
            } else if (/^[0-9a-f]{1,4}$/.test(sg)) out.push(parseInt(sg, 16));
            else return null;
        }
        return out;
    };
    const head = toGroups(dbl[0]);
    const tail = dbl.length === 2 ? toGroups(dbl[1]) : [];
    if (!head || !tail) return null;
    if (dbl.length === 1) return head.length === 8 ? head : null;
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    return [...head, ...new Array(fill).fill(0), ...tail];
}

const quad = (g) => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
const isDottedQuad = (h) => /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(h) && h.split('.').every(x => +x <= 255);

// Forma canónica para comparar: IPv6 expandido, el resto en minúsculas sin punto final
function canon(host) {
    const h = String(host).toLowerCase().replace(/\.+$/, '');
    if (h.includes(':')) {
        const g = parseIPv6(h);
        return g ? g.map(x => x.toString(16)).join(':') : h;
    }
    return h;
}

// 'local' (es este servidor), 'remote' o 'bad' (forma numérica rara que oculta la IP)
function hostKind(host, localHosts) {
    const h = String(host).toLowerCase().replace(/\.+$/, '');
    const locals = new Set([...localHosts].map(canon));
    if (h.includes(':')) {
        const g = parseIPv6(h);
        if (!g) return 'bad';
        if (g.every(x => x === 0) || locals.has(canon(h))) return 'local';
        if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return hostKind(quad(g), localHosts);
        return 'remote';
    }
    if (isDottedQuad(h)) return locals.has(h) || /^127\./.test(h) ? 'local' : 'remote';
    // Decimal, hex u octal sueltos o con puntos (2130706433, 0x7f000001, 0177.0.0.1): rechazar
    if (h !== '' && h.split('.').every(x => /^(0x[0-9a-f]*|\d+)$/.test(x))) return 'bad';
    return locals.has(h) ? 'local' : 'remote';
}

// Ruta RTMP local ("/live/clave" o "/out/clave") de una URL, o null
function localRtmpPath(url, localHosts) {
    const p = parse(url);
    if (!p || (p.scheme !== 'rtmp' && p.scheme !== 'rtmps') || hostKind(p.host, localHosts) === 'remote') return null;
    return p.path;
}

/**
 * Devuelve null si el operador puede usar la URL, o el texto del error.
 *  items: [{ kind, channel, url }] todas las entradas y salidas actuales
 *  canSeeChannel(channel) -> boolean; localHosts: Set de hosts del servidor
 */
function checkOperatorUrl(url, { isInput, items = [], canSeeChannel, localHosts }) {
    const p = parse(url);
    if (!p || !SCHEMES.has(p.scheme)) return ERR_FORMATO;
    if (p.scheme === 'disk') return null;
    const kind = hostKind(p.host, localHosts);
    if (kind === 'bad') return ERR_LOCAL;

    if (p.scheme === 'rtmp' || p.scheme === 'rtmps') {
        if (kind === 'remote') return null;
        const re = isInput ? /^\/live\/[^/]+$/ : /^\/out\/[^/]+$/;
        if (!re.test(p.path)) return ERR_LOCAL;
        const ajena = items.some(it => !canSeeChannel(it.channel) && localRtmpPath(it.url, localHosts) === p.path);
        return ajena ? ERR_CLAVE : null;
    }

    if (p.scheme === 'srt' && (p.host === '' || p.params.get('mode') === 'listener')) return null;
    if (p.scheme === 'udp' && isInput && (p.at || p.host === '' || p.host === '0.0.0.0')) return null;

    return kind === 'local' ? ERR_LOCAL : null;
}

module.exports = { checkOperatorUrl, serverLocalHosts };
