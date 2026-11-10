/**
 * BOT DE TELEGRAM
 *
 * Dos cosas:
 *   1. Avisa en segundos de todo lo que pasa: señal perdida/recuperada, salidas que dejan de
 *      emitir (p. ej. vMix cerrado), cortes SRT, streams encendidos/apagados/creados/borrados
 *      desde el panel, accesos al panel, encoders remotos, CPU/RAM/temperatura y arranques.
 *   2. Responde a comandos (/estado, /informe, /sistema, /historial, /silencio...).
 *
 * Configuración (.env, la escribe el instalador):
 *   TELEGRAM_BOT_TOKEN   token de @BotFather
 *   TELEGRAM_CHAT_ID     chat o grupo que recibe los avisos (varios separados por comas)
 *
 * Sólo los chats configurados pueden usar los comandos. Las URLs nunca salen completas
 * (pueden llevar passphrase o claves de streaming): sólo protocolo y host.
 *
 * Grafana sigue avisando de "Servidor no responde": si esta app se cae, no puede decirlo ella.
 */
const os = require('os');
const si = require('systeminformation');
const db = require('./db');
const streamManager = require('./streamManager');
const sysMonitor = require('./sysMonitor');
const history = require('./history');
const srt = require('./srt');
const { version } = require('./package.json');

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHATS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const API = (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/+$/, '');
const ENABLED = !!(TOKEN && CHATS.length);

// Tiempos de los avisos
const STABLE_MS = 3000;        // un cambio tiene que durar esto para avisar (filtra parpadeos)
const START_GRACE_MS = 15000;  // un stream recién encendido tiene este margen para arrancar
const LISTENER_GRACE_MS = 60000; // salida en modo listener (re)arrancada: margen para que el receptor se reconecte
const FLAP_WINDOW_MS = 5 * 60000;
const FLAP_LIMIT = 4;          // cambios en la ventana para considerarlo inestable
const FLAP_QUIET_MS = 2 * 60000;
const SRT_CHECK_MS = 10000;
const SRT_COOLDOWN_MS = 3 * 60000;
const HOST_SUSTAIN_MS = 30000;

const startedAt = Date.now();
let mutedUntil = 0;

/* =======================================
 *  UTILIDADES
 * ======================================= */
const p2 = (n) => String(n).padStart(2, '0');
const clock = (t = Date.now()) => { const d = new Date(t); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };

function dur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
    return `${Math.floor(h / 24)} días ${h % 24} h`;
}

const mbps = (bps) => bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1000)} kbps`;
// Destino sin credenciales ni parámetros (passphrase, claves de streaming)
const safeUrl = (url) => String(url || '').replace(/[?#].*$/, '').replace(/\/\/[^@/]*@/, '//');
const dbAll = (sql) => new Promise((ok) => db.all(sql, [], (err, rows) => ok(err ? [] : rows)));

// Nombres de la configuración (incluye lo apagado). Se refresca a menudo: los avisos de
// borrado necesitan el nombre que tenía antes de borrarse.
const conf = { inputs: new Map(), outputs: new Map() };
async function refreshConf() {
    const [ins, outs] = await Promise.all([
        dbAll('SELECT channel, name, url, enabled FROM inputs'),
        dbAll('SELECT id, channel, location, url, enabled, vcodec FROM outputs')
    ]);
    conf.inputs = new Map(ins.map(r => [String(r.channel), r]));
    conf.outputs = new Map(outs.map(r => [String(r.id), r]));
}
const inName = (ch) => { const r = conf.inputs.get(String(ch)); return r && r.name ? r.name : `Canal ${ch}`; };
const outName = (id) => {
    const r = conf.outputs.get(String(id));
    if (!r) return `Salida ${id}`;
    return r.location || safeUrl(r.url) || `Salida ${id}`;
};

/* =======================================
 *  ENVÍO (con cola: varios avisos seguidos van en un solo mensaje)
 * ======================================= */
async function api(method, body, timeoutMs = 10000) {
    const res = await fetch(`${API}/bot${TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(timeoutMs)
    });
    const j = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!j.ok) {
        const err = new Error(j.description || `HTTP ${res.status}`);
        err.code = j.error_code || res.status;
        err.retryAfter = j.parameters && j.parameters.retry_after;
        throw err;
    }
    return j.result;
}

