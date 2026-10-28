const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const srt = require('./srt');

const SOCK_BUF = 8 * 1024 * 1024;
const RESTART_MIN_MS = 1000;
const RESTART_MAX_MS = 5000;
const MAX_DELAY_MS = 10000;
const HISTORY_POINTS = 60;
const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';

// Miniaturas en RAM (tmpfs) en Linux: no desgasta el SSD y es más rápido
const THUMBS_DIR = (process.platform === 'linux' && fs.existsSync('/dev/shm'))
    ? '/dev/shm/tsst-thumbs'
    : path.join(__dirname, 'public', 'thumbs');
try { fs.mkdirSync(THUMBS_DIR, { recursive: true }); } catch (e) {}

let ioInstance = null;
function setIo(io) { ioInstance = io; }

// Estado en memoria. Claves siempre como string (la BBDD da números, las rutas strings)
const inputs = new Map();   // channel -> estado del input
const outputs = new Map();  // id -> estado del output
const telemetryCache = {};  // 'channel' | 'out_id' -> [{ t, y }]

// Locate FFmpeg binary (handles Windows local download vs Linux global)
function findFFmpeg() {
    if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
    if (os.platform() === 'win32') {
        const binDir = path.join(__dirname, 'ffmpeg_bin');
        if (fs.existsSync(binDir)) {
            // Find inner folder (like ffmpeg-7.0.2-essentials_build)
            for (const sub of fs.readdirSync(binDir)) {
                const exePath = path.join(binDir, sub, 'bin', 'ffmpeg.exe');
                if (fs.existsSync(exePath)) return exePath;
            }
        }
    }
    return 'ffmpeg';
}
const FFMPEG = findFFmpeg();

/* =======================================
 *  DATA PLANE (worker thread de reenvío UDP)
 * ======================================= */
const dataPlane = new Worker(path.join(__dirname, 'dataPlane.js'));
const pendingOpens = new Map();
let reqSeq = 0;

dataPlane.on('message', (m) => {
    if (m.evt === 'opened') {
        const resolve = pendingOpens.get(m.req);
        if (resolve) {
            pendingOpens.delete(m.req);
            resolve(m.port);
        }
    } else if (m.evt === 'stats') {
        onDataPlaneStats(m);
    } else if (m.evt === 'error') {
        console.error(`[DATAPLANE ${m.channel}] ${m.message}`);
    }
});
dataPlane.on('error', (err) => {
    // Sin data plane no hay vídeo: salimos para que systemd/docker reinicie limpio
    console.error('[DATAPLANE] Fatal:', err);
    process.exit(1);
});

function dpOpen(channel, delay) {
    return new Promise((resolve) => {
        const req = ++reqSeq;
        pendingOpens.set(req, resolve);
        dataPlane.postMessage({ cmd: 'open', req, channel, delay });
    });
}
const dpClose = (channel) => dataPlane.postMessage({ cmd: 'close', channel });
const dpSub = (channel, port, raw) => dataPlane.postMessage({ cmd: 'sub', channel, port, raw });
const dpUnsub = (channel, port) => dataPlane.postMessage({ cmd: 'unsub', channel, port });

// El SO nos da un puerto UDP libre: evita colisiones entre outputs, previews y puertos SRT
function getFreeUdpPort() {
    return new Promise((resolve, reject) => {
        const s = dgram.createSocket('udp4');
        s.on('error', reject);
        s.bind(0, '127.0.0.1', () => {
            const port = s.address().port;
            s.close(() => resolve(port));
        });
    });
}

/* =======================================
 *  HELPERS
 * ======================================= */

// Añade parámetros a la URL sólo si el usuario no los ha puesto ya (sin re-codificar los existentes)
function withDefaults(url, params) {
    const qi = url.indexOf('?');
    const query = qi >= 0 ? url.slice(qi + 1) : '';
    const have = new Set(query.split('&').map(kv => kv.split('=')[0]).filter(Boolean));
    const extra = Object.entries(params).filter(([k]) => !have.has(k)).map(([k, v]) => `${k}=${v}`);
    if (extra.length === 0) return url;
    const sep = qi < 0 ? '?' : (query === '' || url.endsWith('&') ? '' : '&');
    return url + sep + extra.join('&');
}

