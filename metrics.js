/**
 * MÉTRICAS PROMETHEUS (GET /metrics, formato de texto 0.0.4)
 *
 * Acceso (Prometheus no puede iniciar sesión con cookie):
 *   - METRICS_TOKEN definido: cabecera "Authorization: Bearer <token>"
 *   - Sin token: sólo desde la propia máquina (127.0.0.1 / ::1)
 *   - Siempre: un administrador con sesión abierta en el navegador
 *
 * Unidades base de Prometheus: segundos, bytes y bits por segundo. Las etiquetas nunca llevan
 * la URL completa (puede contener passphrase o claves de streaming).
 */
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');
const db = require('./db');
const auth = require('./auth');
const streamManager = require('./streamManager');
const sysMonitor = require('./sysMonitor');
const srt = require('./srt');
const { version } = require('./package.json');

const METRICS_TOKEN = process.env.METRICS_TOKEN || '';
const startedAt = Date.now();

// Retardo del event loop del hilo principal (el data plane va aparte)
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

/* =======================================
 *  ACCESO
 * ======================================= */
// Una petición reenviada por un proxy local también viene de 127.0.0.1: esa no cuenta como local
function isLocalRequest(req) {
    const ip = req.socket.remoteAddress;
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    return loopback && !req.headers['x-forwarded-for'] && !req.headers['forwarded'];
}