// Telegram corta a 4096 caracteres
function chunks(text) {
    const out = [];
    let cur = '';
    for (const block of text.split('\n\n')) {
        if (cur && cur.length + block.length + 2 > 3900) { out.push(cur); cur = ''; }
        cur = cur ? `${cur}\n\n${block}` : block;
        while (cur.length > 3900) { out.push(cur.slice(0, 3900)); cur = cur.slice(3900); }
    }
    if (cur) out.push(cur);
    return out;
}

async function sendTo(chatId, text) {
    for (const part of chunks(text)) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await api('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true });
                break;
            } catch (e) {
                if (e.code === 429 && e.retryAfter) { await new Promise(r => setTimeout(r, e.retryAfter * 1000)); continue; }
                console.error(`[TELEGRAM] No se pudo enviar: ${e.message}`);
                if (e.code === 400 || e.code === 401 || e.code === 403) return; // token o chat mal: reintentar no sirve
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }
}

const queue = [];
let flushTimer = null;
let flushing = Promise.resolve();

function flush() {
    flushTimer = null;
    if (!queue.length) return flushing;
    const text = queue.splice(0).join('\n\n');
    flushing = flushing.then(() => Promise.all(CHATS.map(c => sendTo(c, text))));
    return flushing;
}

// Aviso. important: se manda aunque estén silenciados (p. ej. el servidor se apaga)
function notify(text, { important = false } = {}) {
    if (!ENABLED) return;
    if (!important && Date.now() < mutedUntil) return;
    queue.push(text);
    if (!flushTimer) flushTimer = setTimeout(flush, 1000);
}

/* =======================================
 *  VIGILANCIA DE STREAMS (cada segundo)
 * ======================================= */
const tracks = new Map(); // 'in:3' | 'out:7' -> estado

function newTrack(now) {
    return { rep: null, cand: null, candAt: now, startAt: now, downAt: null, downNotified: false, changes: [], unstable: false };
}

// Decide si hay que avisar. Devuelve 'down' | 'up' | 'first-down' | null.
function step(t, up, now) {
    if (up === t.rep) { t.cand = null; return null; }
    if (t.cand !== up) { t.cand = up; t.candAt = now; }
    if (t.rep === null) {
        if (up) { t.rep = true; t.cand = null; return t.downNotified ? 'up' : null; }
        if (now - t.startAt < START_GRACE_MS || now - t.candAt < STABLE_MS) return null;
        t.rep = false; t.cand = null; t.downAt = t.downAt || t.startAt;
        return 'first-down';
    }
    if (now - t.candAt < STABLE_MS) return null;
    t.rep = up; t.cand = null;
    return up ? 'up' : 'down';
}

// Si un stream se corta y vuelve una y otra vez, un aviso de "inestable" en vez de veinte
function flapGate(t, key, label, now) {
    t.changes = t.changes.filter(x => now - x < FLAP_WINDOW_MS);
    t.changes.push(now);
    if (t.unstable) return false;
    if (t.changes.length >= FLAP_LIMIT) {
        t.unstable = true;
        notify(`🟠 ${label} se corta y vuelve una y otra vez (${t.changes.length} cortes en 5 min).\nNo te aviso de cada corte; te digo cuando se estabilice.`);
        return false;
    }
    return true;
}

function checkUnstable(t, label, onState, now) {
    if (!t.unstable) return;
    const last = t.changes[t.changes.length - 1] || 0;
    if (now - last < FLAP_QUIET_MS) return;
    t.unstable = false;
    t.changes = [];
    notify(`ℹ️ ${label} ya está estable: ${t.rep ? onState : 'sigue caído'}.`);
    t.downNotified = !t.rep;
}

