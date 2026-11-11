/**
 * HTTPS opcional para el panel y los proxies de los encoders.
 *
 * - Sin TLS_CERT_FILE / TLS_KEY_FILE: todo va por HTTP, como siempre (instalación en red local).
 * - Con las dos variables apuntando a un certificado y su clave (PEM): el panel, la API, el socket
 *   y los proxies de los encoders van por HTTPS en los mismos puertos.
 * - Si el certificado falta, no casa con la clave o está mal, se avisa en el log y se arranca por
 *   HTTP: un certificado roto nunca deja el servidor de vídeo sin panel.
 * - Al cambiar los ficheros (renovación) se recargan solos en menos de un minuto, sin cortar nada.
 */
const fs = require('fs');
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');

const CERT_FILE = process.env.TLS_CERT_FILE || '';
const KEY_FILE = process.env.TLS_KEY_FILE || '';
const servers = new Set();
let info = null; // { subject, names, validTo }

function read() {
    const opts = { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
    tls.createSecureContext(opts); // Falla si la clave no corresponde al certificado
    const x = new crypto.X509Certificate(opts.cert);
    info = {
        subject: x.subject.replace(/^CN=/, ''),
        names: (x.subjectAltName || '').replace(/DNS:/g, '').split(/,\s*/).filter(Boolean),
        validTo: new Date(x.validTo)
    };
    return opts;
}

function describe() {
    const days = Math.floor((info.validTo - Date.now()) / 86400000);
    const when = info.validTo.toISOString().slice(0, 10);
    if (days < 0) console.error(`[TLS] ⚠️ El certificado (${info.subject}) CADUCÓ el ${when}. Los navegadores darán error: renuévalo.`);
    else if (days < 30) console.warn(`[TLS] ⚠️ El certificado (${info.subject}) caduca el ${when} (quedan ${days} días). Renuévalo.`);
    else console.log(`[TLS] HTTPS activo con ${info.subject} (${info.names.join(', ') || info.subject}), válido hasta ${when}`);
}

let options = null;
if (CERT_FILE || KEY_FILE) {
    try {
        if (!CERT_FILE || !KEY_FILE) throw new Error('hacen falta TLS_CERT_FILE y TLS_KEY_FILE');
        options = read();
        describe();
    } catch (err) {
        options = null;
        console.error(`[TLS] No se puede usar el certificado (${err.message}). El panel arranca por HTTP.`);
    }
}

// Renovación: si cambian los ficheros, se carga el certificado nuevo en todos los servidores
if (options) {
    let last = '';
    const stamp = () => { try { return [CERT_FILE, KEY_FILE].map(f => fs.statSync(f).mtimeMs).join(':'); } catch (e) { return ''; } };
    last = stamp();
    setInterval(() => {
        const now = stamp();
        if (!now || now === last) return;
        last = now;
        try {
            const fresh = read();
            for (const s of servers) s.setSecureContext(fresh);
            console.log('[TLS] Certificado recargado');
            describe();
        } catch (err) {
            console.error(`[TLS] El certificado nuevo no es válido (${err.message}). Se mantiene el anterior.`);
        }
    }, 60000).unref();
}

function createServer(handler) {
    if (!options) return http.createServer(handler);
    const s = https.createServer(options, handler);
    servers.add(s);
    s.on('close', () => servers.delete(s));
    return s;
}

module.exports = {
    enabled: !!options,
    protocol: options ? 'https' : 'http',
    createServer,
    certificate: () => (info && options ? { subject: info.subject, names: info.names, validTo: info.validTo.toISOString() } : null)
};
