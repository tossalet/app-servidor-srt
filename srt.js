/**
 * SRT: utilidades basadas en la documentación oficial de Haivision (github.com/Haivision/srt)
 *
 * - srt-live-transmit (paquete srt-tools): transporte SRT nativo sin remux y con estadísticas
 *   reales del enlace (RTT, pérdidas, retransmisiones, drops, buffer).
 * - Unidades: en las URLs del panel la latencia va en ms (unidad nativa de SRT). FFmpeg
 *   espera microsegundos en latency/rcvlatency/peerlatency, así que se convierte al usarlo.
 * - Buffers: tamaño mínimo del buffer según docs/API/configuration-guidelines.md
 *     paquetes = bps / 8 × (latencia + RTT) / payload
 *   Por defecto SRT reserva 8192 paquetes (~86 Mbit): con bitrates altos y latencias largas
 *   se queda corto y descarta paquetes.
 */
const { spawnSync } = require('child_process');

const PAYLOAD = 1316;            // 7 paquetes TS por paquete SRT
const MSS_PAYLOAD = 1472;        // MSS 1500 - 28 de cabeceras IPv4/UDP
const DEFAULT_PKTS = 8192;       // Buffer por defecto de libsrt
const DEFAULT_LATENCY_MS = 120;  // Latencia por defecto de libsrt
const RTT_MARGIN_MS = 250;       // Margen de RTT cuando aún no se ha medido
const MAX_MBPS = parseFloat(process.env.SRT_MAX_MBPS) || 60; // Bitrate máximo previsto por señal

// srt-live-transmit disponible (salvo que se fuerce FFmpeg con SRT_ENGINE=ffmpeg)
function findSrtLiveTransmit() {
    if (process.env.SRT_ENGINE === 'ffmpeg') return null;
    const bin = process.env.SRT_LIVE_TRANSMIT_PATH || 'srt-live-transmit';
    const r = spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 3000 });
    return r.error ? null : bin;
}
const SLT = findSrtLiveTransmit();
console.log(SLT
    ? `[SRT] Motor SRT nativo: ${SLT} (estadísticas de enlace activadas)`
    : '[SRT] srt-live-transmit no encontrado: SRT vía FFmpeg (instala srt-tools para estadísticas de enlace)');

// Estadísticas JSON en una línea; -s cuenta paquetes (500 ≈ 0,5 s a 10 Mbps)
const STATS_ARGS = ['-s', '500', '-pf', 'json', '-loglevel', 'error'];

/* =======================================
 *  URLs
 * ======================================= */
function splitUrl(url) {
    const qi = url.indexOf('?');
    const params = qi < 0 ? [] : url.slice(qi + 1).split('&').filter(Boolean).map(kv => {
        const i = kv.indexOf('=');
        return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
    });
    return { base: qi < 0 ? url : url.slice(0, qi), params };
}

function joinUrl(base, params) {
    return params.length ? `${base}?${params.map(([k, v]) => v === '' ? k : `${k}=${v}`).join('&')}` : base;
}

const getParam = (params, key) => {
    const p = params.find(([k]) => k === key);
    return p ? p[1] : undefined;
};

// Añade buffer y ventana de control de flujo si la latencia lo exige y el usuario no los fijó
function addBufferParams(params, side, names) {
    const bufKey = side === 'recv' ? names.rcvbuf : names.sndbuf;
    if (getParam(params, bufKey) !== undefined || getParam(params, names.fc) !== undefined) return;
    const latency = parseInt(getParam(params, 'latency') || getParam(params, side === 'recv' ? 'rcvlatency' : 'peerlatency'), 10) || DEFAULT_LATENCY_MS;
    const pkts = Math.ceil(MAX_MBPS * 1e6 / 8 * (latency + RTT_MARGIN_MS) / 1000 / PAYLOAD);
    if (pkts <= DEFAULT_PKTS) return;
    // fc primero: libsrt recorta rcvbuf al tamaño de la ventana de control de flujo
    params.push([names.fc, String(pkts)], [bufKey, String(pkts * MSS_PAYLOAD)]);
}

const LATENCY_KEYS = new Set(['latency', 'rcvlatency', 'peerlatency']);