function watchStreams() {
    const now = Date.now();
    const snap = streamManager.getMetricsSnapshot();
    const signalOf = new Map(snap.inputs.map(i => [i.channel, i.signal]));
    const seen = new Set();

    for (const i of snap.inputs) {
        const key = `in:${i.channel}`;
        seen.add(key);
        let t = tracks.get(key);
        if (!t) tracks.set(key, t = newTrack(now));
        const label = `La entrada ${inName(i.channel)} (canal ${i.channel})`;
        const r = step(t, i.signal, now);
        if (r) {
            const outs = snap.outputs.filter(o => o.channel === i.channel).length;
            if (r === 'up') {
                if (t.downNotified && flapGate(t, key, label, now)) {
                    notify(`✅ Señal recuperada: ${inName(i.channel)} (canal ${i.channel})\nEstuvo sin señal ${dur(now - t.downAt)} (desde las ${clock(t.downAt)}).`);
                }
                t.downNotified = false;
            } else {
                t.downAt = r === 'first-down' ? t.startAt : now - STABLE_MS;
                const pass = r === 'first-down' || flapGate(t, key, label, now);
                if (pass) {
                    notify(r === 'first-down'
                        ? `🔴 ${inName(i.channel)} (canal ${i.channel}) está encendida pero no recibe señal.\nNo llega nada del emisor desde las ${clock(t.startAt)}.`
                        : `🔴 Sin señal: ${inName(i.channel)} (canal ${i.channel}) · ${clock()}\nHan dejado de llegar datos del emisor.${outs ? ` Sus ${outs} salida${outs > 1 ? 's' : ''} tampoco emite${outs > 1 ? 'n' : ''}.` : ''}`);
                }
                t.downNotified = true;
            }
        }
        checkUnstable(t, label, 'con señal', now);
    }

    for (const o of snap.outputs) {
        const key = `out:${o.id}`;
        seen.add(key);
        let t = tracks.get(key);
        if (!t) tracks.set(key, t = newTrack(now));
        // Sin señal en la entrada, la salida no puede emitir: ya se avisó por la entrada.
        // Al volver la señal, la salida tiene su margen de arranque.
        if (!signalOf.get(o.channel)) {
            if (t.rep !== null) { t.rep = null; t.cand = null; }
            t.startAt = now;
            continue;
        }
        // Listener recién (re)arrancado: el receptor (vMix...) tarda en reconectarse; aún no es un fallo
        if (o.listener && !o.delivering && now - o.startedAt < LISTENER_GRACE_MS) {
            if (t.rep === null) t.startAt = now;
            t.cand = null;
            continue;
        }
        const label = `La salida ${outName(o.id)} (${inName(o.channel)})`;
        const r = step(t, o.delivering, now);
        if (r === 'up') {
            if (t.downNotified && flapGate(t, key, label, now)) {
                notify(`✅ La salida ${outName(o.id)} (${inName(o.channel)}) vuelve a emitir.\nEstuvo parada ${dur(now - t.downAt)} (desde las ${clock(t.downAt)}).`);
            }
            t.downNotified = false;
        } else if (r) {
            t.downAt = r === 'first-down' ? t.startAt : now - STABLE_MS;
            if (r === 'first-down' || flapGate(t, key, label, now)) {
                const why = o.listener
                    ? `\nNingún receptor conectado${o.port ? ` al puerto ${o.port}` : ''}.`
                    : (o.lastError ? `\nÚltimo error: ${o.lastError}` : '');
                notify(r === 'first-down'
                    ? `🔴 La salida ${outName(o.id)} (${inName(o.channel)}) no consigue emitir.\nLa entrada tiene señal, pero el destino no la recibe: ¿está abierto el receptor (vMix, OBS...)?${why}`
                    : `🔴 La salida ${outName(o.id)} (${inName(o.channel)}) ha dejado de emitir · ${clock()}\nLa entrada sigue con señal: el receptor se ha cerrado, desconectado o rechaza la conexión.${why}`);
            }
            t.downNotified = true;
        }
        checkUnstable(t, label, 'emitiendo', now);
    }

    // Streams parados desde el panel: ya avisa el propio panel
    for (const key of tracks.keys()) if (!seen.has(key)) tracks.delete(key);
}

/* =======================================
 *  CALIDAD SRT (cada 10 s)
 * ======================================= */
const srtSeen = new Map(); // key -> { drops, warnedAt, latWarnSince }