function normCodec(c) {
    c = c.toUpperCase();
    if (c === 'HEVC') return 'H.265';
    if (c === 'H264') return 'H.264';
    return c;
}

function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

// Guarda las últimas líneas de stderr para poder diagnosticar caídas sin inundar el log
function keepTail(st, chunk) {
    st.tail = (st.tail + chunk).slice(-1500);
}

function pushTelemetry(key, point) {
    const h = telemetryCache[key] || (telemetryCache[key] = []);
    h.push(point);
    if (h.length > HISTORY_POINTS) h.shift();
}

function emit(event, data) {
    if (ioInstance) ioInstance.emit(event, data);
}

const logError = (tag) => (err) => console.error(`[${tag}]`, err && err.message ? err.message : err);

function nextBackoff(st, startedAt) {
    st.backoff = (Date.now() - startedAt > 10000) ? RESTART_MIN_MS : Math.min(st.backoff * 2, RESTART_MAX_MS);
    return st.backoff;
}

/* =======================================
 *  INPUTS
 * ======================================= */

/**
 * Start an Input Stream (Listener or Pull)
 * Receives external signal and pushes it to the data plane over local UDP.
 */
async function startInput(inputObj) {
    const channel = String(inputObj.channel);
    if (inputs.has(channel)) {
        console.log(`Input ${channel} is already running.`);
        return false;
    }

    const st = {
        channel, cfg: inputObj, proc: null, port: null, stopped: false,
        restartTimer: null, backoff: RESTART_MIN_MS, tail: '',
        codec: '', signalSince: null, silentSecs: 0, delay: inputObj.delay_ms || 0,
        preview: null
    };
    inputs.set(channel, st);

    st.port = await dpOpen(channel, st.delay);
    if (st.stopped) return false; // Lo pararon mientras abríamos el socket

    spawnInputProcess(st);

    // Si preview está desactivada, sacamos igualmente un fotograma fijo
    startPreview(channel, inputObj.preview_enabled === 0).catch(logError(`PREVIEW-${channel}`));
    return true;
}