// URL para FFmpeg: latencias de ms a µs y buffers en sus nombres de opción
function forFfmpeg(url, side) {
    const { base, params } = splitUrl(url);
    addBufferParams(params, side, { fc: 'ffs', rcvbuf: 'rcvbuf', sndbuf: 'sndbuf' });
    return joinUrl(base, params.map(([k, v]) => (LATENCY_KEYS.has(k) && /^\d+$/.test(v)) ? [k, String(parseInt(v, 10) * 1000)] : [k, v]));
}

// Opciones que sólo entiende FFmpeg (o que en FFmpeg usan otras unidades)
const FFMPEG_ONLY = new Set(['pkt_size', 'buffer_size', 'fifo_size', 'overrun_nonfatal', 'timeout', 'listen_timeout', 'rw_timeout', 'smoother']);

// URL para srt-live-transmit: nombres de socket option de libsrt
function forSrtLiveTransmit(url, side) {
    const { base, params } = splitUrl(url);
    const clean = params
        .filter(([k]) => !FFMPEG_ONLY.has(k))
        .map(([k, v]) => k === 'payload_size' ? ['payloadsize', v] : [k, v]);
    addBufferParams(clean, side, { fc: 'fc', rcvbuf: 'rcvbuf', sndbuf: 'sndbuf' });
    return joinUrl(base, clean);
}

/* =======================================
 *  ESTADÍSTICAS (salida JSON de srt-live-transmit)
 *  Los contadores de cada informe son del intervalo (se reinician en cada informe).
 * ======================================= */

// Lee el stdout del proceso y acumula estadísticas en target.srt
function attachStats(child, target, dir, onReport) {
    target.srt = { acc: { pkts: 0, lost: 0, retrans: 0, drops: 0 }, dropsTotal: 0, last: null, at: 0, since: null };
    // Contadores acumulados de la señal (sobreviven a reconexiones): para /metrics
    if (!target.srtTotals) target.srtTotals = { pkts: 0, lost: 0, retrans: 0, drops: 0, bytes: 0 };
    let buf = '';
    child.stdout.on('data', (data) => {
        buf += data.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line[0] !== '{') continue;
            let j;
            try { j = JSON.parse(line); } catch (e) { continue; }
            if (!j.link || !j[dir]) continue; // también llegan líneas {"bandwidth":x}
            const d = j[dir];
            const s = target.srt;
            s.acc.pkts += d.packets || 0;
            s.acc.lost += d.packetsLost || 0;
            s.acc.retrans += d.packetsRetransmitted || 0;
            s.acc.drops += d.packetsDropped || 0;
            s.dropsTotal += d.packetsDropped || 0;
            const t = target.srtTotals;
            t.pkts += d.packets || 0;
            t.lost += d.packetsLost || 0;
            t.retrans += d.packetsRetransmitted || 0;
            t.drops += d.packetsDropped || 0;
            t.bytes += d.bytes || 0;
            s.last = {
                rtt: j.link.rtt || 0,
                bandwidth: j.link.bandwidth || 0,
                mbps: d.mbitRate || 0,
                msBuf: d.msBuf || 0,
                latency: d.msTsbPdDelay || 0
            };
            s.at = Date.now();
            if (!s.since) s.since = s.at;
            if (onReport) onReport();
        }
        if (buf.length > 65536) buf = '';
    });
}

// Resumen para la UI y reinicio de la ventana; null si no hay datos recientes (sin conexión)
function summarize(target) {
    const s = target.srt;
    if (!s || !s.last || Date.now() - s.at > 5000) return null;
    const { pkts, lost, retrans } = s.acc;
    const total = pkts + lost;
    const out = {
        rtt: Math.round(s.last.rtt * 10) / 10,
        mbps: Math.round(s.last.mbps * 100) / 100,
        bandwidth: Math.round(s.last.bandwidth),
        msBuf: s.last.msBuf,
        latency: s.last.latency,
        lossPct: total ? Math.round(lost / total * 1000) / 10 : 0,
        retransPct: pkts ? Math.round(retrans / pkts * 1000) / 10 : 0,
        drops: s.dropsTotal
    };
    s.acc = { pkts: 0, lost: 0, retrans: 0, drops: 0 };
    return out;
}

// Últimos valores sin tocar la ventana de la UI; null si no hay conexión activa
function snapshot(target) {
    const s = target.srt;
    if (!s || !s.last || Date.now() - s.at > 5000) return null;
    return { ...s.last, since: s.since };
}

module.exports = {
    SLT,
    snapshot,
    STATS_ARGS,
    forFfmpeg,
    forSrtLiveTransmit,
    attachStats,
    summarize
};