function watchSrt() {
    const now = Date.now();
    const snap = streamManager.getMetricsSnapshot();
    const items = [
        ...snap.inputs.map(i => ({ key: `in:${i.channel}`, label: `la entrada ${inName(i.channel)}`, s: i.srt, totals: i.srtTotals, url: (conf.inputs.get(i.channel) || {}).url })),
        ...snap.outputs.map(o => ({ key: `out:${o.id}`, label: `la salida ${outName(o.id)}`, s: o.srt, totals: o.srtTotals, url: (conf.outputs.get(o.id) || {}).url }))
    ];
    const alive = new Set();
    for (const it of items) {
        if (!it.totals) continue;
        alive.add(it.key);
        const prev = srtSeen.get(it.key) || { drops: it.totals.drops, warnedAt: 0, latWarnSince: null };
        const delta = it.totals.drops - prev.drops;
        prev.drops = it.totals.drops;
        if (delta > 0 && now - prev.warnedAt > SRT_COOLDOWN_MS) {
            prev.warnedAt = now;
            const rtt = it.s ? Math.round(it.s.rtt) : null;
            const lat = it.s && it.s.latency ? it.s.latency : null;
            // Recomendación: al menos 4 × RTT y, si ya lo cumple, un 50 % más que la actual
            const rec = Math.max(rtt ? rtt * 4 : 0, lat ? Math.ceil(lat * 1.5 / 10) * 10 : 200);
            const advice = `\n${rtt ? `RTT ${rtt} ms${lat ? `, latencia ${lat} ms` : ''}. ` : ''}Si se repite, sube la latencia SRT a ${rec} ms.`;
            notify(`🟠 Cortes SRT en ${it.label}: ${delta} paquetes llegaron tarde y se perdieron (se ven cortes en la imagen).${advice}`);
        }
        // Latencia por debajo de 3 × RTT: un aviso por conexión
        if (it.s && it.s.latency && it.s.rtt && it.s.latency < 3 * it.s.rtt && prev.latWarnSince !== it.s.since) {
            prev.latWarnSince = it.s.since;
            notify(`🟠 Latencia SRT corta en ${it.label}: ${it.s.latency} ms con un RTT de ${Math.round(it.s.rtt)} ms.\nHay riesgo de cortes. Súbela a ${Math.round(it.s.rtt * 4)} ms (4 × RTT).`);
        }
        srtSeen.set(it.key, prev);
    }
    for (const k of srtSeen.keys()) if (!alive.has(k)) srtSeen.delete(k);
}

/* =======================================
 *  SERVIDOR: CPU, RAM, TEMPERATURA (cada 5 s)
 * ======================================= */
const hostAlarms = {
    cpu: { on: false, since: null, label: 'CPU', hi: 0.9, lo: 0.75 },
    mem: { on: false, since: null, label: 'RAM', hi: 0.9, lo: 0.8 },
    temp: { on: false, since: null, label: 'Temperatura', hi: 80, lo: 70 }
};
let lastTemp = null;
let tempAt = 0;

function hostCheck(a, value, now, onText, offText) {
    if (value === null || value === undefined) return;
    const bad = a.on ? value > a.lo : value > a.hi;
    if (bad === a.on) { a.since = null; return; }
    if (!a.since) a.since = now;
    if (now - a.since < HOST_SUSTAIN_MS) return;
    a.on = bad;
    a.since = null;
    notify(bad ? onText : offText);
}

async function watchHost() {
    const now = Date.now();
    const h = sysMonitor.getLastHost();
    if (h) {
        hostCheck(hostAlarms.cpu, h.cpuLoad, now,
            `🟠 CPU del servidor al ${Math.round(h.cpuLoad * 100)} % desde hace 30 s.\nSi hay conversiones por CPU (libx264/libx265), pásalas a passthrough o Quick Sync.`,
            `✅ CPU del servidor normal (${Math.round(h.cpuLoad * 100)} %).`);
        const mem = h.memTotal ? h.memUsed / h.memTotal : null;
        hostCheck(hostAlarms.mem, mem, now,
            `🟠 Memoria del servidor al ${Math.round(mem * 100)} %.`,
            `✅ Memoria del servidor normal (${Math.round(mem * 100)} %).`);
    }
    if (now - tempAt > 30000) {
        tempAt = now;
        try {
            const t = await si.cpuTemperature();
            lastTemp = t && t.main > 0 ? t.main : null;
        } catch (e) { lastTemp = null; }
    }
    hostCheck(hostAlarms.temp, lastTemp, now,
        `🌡️ El servidor está a ${Math.round(lastTemp)} °C. Revisa la ventilación: por encima de 85 °C la Raspberry baja la velocidad.`,
        `✅ Temperatura del servidor normal (${Math.round(lastTemp)} °C).`);
}