function tokenMatches(header) {
    if (!METRICS_TOKEN || !header || !header.startsWith('Bearer ')) return false;
    const given = Buffer.from(header.slice(7));
    const expected = Buffer.from(METRICS_TOKEN);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function authorize(req, res, next) {
    if (tokenMatches(req.headers.authorization)) return next();
    const user = auth.sessionFromHeaders(req.headers);
    if (user && !user.mustChange && user.role === auth.ROLE_ADMIN) return next();
    if (!METRICS_TOKEN && isLocalRequest(req)) return next();
    res.status(401).set('WWW-Authenticate', 'Bearer').type('text/plain')
        .send(METRICS_TOKEN ? 'Token requerido\n' : 'Sólo accesible desde localhost (define METRICS_TOKEN para acceso remoto)\n');
}

/* =======================================
 *  FORMATO
 * ======================================= */
const escapeLabel = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

class Registry {
    constructor() { this.families = new Map(); }

    add(name, type, help, labels, value) {
        if (value === undefined || value === null || Number.isNaN(value)) return;
        let f = this.families.get(name);
        if (!f) {
            f = { type, help, samples: [] };
            this.families.set(name, f);
        }
        const l = Object.entries(labels || {}).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
        f.samples.push(`${name}${l ? `{${l}}` : ''} ${Number(value)}`);
    }

    gauge(name, help, labels, value) { this.add(name, 'gauge', help, labels, value); }
    counter(name, help, labels, value) { this.add(name, 'counter', help, labels, value); }

    toString() {
        let out = '';
        for (const [name, f] of this.families) {
            out += `# HELP ${name} ${f.help}\n# TYPE ${name} ${f.type}\n${f.samples.join('\n')}\n`;
        }
        return out;
    }
}

const dbAll = (sql) => new Promise((resolve) => db.all(sql, [], (err, rows) => resolve(err ? [] : rows)));

// Métricas SRT comunes a entradas y salidas
function addSrt(r, labels, s, totals, dir) {
    if (totals) {
        r.counter('tsst_srt_packets_total', 'Paquetes SRT transferidos', { ...labels, direction: dir }, totals.pkts);
        r.counter('tsst_srt_packets_lost_total', 'Paquetes SRT perdidos detectados (la mayoría se recuperan por ARQ)', { ...labels, direction: dir }, totals.lost);
        r.counter('tsst_srt_packets_retransmitted_total', 'Paquetes SRT retransmitidos', { ...labels, direction: dir }, totals.retrans);
        r.counter('tsst_srt_packets_dropped_total', 'Paquetes SRT descartados por llegar tarde (cortes visibles)', { ...labels, direction: dir }, totals.drops);
        r.counter('tsst_srt_bytes_total', 'Bytes SRT transferidos', { ...labels, direction: dir }, totals.bytes);
    }
    r.gauge('tsst_srt_connected', '1 si el enlace SRT está conectado y reportando', { ...labels, direction: dir }, s ? 1 : 0);
    if (!s) return;
    r.gauge('tsst_srt_rtt_seconds', 'RTT del enlace SRT', { ...labels, direction: dir }, s.rtt / 1000);
    r.gauge('tsst_srt_rate_bits_per_second', 'Tasa SRT actual', { ...labels, direction: dir }, s.mbps * 1e6);
    r.gauge('tsst_srt_link_bandwidth_bits_per_second', 'Ancho de banda estimado del enlace', { ...labels, direction: dir }, s.bandwidth * 1e6);
    r.gauge('tsst_srt_buffer_seconds', 'Contenido del buffer SRT', { ...labels, direction: dir }, s.msBuf / 1000);
    if (s.latency) r.gauge('tsst_srt_latency_seconds', 'Latencia SRT efectiva negociada', { ...labels, direction: dir }, s.latency / 1000);
    r.gauge('tsst_srt_connected_seconds', 'Tiempo desde que se estableció la conexión SRT', { ...labels, direction: dir }, (Date.now() - s.since) / 1000);
}

async function collect() {
    const r = new Registry();
    const snap = streamManager.getMetricsSnapshot();

    r.gauge('tsst_info', 'Información del servidor', { version, srt_engine: srt.SLT ? 'srt-live-transmit' : 'ffmpeg' }, 1);
    r.gauge('tsst_start_time_seconds', 'Arranque del servidor (epoch)', {}, startedAt / 1000);

    // Configuración (incluye lo deshabilitado, que no está en memoria)
    const [inRows, outRows] = await Promise.all([dbAll('SELECT enabled FROM inputs'), dbAll('SELECT enabled FROM outputs')]);
    r.gauge('tsst_inputs_configured', 'Inputs configurados', {}, inRows.length);
    r.gauge('tsst_inputs_enabled', 'Inputs habilitados', {}, inRows.filter(x => x.enabled).length);
    r.gauge('tsst_outputs_configured', 'Outputs configurados', {}, outRows.length);
    r.gauge('tsst_outputs_enabled', 'Outputs habilitados', {}, outRows.filter(x => x.enabled).length);

    for (const i of snap.inputs) {
        const l = { channel: i.channel, name: i.name, protocol: i.protocol };
        r.gauge('tsst_input_up', '1 si el proceso de ingesta está en marcha', { ...l, engine: i.engine }, i.running ? 1 : 0);
        r.gauge('tsst_input_signal', '1 si llegan datos', l, i.signal ? 1 : 0);
        r.gauge('tsst_input_bitrate_bits_per_second', 'Bitrate de entrada medido en el data plane', l, i.bitrateBps);
        r.counter('tsst_input_received_bytes_total', 'Bytes recibidos por el data plane', l, i.bytesTotal);
        r.gauge('tsst_input_signal_seconds', 'Tiempo con señal continua', l, i.uptimeSec);
        r.counter('tsst_input_restarts_total', 'Reinicios del proceso de ingesta', l, i.restarts);
        r.gauge('tsst_input_sync_delay_seconds', 'Retardo de sincronía configurado', l, i.delayMs / 1000);
        r.gauge('tsst_input_sync_queue_seconds', 'Vídeo retenido en la cola de sincronía', l, i.queuedMs / 1000);
        if (i.protocol === 'srt' && i.engine === 'srt-live-transmit') addSrt(r, l, i.srt, i.srtTotals, 'recv');
    }

    for (const o of snap.outputs) {
        const l = { id: o.id, channel: o.channel, location: o.location, protocol: o.protocol };
        r.gauge('tsst_output_up', '1 si el proceso de salida está en marcha', { ...l, vcodec: o.vcodec }, o.running ? 1 : 0);
        r.gauge('tsst_output_bitrate_bits_per_second', 'Bitrate de salida', l, o.bitrateBps);
        r.counter('tsst_output_restarts_total', 'Reinicios del proceso de salida', l, o.restarts);
        if (o.srtTotals || o.srt) addSrt(r, { channel: o.channel, output: o.id, location: o.location }, o.srt, o.srtTotals, 'send');
    }

    const host = sysMonitor.getLastHost();
    if (host) {
        r.gauge('tsst_host_cpu_load_ratio', 'Carga de CPU del host (0-1)', {}, host.cpuLoad);
        r.gauge('tsst_host_memory_used_bytes', 'Memoria en uso del host', {}, host.memUsed);
        r.gauge('tsst_host_memory_total_bytes', 'Memoria total del host', {}, host.memTotal);
        r.gauge('tsst_host_network_transmit_bits_per_second', 'Tráfico de red saliente', {}, host.netTxBps);
        r.gauge('tsst_host_network_receive_bits_per_second', 'Tráfico de red entrante', {}, host.netRxBps);
    }

    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    r.gauge('process_resident_memory_bytes', 'Memoria residente del proceso Node', {}, mem.rss);
    r.counter('process_cpu_seconds_total', 'CPU usada por el proceso Node (sin FFmpeg)', {}, (cpu.user + cpu.system) / 1e6);
    r.gauge('tsst_eventloop_lag_p99_seconds', 'Retardo p99 del event loop desde el último scrape', {}, loopDelay.percentile(99) / 1e9);
    loopDelay.reset();

    return r.toString();
}

async function handler(req, res) {
    res.type('text/plain; version=0.0.4; charset=utf-8').send(await collect());
}

module.exports = { authorize, handler, collect };