function spawnInputProcess(st) {
    let src = st.cfg.url;
    const isSrt = src.startsWith('srt://');
    // SRT nativo: srt-live-transmit entrega el TS tal cual al data plane (sin remux) y da estadísticas del enlace
    const viaSlt = isSrt && !!srt.SLT;
    let cmd, args;

    if (viaSlt) {
        cmd = srt.SLT;
        args = [srt.forSrtLiveTransmit(src, 'recv'), `udp://127.0.0.1:${st.port}?sndbuf=${SOCK_BUF}`, ...srt.STATS_ARGS];
    } else {
        if (src.startsWith('udp://')) src = withDefaults(src, { overrun_nonfatal: 1, buffer_size: SOCK_BUF });
        if (isSrt) src = srt.forFfmpeg(src, 'recv');
        cmd = FFMPEG;
        args = [
            '-hide_banner', '-nostats', '-loglevel', 'info',
            '-fflags', '+genpts',
            '-i', src,
            '-map', '0:v?', '-map', '0:a?',
            '-c', 'copy',
            // El muxer MPEG-TS inserta solo h264/hevc_mp4toannexb cuando hace falta (RTMP/FLV)
            '-f', 'mpegts',
            '-muxdelay', '0.1',
            `udp://127.0.0.1:${st.port}?pkt_size=1316&buffer_size=${SOCK_BUF}`
        ];
    }

    console.log(`[STARTING INPUT ${st.channel}] ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { stdio: ['ignore', viaSlt ? 'pipe' : 'ignore', 'pipe'] });
    const startedAt = Date.now();
    st.proc = child;
    st.tail = '';
    st.srt = null;
    if (viaSlt) srt.attachStats(child, st, 'recv');

    let header = '';
    child.stderr.on('data', (data) => {
        const out = data.toString();
        // El códec aparece una sola vez al abrir la fuente; con -nostats no hay más ruido que parsear
        if (!st.codec && header.length < 16384) {
            header += out;
            const m = header.match(/Video:\s*([a-zA-Z0-9_-]+)/);
            if (m) {
                st.codec = normCodec(m[1]);
                header = '';
            }
        }
        keepTail(st, out);
    });

    child.on('error', (err) => {
        console.error(`[FATAL IN-${st.channel}] ${cmd} missing or crashed:`, err.message);
    });

    child.on('close', (code) => {
        if (st.proc !== child) return;
        st.proc = null;
        st.srt = null;
        if (st.stopped) return;

        st.restarts = (st.restarts || 0) + 1;
        const wait = nextBackoff(st, startedAt);
        console.log(`[IN-${st.channel}] ${viaSlt ? 'srt-live-transmit' : 'FFmpeg'} exited (${code}). Reintento en ${wait} ms. Últimas líneas:\n${st.tail.trim().split('\n').slice(-3).join('\n')}`);
        // Amarillo en la UI: activo pero sin señal
        emit('stats', { channel: st.channel, active: true, bitrate: '0.0kbits/s', time: '--:--:--' });
        st.restartTimer = setTimeout(() => {
            st.restartTimer = null;
            if (!st.stopped) spawnInputProcess(st);
        }, wait);
    });
}

/**
 * Stop an Input Stream
 */
function stopInput(channel) {
    channel = String(channel);
    const st = inputs.get(channel);
    if (!st) return false;

    console.log(`[STOPPING INPUT ${channel}] Killing process and router...`);
    st.stopped = true;
    inputs.delete(channel);
    if (st.restartTimer) clearTimeout(st.restartTimer);
    killPreview(st);
    if (st.proc) st.proc.kill('SIGKILL');
    dpClose(channel);

    delete telemetryCache[channel];
    // Remove thumbnail so UI flips to TV Bars
    fs.unlink(path.join(THUMBS_DIR, `thumb_${channel}.jpg`), () => {});
    emit('stats', { channel, active: false });
    return true;
}

/**
 * Retardo de sincronización en vivo (ms). Afecta a outputs y grabaciones, no a la preview.
 * No reinicia nada: el data plane reprograma los paquetes ya en cola.
 */
function setDelay(channel, delayMs) {
    channel = String(channel);
    const delay = Math.max(0, Math.min(MAX_DELAY_MS, Math.round(Number(delayMs) || 0)));
    const st = inputs.get(channel);
    if (st) {
        st.delay = delay;
        st.cfg.delay_ms = delay;
    }
    dataPlane.postMessage({ cmd: 'delay', channel, delay });
    return delay;
}

// Telemetría de inputs: medida en el data plane (bitrate instantáneo real)
function onDataPlaneStats(m) {
    const t = new Date(m.t).toLocaleTimeString();
    for (const [channel, bytes, , queuedMs] of m.channels) {
        const st = inputs.get(channel);
        if (!st) continue;

        if (bytes > 0) {
            st.silentSecs = 0;
            if (!st.signalSince) st.signalSince = m.t;
        } else if (++st.silentSecs >= 3) {
            st.signalSince = null;
        }

        const kbps = (bytes * 8) / 1000;
        st.lastKbps = kbps;
        st.bytesTotal = (st.bytesTotal || 0) + bytes;
        st.queuedMs = queuedMs;
        const point = { t, y: Math.round(kbps * 10) / 10 };
        pushTelemetry(channel, point);
        emit('stats', {
            channel,
            bitrate: `${kbps.toFixed(1)}kbits/s`,
            time: st.signalSince ? fmtDuration(m.t - st.signalSince) : '--:--:--',
            active: true,
            codec: st.codec,
            delay: st.delay,
            queuedMs,
            srt: st.srt ? srt.summarize(st) : undefined,
            point
        });
    }
}

/* =======================================
 *  PREVIEW (miniaturas)
 * ======================================= */

async function startPreview(channel, singleFrame = false) {
    channel = String(channel);
    const st = inputs.get(channel);
    if (!st) return;
    killPreview(st);

    const port = await getFreeUdpPort();
    if (st.stopped || inputs.get(channel) !== st) return;
    killPreview(st); // Por si llegaron dos peticiones a la vez

    const thumbPath = path.join(THUMBS_DIR, `thumb_${channel}.jpg`);
    const args = [
        '-hide_banner', '-nostats', '-loglevel', 'info',
        // Sólo se decodifican keyframes: coste de CPU mínimo incluso en HEVC 4K
        '-skip_frame', 'nokey',
        '-i', `udp://127.0.0.1:${port}?overrun_nonfatal=1&buffer_size=${SOCK_BUF}`,
        '-map', '0:v:0?', '-an', '-sn', '-dn',
        '-vf', 'scale=480:-2',
        '-q:v', '5'
    ];
    if (singleFrame) args.push('-frames:v', '1');
    args.push('-update', '1', '-f', 'image2', thumbPath);

    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const prev = { proc: child, port, timer: null };
    // Se lee siempre stderr (un pipe sin leer acaba congelando FFmpeg). De aquí sale el códec
    // cuando la entrada es SRT nativo y no pasa por FFmpeg.
    let header = '';
    let codecDone = false;
    child.stderr.on('data', (data) => {
        if (codecDone) return;
        header += data.toString();
        const m = header.match(/Video:\s*([a-zA-Z0-9_-]+)/);
        if (m) st.codec = normCodec(m[1]);
        if (m || header.length > 16384) codecDone = true;
    });
    st.preview = prev;
    dpSub(channel, port, true);

    if (singleFrame) {
        // Tiempo de sobra para un GOP largo en H.265
        prev.timer = setTimeout(() => { if (st.preview === prev) killPreview(st); }, 15000);
    }

    child.on('error', () => {});
    child.on('close', () => {
        dpUnsub(channel, port);
        if (st.preview === prev) {
            clearTimeout(prev.timer);
            st.preview = null;
        }
    });
}