/* =======================================
 *  EVENTOS QUE LLEGAN DESDE OTROS MÓDULOS
 * ======================================= */

// Acciones en el panel. kind: 'input' | 'output'; action: on | off | create | edit | delete
function panelAction(user, kind, id, action) {
    if (!ENABLED) return;
    const who = user ? user : 'Alguien';
    const run = () => {
        const name = kind === 'input' ? `la entrada ${inName(id)} (canal ${id})` : `la salida ${outName(id)} (${inName((conf.outputs.get(String(id)) || {}).channel)})`;
        const text = {
            on: `▶️ ${who} ha encendido ${name} desde el panel.`,
            off: `⏸️ ${who} ha apagado ${name} desde el panel.${kind === 'input' ? ' Sus salidas también se paran.' : ''}`,
            create: `➕ ${who} ha creado ${name}.`,
            edit: `✏️ ${who} ha cambiado la configuración de ${name} (se reinicia).`,
            delete: `🗑️ ${who} ha borrado ${name}.`
        }[action];
        if (text) notify(text);
    };
    // Al borrar, el nombre ya está en caché; al crear, hay que leerlo de la base de datos
    if (action === 'delete') run();
    else refreshConf().then(run, run);
}

const loginFailWarned = new Map(); // ip -> instante del último aviso
function login(username, ip, ok) {
    if (!ENABLED) return;
    if (ok) return notify(`🔐 ${username} ha entrado en el panel (${ip}).`);
    const last = loginFailWarned.get(ip) || 0;
    if (Date.now() - last < 5 * 60000) return;
    loginFailWarned.set(ip, Date.now());
    notify(`⚠️ Intento de acceso al panel con usuario o contraseña incorrectos ("${String(username || '').slice(0, 40)}") desde ${ip}.`);
}

/* =======================================
 *  CONEXIONES A LAS SALIDAS RTMP LOCALES (cada 2 s)
 *  Sólo se avisa de quien sigue conectado 3 s: los reproductores que tantean y se van no cuentan
 * ======================================= */
let viewersNow = {};
const viewerSeen = new Map(); // `${id}|${ip}|${since}` -> { notified }
function watchViewers() {
    viewersNow = streamManager.rtmpViewers();
    const now = Date.now();
    const alive = new Set();
    for (const [id, v] of Object.entries(viewersNow)) {
        for (const c of v.clients) {
            const k = `${id}|${c.ip}|${c.since}`;
            alive.add(k);
            const e = viewerSeen.get(k) || { notified: false };
            viewerSeen.set(k, e);
            if (!e.notified && now - c.since >= STABLE_MS) {
                e.notified = true;
                notify(`👁 Nueva conexión a la salida ${outName(id)} desde ${c.ip}. Ahora ${v.count === 1 ? 'hay 1 conexión' : `hay ${v.count} conexiones`}.`);
            }
        }
    }
    for (const [k, e] of viewerSeen) {
        if (alive.has(k)) continue;
        viewerSeen.delete(k);
        if (!e.notified) continue;
        const [id, ip, since] = k.split('|');
        // Si se ha parado la salida entera, ya avisa el panel: no un mensaje por reproductor
        if (!viewersNow[id]) continue;
        const left = viewersNow[id].count;
        notify(`👋 ${ip} se ha desconectado de la salida ${outName(id)} tras ${dur(now - Number(since))}. ${left === 1 ? 'Queda 1 conexión' : left ? `Quedan ${left} conexiones` : 'Ya no queda nadie conectado'}.`);
    }
}

function encoder(name, host, online, error) {
    notify(online ? `✅ El encoder ${name} (${host}) vuelve a estar en línea.` : `🔴 El encoder ${name} (${host}) no responde: ${error || 'sin conexión'}.`);
}

/* =======================================
 *  INFORMES (comandos)
 * ======================================= */
