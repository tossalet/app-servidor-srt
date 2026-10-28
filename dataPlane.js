/**
 * DATA PLANE (worker thread)
 *
 * Recibe el MPEG-TS de cada input por UDP local y lo reparte a sus outputs y previews.
 * Corre en un hilo propio para que el panel web, SQLite o un disco USB lento nunca
 * bloqueen el reenvío de paquetes.
 *
 * Sincronización: cada canal tiene un retardo (ms) que se aplica a los suscriptores
 * "delayed" (outputs y grabaciones). Las previews se suscriben en "raw" y no esperan.
 *
 * Protocolo con el hilo principal (postMessage):
 *   -> { cmd:'open',  req, channel, delay }   <- { evt:'opened', req, channel, port }
 *   -> { cmd:'close', channel }
 *   -> { cmd:'sub',   channel, port, raw }
 *   -> { cmd:'unsub', channel, port }
 *   -> { cmd:'delay', channel, delay }
 *   <- { evt:'stats', t, channels: [[channel, bytes, pkts, queuedMs], ...] }  (1/s)
 *   <- { evt:'error', channel, message }
 */
const { parentPort } = require('worker_threads');
const dgram = require('dgram');
const { performance } = require('perf_hooks');

const HOST = '127.0.0.1';
const SOCK_BUF = 8 * 1024 * 1024;
const MAX_DELAY_MS = 10000;
const noop = () => {};

const clampDelay = (ms) => Math.max(0, Math.min(MAX_DELAY_MS, Math.round(Number(ms) || 0)));

// Socket de envío dedicado: los errores ICMP (puerto destino caído) no afectan a la recepción
const tx = dgram.createSocket('udp4');
tx.on('error', noop);
tx.bind(0, HOST, () => { try { tx.setSendBufferSize(SOCK_BUF); } catch (e) {} });

// channel -> { sock, delay, delayed:Set<port>, raw:Set<port>, q:[], qt:[], head, bytes, pkts }
// El canal existe aunque su input esté parado, así los outputs pueden suscribirse antes.
const channels = new Map();

function getChannel(id) {
    let ch = channels.get(id);
    if (!ch) {
        ch = { id, sock: null, delay: 0, delayed: new Set(), raw: new Set(), q: [], qt: [], head: 0, bytes: 0, pkts: 0 };
        channels.set(id, ch);
    }
    return ch;
}

function onPacket(ch, msg) {
    ch.bytes += msg.length;
    ch.pkts++;

    for (const port of ch.raw) tx.send(msg, port, HOST, noop);
    if (ch.delayed.size === 0) return;

    // Envío directo sólo si no hay cola pendiente (mantiene el orden al bajar el retardo a 0)
    if (ch.delay === 0 && ch.head === ch.q.length) {
        for (const port of ch.delayed) tx.send(msg, port, HOST, noop);
        return;
    }
    ch.q.push(msg);
    ch.qt.push(performance.now() + ch.delay);
    startTicker();
}

// Un único temporizador de 1 ms drena las colas de todos los canales con retardo
let ticker = null;
function startTicker() {
    if (!ticker) ticker = setInterval(drain, 1);
}

function drain() {
    const now = performance.now();
    let pending = false;
    for (const ch of channels.values()) {
        const { q, qt } = ch;
        if (ch.head === q.length) continue;
        let h = ch.head;
        while (h < q.length && qt[h] <= now) {
            const msg = q[h];
            q[h] = undefined;
            for (const port of ch.delayed) tx.send(msg, port, HOST, noop);
            h++;
        }
        if (h === q.length) {
            q.length = 0;
            qt.length = 0;
            h = 0;
        } else {
            pending = true;
            // Compactar de vez en cuando para no crecer sin límite
            if (h > 8192) {
                q.splice(0, h);
                qt.splice(0, h);
                h = 0;
            }
        }
        ch.head = h;
    }
    if (!pending) {
        clearInterval(ticker);
        ticker = null;
    }
}

function clearQueue(ch) {
    ch.q.length = 0;
    ch.qt.length = 0;
    ch.head = 0;
}

function openChannel(req, id, delay) {
    const ch = getChannel(id);
    closeSocket(ch);
    ch.delay = clampDelay(delay);

    const sock = dgram.createSocket('udp4');
    ch.sock = sock;
    sock.on('message', (msg) => onPacket(ch, msg));
    sock.on('error', (err) => parentPort.postMessage({ evt: 'error', channel: id, message: err.message }));
    sock.bind(0, HOST, () => {
        try { sock.setRecvBufferSize(SOCK_BUF); } catch (e) {}
        parentPort.postMessage({ evt: 'opened', req, channel: id, port: sock.address().port });
    });
}

function closeSocket(ch) {
    if (ch.sock) {
        try { ch.sock.close(); } catch (e) {}
        ch.sock = null;
    }
    clearQueue(ch);
}

function setDelay(ch, delay) {
    const next = clampDelay(delay);
    const diff = next - ch.delay;
    if (diff === 0) return;
    // Reprogramar lo que ya está en cola: subir el retardo crea un hueco, bajarlo adelanta la salida
    for (let i = ch.head; i < ch.qt.length; i++) ch.qt[i] += diff;
    ch.delay = next;
    if (ch.head < ch.q.length) startTicker();
}

parentPort.on('message', (m) => {
    const id = String(m.channel);
    switch (m.cmd) {
        case 'open':
            openChannel(m.req, id, m.delay);
            break;
        case 'close': {
            const ch = channels.get(id);
            if (ch) closeSocket(ch);
            break;
        }
        case 'sub': {
            const ch = getChannel(id);
            (m.raw ? ch.raw : ch.delayed).add(m.port);
            break;
        }
        case 'unsub': {
            const ch = channels.get(id);
            if (ch) {
                ch.raw.delete(m.port);
                ch.delayed.delete(m.port);
                if (ch.delayed.size === 0) clearQueue(ch);
            }
            break;
        }
        case 'delay':
            setDelay(getChannel(id), m.delay);
            break;
    }
});

// Telemetría real medida en el router (bitrate instantáneo, no la media acumulada de FFmpeg)
setInterval(() => {
    const out = [];
    for (const ch of channels.values()) {
        if (!ch.sock) continue;
        const queuedMs = ch.head < ch.qt.length ? Math.max(0, Math.round(ch.qt[ch.qt.length - 1] - ch.qt[ch.head])) : 0;
        out.push([ch.id, ch.bytes, ch.pkts, queuedMs]);
        ch.bytes = 0;
        ch.pkts = 0;
    }
    parentPort.postMessage({ evt: 'stats', t: Date.now(), channels: out });
}, 1000);
