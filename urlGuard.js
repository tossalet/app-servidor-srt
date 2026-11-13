// Validación de URLs que escriben los operadores: no pueden usar direcciones
// de este servidor ni claves RTMP de señales que no ven. Módulo puro.
const os = require('os');

const ERR_LOCAL = 'No puedes usar direcciones de este servidor como origen o destino';
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

function isLocal(host, localHosts) {
    return localHosts.has(host) || /^127\./.test(host);
}

// Ruta RTMP local ("/live/clave" o "/out/clave") de una URL, o null
function localRtmpPath(url, localHosts) {
    const p = parse(url);
    if (!p || (p.scheme !== 'rtmp' && p.scheme !== 'rtmps') || !isLocal(p.host, localHosts)) return null;
    return p.path;
}

/**
 * Devuelve null si el operador puede usar la URL, o el texto del error.
 *  items: [{ kind, channel, url }] todas las entradas y salidas actuales
 *  canSeeChannel(channel) -> boolean; localHosts: Set de hosts del servidor
 */
function checkOperatorUrl(url, { isInput, items = [], canSeeChannel, localHosts }) {
    const p = parse(url);
    if (!p) return null;
    if (p.scheme === 'disk') return null;

    if (p.scheme === 'rtmp' || p.scheme === 'rtmps') {
        if (!isLocal(p.host, localHosts)) return null;
        const re = isInput ? /^\/live\/[^/]+$/ : /^\/out\/[^/]+$/;
        if (!re.test(p.path)) return ERR_LOCAL;
        const ajena = items.some(it => !canSeeChannel(it.channel) && localRtmpPath(it.url, localHosts) === p.path);
        return ajena ? ERR_CLAVE : null;
    }

    if (p.scheme === 'srt' && (p.host === '' || p.params.get('mode') === 'listener')) return null;
    if (p.scheme === 'udp' && isInput && (p.at || p.host === '' || p.host === '0.0.0.0')) return null;

    return isLocal(p.host, localHosts) ? ERR_LOCAL : null;
}

module.exports = { checkOperatorUrl, serverLocalHosts };