function inputState(i) {
    if (!i) return '⏸️';
    return i.signal ? '🟢' : '🔴';
}

async function statusText(detailed) {
    await refreshConf();
    const snap = streamManager.getMetricsSnapshot();
    const live = new Map(snap.inputs.map(i => [i.channel, i]));
    viewersNow = streamManager.rtmpViewers();
    const liveOut = new Map(snap.outputs.map(o => [o.id, o]));
    const lines = [`📡 Estado · ${clock()}`];
    let nLive = 0, nNoSignal = 0, nOff = 0;

    for (const [ch, cfg] of conf.inputs) {
        const i = live.get(ch);
        if (!cfg.enabled || !i) nOff++;
        else if (i.signal) nLive++;
        else nNoSignal++;

        let line = `${inputState(cfg.enabled ? i : null)} ${inName(ch)} (canal ${ch})`;
        if (!cfg.enabled || !i) line += ' · apagada';
        else if (!i.signal) line += ' · SIN SEÑAL';
        else line += ` · ${mbps(i.bitrateBps)} · ${i.codec ? i.codec.toUpperCase() + ' · ' : ''}en el aire ${dur(i.uptimeSec * 1000)}`;
        lines.push('', line);

        if (detailed && i && i.signal) {
            const d = [];
            if (i.srt) d.push(`RTT ${Math.round(i.srt.rtt)} ms`, `latencia ${i.srt.latency || '?'} ms`);
            if (i.srtTotals && i.srtTotals.pkts) {
                const tot = i.srtTotals.pkts + i.srtTotals.lost;
                d.push(`pérdida ${(i.srtTotals.lost / tot * 100).toFixed(2)} %`, `drops ${i.srtTotals.drops}`);
            }
            if (i.delayMs) d.push(`retardo ${i.delayMs} ms`);
            if (i.restarts) d.push(`${i.restarts} reconexiones`);
            if (d.length) lines.push(`   ${d.join(' · ')}`);
        }

        for (const [id, oc] of conf.outputs) {
            if (String(oc.channel) !== ch) continue;
            const o = liveOut.get(id);
            let ol;
            if (!oc.enabled || !cfg.enabled || !o) ol = `⏸️ ${outName(id)} · apagada`;
            else if (o.delivering) ol = `🟢 ${outName(id)} · ${mbps(o.bitrateBps)}`;
            else if (i && !i.signal) ol = `⚪ ${outName(id)} · esperando señal`;
            else ol = `🔴 ${outName(id)} · NO EMITE`;
            const codec = oc.vcodec && oc.vcodec !== 'copy' ? ` · ${oc.vcodec}` : '';
            const v = viewersNow[id];
            const conns = v ? ` · 👁 ${v.count} ${v.count === 1 ? 'conexión' : 'conexiones'}` : '';
            lines.push(`   ↳ ${ol}${codec}${conns}`);
            if (detailed && v && v.count) lines.push(`      ${v.clients.map(c => `${c.ip} (hace ${dur(Date.now() - c.since)})`).join(' · ')}`);
            if (detailed && o) {
                const d = [];
                if (o.srt) d.push(`RTT ${Math.round(o.srt.rtt)} ms`);
                if (o.srtTotals && o.srtTotals.drops) d.push(`drops ${o.srtTotals.drops}`);
                if (o.restarts) d.push(`${o.restarts} reconexiones`);
                if (!o.delivering && o.lastError) d.push(`error: ${o.lastError}`);
                if (d.length) lines.push(`      ${d.join(' · ')}`);
            }
        }
    }
    if (!conf.inputs.size) lines.push('', 'No hay entradas configuradas.');
    lines.splice(1, 0, `${nLive} en vivo · ${nNoSignal} sin señal · ${nOff} apagadas`);
    return lines.join('\n');
}