function killPreview(st) {
    const prev = st.preview;
    if (!prev) return;
    st.preview = null;
    clearTimeout(prev.timer);
    dpUnsub(st.channel, prev.port);
    prev.proc.kill('SIGKILL');
}

function stopPreview(channel) {
    const st = inputs.get(String(channel));
    if (st) killPreview(st);
}

/* =======================================
 *  OUTPUTS
 * ======================================= */

/**
 * Start an Output Stream
 * Pulls from the data plane over local UDP and pushes to the destination URL.
 * Si el input aún no tiene señal, FFmpeg espera; en cuanto llegan datos arranca solo.
 */
async function startOutput(outputObj) {
    const id = String(outputObj.id);
    if (outputs.has(id)) {
        console.log(`Output ${id} is already running.`);
        return false;
    }
    const st = {
        id, channel: String(outputObj.channel), cfg: outputObj, proc: null, port: null,
        stopped: false, restartTimer: null, backoff: RESTART_MIN_MS, tail: '',
        lastSize: null, lastT: 0, lastUpdate: Date.now()
    };
    outputs.set(id, st);
    await spawnOutputProcess(st);
    return true;
}

function diskTarget(url) {
    let destUrl = url.replace('disk://', '');
    // AUTO-TIMESTAMP TO PREVENT OVERWRITES: NombreInput_20260418_223500.mp4
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const df = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}_${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;

    const lastSlash = Math.max(destUrl.lastIndexOf('/'), destUrl.lastIndexOf('\\'));
    const lastDot = destUrl.lastIndexOf('.');
    if (lastDot > lastSlash) {
        destUrl = destUrl.substring(0, lastDot) + '_' + df + destUrl.substring(lastDot);
    } else {
        destUrl += '_' + df + '.mp4';
    }

    const lower = destUrl.toLowerCase();
    const format = lower.endsWith('.ts') ? 'mpegts' : lower.endsWith('.mkv') ? 'matroska' : 'mp4';
    return { destUrl, format };
}