async function systemText() {
    const h = sysMonitor.getLastHost();
    const lines = [`🖥️ Servidor ${os.hostname()} · ${clock()}`];
    if (h) {
        lines.push(`CPU ${Math.round(h.cpuLoad * 100)} % · RAM ${(h.memUsed / 1073741824).toFixed(1)} de ${(h.memTotal / 1073741824).toFixed(1)} GB`);
        lines.push(`Red: sale ${mbps(h.netTxBps)} · entra ${mbps(h.netRxBps)}`);
    }
    try {
        const t = await si.cpuTemperature();
        if (t && t.main > 0) lines.push(`Temperatura ${Math.round(t.main)} °C`);
    } catch (e) { /* sin sensor */ }
    try {
        const disks = await si.fsSize();
        for (const d of disks.filter(x => x.mount === '/' || /^\/media|^\/mnt/.test(x.mount))) {
            lines.push(`Disco ${d.mount}: ${(d.available / 1073741824).toFixed(1)} GB libres (${Math.round(d.use)} % usado)`);
        }
    } catch (e) { /* sin datos */ }
    lines.push(`Encendido desde hace ${dur(os.uptime() * 1000)} · app ${dur(Date.now() - startedAt)} · versión ${version}`);
    lines.push(`Motor SRT: ${srt.SLT ? 'srt-live-transmit' : 'FFmpeg'}`);
    if (Date.now() < mutedUntil) lines.push(`🔕 Avisos en silencio hasta las ${clock(mutedUntil)}`);
    return lines.join('\n');
}

async function historyText(range) {
    if (!history.RANGES[range]) range = '24h';
    let data;
    try { data = await history.collect(range); } catch (e) {
        return 'El historial necesita Prometheus (se instala con la monitorización) y ahora no responde.';
    }
    await refreshConf();
    const titles = { '15m': 'Últimos 15 min', '1h': 'Última hora', '6h': 'Últimas 6 horas', '24h': 'Últimas 24 horas' };
    const lines = [`📈 ${titles[range] || range}`];
    if (!data.summary.length) lines.push('', 'Sin datos de entradas en ese periodo.');
    for (const r of data.summary) {
        const avail = r.availability !== undefined ? `${(r.availability * 100).toFixed(1)} % con señal` : 'sin datos';
        const d = [avail];
        if (r.drops) d.push(`${Math.round(r.drops)} drops`);
        if (r.restarts) d.push(`${Math.round(r.restarts)} reconexiones`);
        if (r.maxRtt) d.push(`RTT máx ${Math.round(r.maxRtt * 1000)} ms`);
        lines.push('', `${r.availability >= 0.999 ? '🟢' : r.availability >= 0.95 ? '🟠' : '🔴'} ${r.name || inName(r.channel)} (canal ${r.channel})`, `   ${d.join(' · ')}`);
    }
    return lines.join('\n');
}

const HELP = [
    '🤖 Comandos del servidor TSST',
    '',
    '/estado – qué entra y qué sale ahora mismo',
    '/informe – lo mismo con RTT, pérdidas, drops y errores, más el servidor',
    '/sistema – CPU, RAM, temperatura, disco y red',
    '/historial – disponibilidad de cada señal (24h; también /historial 1h o 6h)',
    '/silencio – pausa los avisos 1 hora (/silencio 30 = 30 min)',
    '/avisos – vuelve a activar los avisos',
    '/ayuda – esta lista'
].join('\n');

async function handleCommand(chatId, text) {
    const [rawCmd, arg] = text.trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@.*$/, '');
    let reply;
    switch (cmd) {
        case '/start': case '/ayuda': case '/help':
            reply = HELP; break;
        case '/estado': case '/status':
            reply = await statusText(false); break;
        case '/informe': case '/report':
            reply = `${await statusText(true)}\n\n${await systemText()}`; break;
        case '/sistema':
            reply = await systemText(); break;
        case '/historial':
            reply = await historyText(arg || '24h'); break;
        case '/silencio': {
            const min = Math.min(24 * 60, Math.max(1, parseInt(arg, 10) || 60));
            mutedUntil = Date.now() + min * 60000;
            reply = `🔕 Avisos en silencio ${dur(min * 60000)}, hasta las ${clock(mutedUntil)}. Usa /avisos para reactivarlos antes.`;
            break;
        }
        case '/avisos':
            mutedUntil = 0;
            reply = '🔔 Avisos activados.';
            break;
        default:
            reply = 'No conozco ese comando.\n\n' + HELP;
    }
    await sendTo(chatId, reply);
}

/* =======================================
 *  RECEPCIÓN DE COMANDOS (long polling)
 * ======================================= */