// Opciones de vídeo según el códec elegido en la UI
function videoArgs(vcodec) {
    switch (vcodec) {
        case 'copy':
            return { pre: [], post: ['-c:v', 'copy'] };
        case 'h264_vaapi':
        case 'hevc_vaapi':
            // Intel Quick Sync vía VAAPI: decodifica y codifica en la iGPU sin copiar frames a RAM
            // (format=nv12|vaapi,hwupload vale tanto si el decode va por GPU como si cae a software)
            return {
                pre: ['-vaapi_device', VAAPI_DEVICE, '-hwaccel', 'vaapi', '-hwaccel_output_format', 'vaapi'],
                post: ['-vf', 'format=nv12|vaapi,hwupload', '-c:v', vcodec, '-bf', '0']
            };
        case 'libx265':
            return { pre: [], post: ['-c:v', 'libx265', '-preset', 'ultrafast', '-tune', 'zerolatency'] };
        default:
            return { pre: [], post: ['-c:v', vcodec, '-preset', 'ultrafast', '-tune', 'zerolatency'] };
    }
}

async function spawnOutputProcess(st) {
    const port = await getFreeUdpPort();
    if (st.stopped) return;
    st.port = port;

    const url = st.cfg.url;
    const vcodec = st.cfg.vcodec || 'copy';
    const isDisk = url.startsWith('disk://');
    // SRT passthrough: srt-live-transmit envía el TS tal cual y reporta RTT/pérdidas del enlace
    const viaSlt = url.startsWith('srt://') && vcodec === 'copy' && !!srt.SLT;
    let cmd, args;

    if (viaSlt) {
        cmd = srt.SLT;
        args = [`udp://127.0.0.1:${port}?rcvbuf=${SOCK_BUF}`, srt.forSrtLiveTransmit(url, 'send'), ...srt.STATS_ARGS];
    } else {
        let format = 'mpegts';
        let destUrl = url;
        if (url.startsWith('rtmp')) {
            format = 'flv';
        } else if (isDisk) {
            ({ destUrl, format } = diskTarget(url));
            await fs.promises.mkdir(path.dirname(destUrl), { recursive: true }).catch(() => {});
            if (st.stopped) return;
        } else if (url.startsWith('udp://')) {
            destUrl = withDefaults(url, { pkt_size: 1316 });
        } else if (url.startsWith('srt://')) {
            destUrl = srt.forFfmpeg(url, 'send');
        }

        const v = videoArgs(vcodec);
        cmd = FFMPEG;
        args = [
            '-hide_banner', '-nostats', '-loglevel', 'error',
            '-progress', 'pipe:1',
            '-fflags', '+genpts', // Critical for UDP to MP4 timebase
            ...v.pre,
            '-i', `udp://127.0.0.1:${port}?overrun_nonfatal=1&buffer_size=${SOCK_BUF}`
        ];
        // FLV sólo admite una pista de audio: dejamos la selección por defecto. El resto lleva todas.
        if (format !== 'flv') args.push('-map', '0:v?', '-map', '0:a?');
        args.push(...v.post, '-c:a', 'copy', '-max_muxing_queue_size', '1024');
        // aac_adtstoasc no se fuerza: el muxer FLV lo inserta solo si el audio es AAC (en MP4, ver movflags)
        if (format === 'flv') args.push('-flvflags', 'no_duration_filesize');
        // MP4 fragmentado: si se corta (apagón, USB fuera) el fichero sigue siendo legible.
        // Sin empty_moov: la cabecera se escribe en el primer fragmento, cuando el muxer ya ha visto
        // el audio y ha podido insertar aac_adtstoasc si es AAC. Forzar ese filtro rompe MP2/AC3, y
        // con empty_moov el AAC sale "Malformed".
        if (isDisk && format === 'mp4') args.push('-movflags', '+frag_keyframe+default_base_moof');
        args.push('-f', format, destUrl);
    }

    console.log(`[STARTING OUTPUT ${st.id}] ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const startedAt = Date.now();
    st.proc = child;
    st.isDisk = isDisk;
    st.tail = '';
    st.lastSize = null;
    st.srt = null;
    dpSub(st.channel, port, false);

    const key = 'out_' + st.id;
    const emitOutputStats = (kbps, time, srtStats) => {
        const now = Date.now();
        st.lastUpdate = now;
        st.lastKbps = kbps;
        const point = { t: new Date(now).toLocaleTimeString(), y: Math.round(kbps * 10) / 10 };
        pushTelemetry(key, point);
        emit('stats', { channel: key, bitrate: `${kbps.toFixed(1)}kbits/s`, time, active: true, srt: srtStats, point });
    };

    if (viaSlt) {
        // Un informe por segundo como mucho, aunque srt-live-transmit informe más a menudo
        let lastEmit = 0;
        srt.attachStats(child, st, 'send', () => {
            const now = Date.now();
            if (now - lastEmit < 1000) return;
            lastEmit = now;
            const s = srt.summarize(st);
            if (s) emitOutputStats(s.mbps * 1000, fmtDuration(now - st.srt.since), s);
        });
    } else {
        // -progress da bloques clave=valor cada ~0,5 s; calculamos bitrate instantáneo con total_size
        child.stdout.on('data', (data) => {
            const out = data.toString();
            const sizes = out.match(/total_size=(\d+)/g);
            if (!sizes) return;
            const size = parseInt(sizes[sizes.length - 1].slice(11), 10);
            const now = Date.now();
            if (st.lastSize === null) {
                st.lastSize = size;
                st.lastT = now;
                return;
            }
            if (now - st.lastT < 1000) return;

            const kbps = Math.max(0, (size - st.lastSize) * 8 / (now - st.lastT));
            st.lastSize = size;
            st.lastT = now;
            const timeMatch = out.match(/out_time=(\d+:\d\d:\d\d)/);
            emitOutputStats(kbps, timeMatch ? timeMatch[1].padStart(8, '0') : '--:--:--');
        });
    }
    child.stderr.on('data', (data) => keepTail(st, data.toString()));

    child.on('error', (err) => {
        console.error(`[FATAL OUT-${st.id}] ${cmd} missing or crashed:`, err.message);
    });

    child.on('close', (code) => {
        dpUnsub(st.channel, port);
        if (st.proc !== child) return;
        st.proc = null;
        if (st.stopped) return;

        st.restarts = (st.restarts || 0) + 1;
        const wait = nextBackoff(st, startedAt);
        console.log(`[OUT-${st.id}] ${viaSlt ? 'srt-live-transmit' : 'FFmpeg'} exited (${code}). Reintento en ${wait} ms. ${st.tail.trim().split('\n').slice(-2).join(' | ')}`);
        st.restartTimer = setTimeout(() => {
            st.restartTimer = null;
            if (!st.stopped) spawnOutputProcess(st).catch(logError(`OUT-${st.id}`));
        }, wait);
    });
}

// Grabaciones: SIGTERM para que FFmpeg cierre el fichero; SIGKILL de seguridad a los 3 s
function killOutputProcess(st) {
    const child = st.proc;
    if (!child) return;
    if (st.isDisk) {
        child.kill('SIGTERM');
        const t = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('close', () => clearTimeout(t));
    } else {
        child.kill('SIGKILL');
    }
}

function stopOutput(id) {
    id = String(id);
    const st = outputs.get(id);
    if (!st) return false;

    console.log(`[STOPPING OUTPUT ${id}] Killing process...`);
    st.stopped = true;
    outputs.delete(id);
    if (st.restartTimer) clearTimeout(st.restartTimer);
    if (st.port) dpUnsub(st.channel, st.port);
    killOutputProcess(st);
    delete telemetryCache['out_' + id];
    return true;
}

// Heartbeat de outputs: si FFmpeg lleva 5 s sin progresar (esperando señal), la UI pasa a 0
setInterval(() => {
    const now = Date.now();
    for (const st of outputs.values()) {
        if (now - st.lastUpdate <= 5000) continue;
        const key = 'out_' + st.id;
        const point = { t: new Date(now).toLocaleTimeString(), y: 0 };
        pushTelemetry(key, point);
        emit('stats', { channel: key, bitrate: '0.0kbits/s', time: '--:--:--', active: true, point });
        st.lastUpdate = now;
        st.lastSize = null;
    }
}, 1000);

/* =======================================
 *  ESTADO / APAGADO
 * ======================================= */

function getTelemetry() {
    return telemetryCache;
}

function getCounts() {
    let inputsLive = 0;
    for (const st of inputs.values()) if (st.signalSince) inputsLive++;
    return { inputsRunning: inputs.size, inputsLive, outputsRunning: outputs.size };
}

const protocolOf = (url) => (url || '').split('://')[0] || 'unknown';

// Estado para /metrics. Sin URLs: pueden llevar passphrase o claves de streaming.
function getMetricsSnapshot() {
    const now = Date.now();
    const ins = [...inputs.values()].map(st => ({
        channel: st.channel,
        name: st.cfg.name || '',
        protocol: protocolOf(st.cfg.url),
        engine: st.cfg.url.startsWith('srt://') && srt.SLT ? 'srt-live-transmit' : 'ffmpeg',
        running: !!st.proc,
        signal: !!st.signalSince,
        uptimeSec: st.signalSince ? (now - st.signalSince) / 1000 : 0,
        bitrateBps: (st.lastKbps || 0) * 1000,
        bytesTotal: st.bytesTotal || 0,
        restarts: st.restarts || 0,
        delayMs: st.delay || 0,
        queuedMs: st.queuedMs || 0,
        srt: st.srt ? srt.snapshot(st) : null,
        srtTotals: st.srtTotals || null
    }));
    const outs = [...outputs.values()].map(st => ({
        id: st.id,
        channel: st.channel,
        location: st.cfg.location || '',
        protocol: protocolOf(st.cfg.url),
        vcodec: st.cfg.vcodec || 'copy',
        running: !!st.proc,
        // Sin informe en 5 s: no está entregando
        bitrateBps: now - st.lastUpdate > 5000 ? 0 : (st.lastKbps || 0) * 1000,
        restarts: st.restarts || 0,
        srt: st.srt ? srt.snapshot(st) : null,
        srtTotals: st.srtTotals || null
    }));
    return { inputs: ins, outputs: outs };
}

// Apagado ordenado: cierra grabaciones correctamente y no deja FFmpeg huérfanos
function shutdown() {
    const children = [];
    for (const id of [...outputs.keys()]) {
        const st = outputs.get(id);
        if (st.proc) children.push(st.proc);
        stopOutput(id);
    }
    for (const ch of [...inputs.keys()]) {
        const st = inputs.get(ch);
        if (st.proc) children.push(st.proc);
        stopInput(ch);
    }
    const waits = children.map(c => new Promise(r => (c.exitCode !== null || c.signalCode) ? r() : c.once('close', r)));
    return Promise.race([Promise.all(waits), new Promise(r => setTimeout(r, 4000))]);
}

module.exports = {
    setIo,
    startInput,
    stopInput,
    startOutput,
    stopOutput,
    startPreview,
    stopPreview,
    setDelay,
    getTelemetry,
    getCounts,
    getMetricsSnapshot,
    shutdown,
    THUMBS_DIR,
    MAX_DELAY_MS
};