let polling = false;
async function pollLoop() {
    polling = true;
    let offset = 0;
    while (polling) {
        try {
            const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, 60000);
            for (const u of updates) {
                offset = u.update_id + 1;
                const m = u.message;
                if (!m || typeof m.text !== 'string' || !m.text.startsWith('/')) continue;
                const chatId = String(m.chat.id);
                if (!CHATS.includes(chatId)) {
                    console.warn(`[TELEGRAM] Comando de un chat no autorizado (${chatId})`);
                    await sendTo(chatId, `Este chat no está autorizado. Su ID es ${chatId}: añádelo en TELEGRAM_CHAT_ID si quieres usarlo.`);
                    continue;
                }
                handleCommand(chatId, m.text).catch(e => console.error('[TELEGRAM] Error en comando', e.message));
            }
        } catch (e) {
            if (!polling) break;
            if (e.code === 409) {
                // Otro programa lee este bot (otro servidor con el mismo token, o un webhook)
                console.error('[TELEGRAM] Otro programa está leyendo este bot (409). Los comandos no funcionarán mientras siga.');
                await new Promise(r => setTimeout(r, 30000));
            } else if (e.code === 401) {
                console.error('[TELEGRAM] Token del bot no válido: revisa TELEGRAM_BOT_TOKEN.');
                return;
            } else {
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }
}

/* =======================================
 *  ARRANQUE / APAGADO
 * ======================================= */
const timers = [];

function init() {
    if (!ENABLED) {
        console.log('[TELEGRAM] Desactivado (define TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID para avisos y comandos)');
        return;
    }
    console.log(`[TELEGRAM] Bot activo para ${CHATS.length} chat(s)`);
    refreshConf();
    timers.push(setInterval(() => refreshConf(), 5000));
    timers.push(setInterval(() => { try { watchStreams(); } catch (e) { console.error('[TELEGRAM]', e.message); } }, 1000));
    timers.push(setInterval(() => { try { watchSrt(); } catch (e) { console.error('[TELEGRAM]', e.message); } }, SRT_CHECK_MS));
    timers.push(setInterval(() => watchHost().catch(() => {}), 5000));
    timers.push(setInterval(() => { try { watchViewers(); } catch (e) { console.error('[TELEGRAM]', e.message); } }, 2000));

    api('setMyCommands', {
        commands: [
            { command: 'estado', description: 'Qué entra y qué sale ahora mismo' },
            { command: 'informe', description: 'Informe detallado de streams y servidor' },
            { command: 'sistema', description: 'CPU, RAM, temperatura, disco y red' },
            { command: 'historial', description: 'Disponibilidad de cada señal (24h)' },
            { command: 'silencio', description: 'Pausar los avisos 1 hora' },
            { command: 'avisos', description: 'Reactivar los avisos' },
            { command: 'ayuda', description: 'Lista de comandos' }
        ]
    }).catch(e => console.error(`[TELEGRAM] ${e.message}`));
    pollLoop();

    // Resumen al arrancar, cuando los streams ya han tenido tiempo de conectar
    setTimeout(async () => {
        await refreshConf();
        const snap = streamManager.getMetricsSnapshot();
        const withSignal = snap.inputs.filter(i => i.signal).length;
        const delivering = snap.outputs.filter(o => o.delivering).length;
        notify(`🟢 Servidor TSST en marcha (${os.hostname()}, versión ${version}).\n${snap.inputs.length} entradas encendidas, ${withSignal} con señal · ${delivering} de ${snap.outputs.length} salidas emitiendo.\nEscribe /estado para ver el detalle.`, { important: true });
    }, 20000);
}

// Último aviso antes de apagar (máximo 3 s)
async function shutdown(reason) {
    polling = false;
    timers.forEach(clearInterval);
    if (!ENABLED) return;
    notify(`⏹️ Servidor TSST apagándose (${reason}). Las señales se cortan hasta que vuelva.`, { important: true });
    if (flushTimer) clearTimeout(flushTimer);
    await Promise.race([flush(), new Promise(r => setTimeout(r, 3000))]);
}

module.exports = { init, shutdown, notify, panelAction, login, encoder, ENABLED, _test: { step, newTrack, dur, chunks, statusText, systemText } };
