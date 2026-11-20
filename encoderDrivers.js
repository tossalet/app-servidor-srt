/**
 * CONTROL DE ENCODERS POR API (URAY, HW Stream, Zowietek)
 *
 * Cada fabricante tiene su API; aquí se traducen a un estado común para el panel.
 * Un encoder tiene una o varias entradas (HDMI/SDI); cada entrada, su stream principal (main) y
 * secundario (sub); y cada stream, sus emisiones (SRT caller/listener, RTMP push):
 *
 *   { device: { model, version, cpu, uptime },
 *     inputs: [{ id, name, signal, width, height, fps, interlaced,
 *                streams: [{ id: 'entrada:stream', input, index, name, codec, codecs, width, height,
 *                            fps, bitrate, rc, gop,
 *                            outputs: [{ id, kind, label, url, enabled, editable }] }],
 *                recordings: [{ id: 'rec:soporte', label, state, recording }] }],
 *     caps }
 *
 * La grabación local (USB, SD, NAS) va por entrada, no por stream: hoy sólo la expone ZowieAPI.
 *
 * - uray / hwstream: firmware HiSilicon (Hi3520/Hi3516/Hi3519) común a muchos encoders HDMI chinos.
 *   API CGI por GET con autenticación básica (por defecto admin/admin):
 *     /get_status (un <vi id=N> por entrada, con sus <venc id=M>), /get_output?input=N&output=M,
 *     /set_output?input=N&output=M&clave=valor, /reboot. Respuestas en XML.
 *   Documentado públicamente por un fabricante con el mismo firmware (NTI HD-ENC-H264);
 *   URAY lo llama «CGI command» y entrega el documento bajo petición.
 * - zowietek: ZowieAPI (ZowieBox, ZowieCam...): una entrada. POST JSON a /video, /streamplay, /record, /system
 *   con ?option=getinfo|setinfo&login_check_flag=1. Respuesta { status: "00000", data }.
 *   Referencia: módulo oficial de Bitfocus Companion (companion-module-zowietek-api).
 *
 * Ningún driver guarda estado: cada llamada lee del encoder. Tras escribir se vuelve a leer para
 * confirmar que el cambio se aplicó (estos firmwares a veces responden OK e ignoran un valor).
 */
const http = require('http');
const https = require('https');

const TIMEOUT_MS = 6000;
const MAX_BODY = 1024 * 1024;

class ApiError extends Error {
    constructor(message, code) { super(message); this.code = code; }
}

/* =======================================
 *  HTTP
 * ======================================= */
function request(enc, { method = 'GET', path, body, headers = {}, timeout = TIMEOUT_MS }) {
    return new Promise((resolve, reject) => {
        const lib = enc.https ? https : http;
        const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const h = { Accept: '*/*', Connection: 'close', ...headers };
        if (data) h['Content-Length'] = data.length;
        const req = lib.request({
            host: enc.host, port: enc.web_port, method, path, headers: h,
            rejectUnauthorized: false, // certificados autofirmados
            timeout
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (c) => {
                size += c.length;
                if (size > MAX_BODY) { req.destroy(new ApiError('Respuesta demasiado grande', 'EBIG')); return; }
                chunks.push(c);
            });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new ApiError('El encoder no responde a la API', 'ETIMEDOUT')));
        req.on('error', (e) => reject(e instanceof ApiError ? e : new ApiError(e.code === 'ECONNREFUSED' ? 'Puerto web cerrado' : (e.code || e.message), e.code)));
        req.end(data);
    });
}

/* =======================================
 *  XML mínimo (las respuestas HiSilicon son XML plano, sin espacios de nombres)
 * ======================================= */
const decodeEntities = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const map = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
});

// Devuelve el elemento raíz: { name, attrs, children: [], text }
function parseXml(text) {
    const root = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [root];
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
        const top = stack[stack.length - 1];
        if (m[1] !== undefined) { top.text += m[1]; continue; }
        if (m[6] !== undefined) { top.text += decodeEntities(m[6]); continue; }
        if (!m[3]) continue; // comentario o <?xml ?>
        if (m[2] === '/') {
            // Cierra hasta la etiqueta del mismo nombre (tolera XML mal cerrado)
            for (let i = stack.length - 1; i > 0; i--) {
                if (stack[i].name === m[3]) { stack.length = i; break; }
            }
            continue;
        }
        const attrs = {};
        (m[4] || '').replace(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, k, a, b) => { attrs[k] = decodeEntities(a ?? b ?? ''); });
        const el = { name: m[3], attrs, children: [], text: '' };
        top.children.push(el);
        if (!m[5]) stack.push(el);
    }
    return root.children.find(c => c.name) || null;
}

const child = (el, name, id) => el && el.children.find(c => c.name === name && (id === undefined || c.attrs.id === String(id)));
const children = (el, name) => (el ? el.children.filter(c => c.name === name) : []);
const txt = (el, name) => { const c = child(el, name); return c ? c.text.trim() : undefined; };
const num = (el, name) => { const v = txt(el, name); if (v === undefined || v === '') return undefined; const n = Number(v); return Number.isFinite(n) ? n : undefined; };
// Valores planos de un elemento: { etiqueta: texto }
const flat = (el) => Object.fromEntries((el ? el.children : []).filter(c => !c.children.length).map(c => [c.name, c.text.trim()]));

/* =======================================
 *  NOMBRES E IDENTIFICADORES COMUNES
 * ======================================= */
const inputName = (i) => `Entrada ${i + 1}`;
const streamName = (o) => (o === 0 ? 'Principal (main)' : o === 1 ? 'Secundario (sub)' : `Secundario ${o}`);

// 'entrada:stream' -> { input, index }. Un número suelto es la entrada 1 (compatibilidad).
function parseStreamId(sid) {
    const s = String(sid);
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(s) || (/^\d{1,2}$/.test(s) ? [s, '0', s] : null);
    if (!m) throw new ApiError('Stream no válido', 'EINVAL');
    return { input: Number(m[1]), index: Number(m[2]) };
}

// Busca un stream o una emisión en el estado normalizado y dice de qué entrada es
function locate(state, { streamId, outputId, recordId }) {
    for (const inp of state.inputs || []) {
        const rec = recordId !== undefined && (inp.recordings || []).find(r => r.id === String(recordId));
        if (rec) return { input: inp, record: rec };
        for (const s of inp.streams || []) {
            if (streamId !== undefined && s.id === String(streamId)) return { input: inp, stream: s };
            const o = outputId !== undefined && (s.outputs || []).find(x => x.id === String(outputId));
            if (o) return { input: inp, stream: s, output: o };
        }
    }
    return null;
}

/* =======================================
 *  DRIVER HiSilicon (URAY, HW Stream y compatibles)
 * ======================================= */
const HISI_CODECS = { 96: 'H.264', 265: 'H.265', 26: 'MJPEG', 1002: 'MJPEG' };
const HISI_CODEC_IDS = { 'H.264': 96, 'H.265': 265 };
// Profile H.264 (venc_profile, sólo cuenta en H.264): 0 baseline, 1 main, 2 high
const H264_PROFILES = ['Baseline', 'Main', 'High'];
// Control de bitrate (venc_rc_mode). El CGI documenta 0 CBR y 1 VBR; firmwares más nuevos
// añaden modos (Strong CBR en H.264). Un valor que no está aquí se muestra como «Modo N» y se
// puede volver a elegir, para no perderlo al guardar otro cambio.
const HISI_RC_MODES = { 0: 'CBR', 1: 'VBR' };
const hisiRcName = (v) => (v === undefined || v === '' ? null : HISI_RC_MODES[v] || `Modo ${v}`);
function hisiRcId(name) {
    const known = Object.entries(HISI_RC_MODES).find(([, n]) => n === name);
    if (known) return Number(known[0]);
    const m = /^Modo (\d{1,3})$/.exec(String(name));
    if (m) return Number(m[1]);
    throw new ApiError(`Modo de bitrate no válido: ${name}`, 'EINVAL');
}

function hisiAuth(enc) {
    const user = enc.api_user || 'admin';
    const pass = enc.api_user ? (enc.api_pass || '') : (enc.api_pass || 'admin');
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function hisiGet(enc, path, params) {
    const qs = params ? '?' + Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
    const r = await request(enc, { path: path + qs, headers: { Authorization: hisiAuth(enc) } });
    if (r.status === 401 || r.status === 403) throw new ApiError('Usuario o contraseña de la API incorrectos', 'EAUTH');
    if (r.status === 404) throw new ApiError(`El encoder no tiene ${path}`, 'ENOTFOUND_API');
    if (r.status >= 400) throw new ApiError(`El encoder respondió HTTP ${r.status}`, 'EHTTP');
    return r.text;
}

async function hisiXml(enc, path, params, rootName) {
    const doc = parseXml(await hisiGet(enc, path, params));
    if (!doc || (rootName && doc.name !== rootName)) throw new ApiError(`Respuesta no reconocida en ${path}`, 'EFORMAT');
    return doc;
}

const hisiOutputXml = (enc, input, index) => hisiXml(enc, '/get_output', { input, output: index }, 'output').then(flat);

// Entradas y streams que declara /get_status: un <vi id=N> por entrada con sus <venc id=M>.
// Los firmwares antiguos de una entrada no ponen id: se numeran por orden.
function hisiLayout(doc) {
    const vis = children(doc, 'vi');
    return vis.map((vi, pos) => {
        const id = Number.isInteger(Number(vi.attrs.id)) && vi.attrs.id !== undefined ? Number(vi.attrs.id) : pos;
        const vencs = children(vi, 'venc').map((v, p) => ({ el: v, index: v.attrs.id !== undefined && Number.isInteger(Number(v.attrs.id)) ? Number(v.attrs.id) : p }));
        if (!vencs.length) vencs.push({ el: null, index: 0 });
        const fps = num(vi, 'framerate');
        return {
            id, vi, vencs,
            signal: (fps || 0) > 0,
            width: num(vi, 'width') ?? null,
            height: num(vi, 'height') ?? null,
            fps: fps ?? null,
            interlaced: num(vi, 'interlaced') === 1
        };
    });
}

function hisiStream(input, index, o) {
    const codec = HISI_CODECS[Number(o.venc_codec)] || (o.venc_codec ? `códec ${o.venc_codec}` : '');
    const supported = String(o.venc_codec_supported || '').split(',').map(s => s.trim()).filter(c => HISI_CODEC_IDS[c]);
    return {
        id: `${input}:${index}`,
        input,
        index,
        name: streamName(index),
        enabled: o.venc_enable === undefined ? true : o.venc_enable === '1',
        codec,
        codecs: supported.length ? supported : ['H.264', 'H.265'].filter(c => c === codec || c === 'H.264'),
        width: Number(o.venc_width) || null,
        height: Number(o.venc_height) || null,
        sameAsInput: o.venc_width_height_same_as_input === '1',
        fps: Number(o.venc_framerate) || null,
        bitrate: Number(o.venc_bitrate) || null,
        rc: hisiRcName(o.venc_rc_mode),
        rcs: [...new Set([...Object.values(HISI_RC_MODES), hisiRcName(o.venc_rc_mode)].filter(Boolean))],
        // El profile sólo se ofrece en H.264 (en H.265 el encoder lo ignora)
        profile: codec === 'H.264' && 'venc_profile' in o ? (H264_PROFILES[Number(o.venc_profile)] || `Perfil ${o.venc_profile}`) : null,
        profiles: 'venc_profile' in o ? H264_PROFILES : [],
        gop: Number(o.venc_gop) || null,
        outputs: hisiOutputs(input, index, o)
    };
}

function hisiOutputs(input, index, o) {
    const out = [];
    const id = (key) => `${input}:${index}:${key}`;
    // mode: caller/listener (SRT), push/pull (RTMP). editKind: qué se puede cambiar
    // ('url' destino del caller/push, 'port' puerto de escucha del listener)
    if ('srt_publish_enable' in o) out.push({ id: id('srt_publish'), kind: 'srt', mode: 'caller', label: 'SRT caller', url: o.srt_publish_uri || '', enabled: o.srt_publish_enable === '1', editable: true, editKind: 'url' });
    if ('srt_enable' in o) {
        const port = Number(o.srt_port) || null;
        out.push({ id: id('srt'), kind: 'srt', mode: 'listener', label: 'SRT listener', url: port ? `puerto ${port}` : '', port, enabled: o.srt_enable === '1', editable: 'srt_port' in o, editKind: 'port' });
    }
    if ('rtmp_publish_enable' in o) out.push({ id: id('rtmp_publish'), kind: 'rtmp', mode: 'push', label: 'RTMP push', url: o.rtmp_publish_uri || '', enabled: o.rtmp_publish_enable === '1', editable: true, editKind: 'url' });
    return out;
}

const HISI_OUTPUT_KEYS = {
    srt_publish: { enable: 'srt_publish_enable', url: 'srt_publish_uri', scheme: /^srt:\/\//i },
    srt: { enable: 'srt_enable', port: 'srt_port' },
    rtmp_publish: { enable: 'rtmp_publish_enable', url: 'rtmp_publish_uri', scheme: /^rtmps?:\/\//i }
};

const hisilicon = {
    async detect(enc) {
        const doc = await hisiXml(enc, '/get_status', null, 'status');
        return { model: txt(doc, 'cpuinfo') || '', version: txt(doc, 'version') || '', inputs: Math.max(1, children(doc, 'vi').length) };
    },

    // Telemetría (cada 10 s): /get_status y el /get_output de cada stream para saber qué emite
    async poll(enc) {
        const doc = await hisiXml(enc, '/get_status', null, 'status');
        const layout = hisiLayout(doc);
        const inputs = await Promise.all(layout.map(async (L) => {
            const streams = await Promise.all(L.vencs.map(async ({ el, index }) => {
                const o = await hisiOutputXml(enc, L.id, index).catch(() => null);
                const outs = o ? hisiOutputs(L.id, index, o) : [];
                return {
                    index,
                    bitrate: (o && Number(o.venc_bitrate)) || (el ? num(el, 'bitrate') : null) || null,
                    codec: HISI_CODECS[Number((o && o.venc_codec) || (el && txt(el, 'codec')))] || null,
                    streaming: o ? outs.some(x => x.enabled) : null
                };
            }));
            const known = streams.filter(s => s.streaming !== null);
            return {
                id: L.id, signal: L.signal, width: L.width, height: L.height, fps: L.fps,
                streams,
                streaming: known.length ? known.some(s => s.streaming) : null
            };
        }));
        return { cpu: num(doc, 'cpuusage') ?? null, inputs };
    },

    async state(enc) {
        const doc = await hisiXml(enc, '/get_status', null, 'status');
        const layout = hisiLayout(doc);
        const inputs = await Promise.all(layout.map(async (L) => {
            const outs = await Promise.all(L.vencs.map(({ index }) => hisiOutputXml(enc, L.id, index).catch(() => null)));
            return {
                id: L.id, name: inputName(L.id), signal: L.signal, width: L.width, height: L.height, fps: L.fps, interlaced: L.interlaced,
                streams: L.vencs.map(({ index }, k) => (outs[k] ? hisiStream(L.id, index, outs[k]) : null)).filter(Boolean)
            };
        }));
        return {
            device: { model: txt(doc, 'cpuinfo') || '', version: txt(doc, 'version') || '', cpu: num(doc, 'cpuusage') ?? null, uptime: txt(doc, 'runtime') || '' },
            inputs,
            caps: { codec: true, rc: true, gop: true, fps: true, bitrate: { min: 32, max: 32000 }, reboot: true }
        };
    },

    async setStream(enc, streamId, p) {
        const { input, index } = parseStreamId(streamId);
        const q = { input, output: index };
        if (p.bitrate !== undefined) q.venc_bitrate = p.bitrate;
        if (p.fps !== undefined) q.venc_framerate = p.fps;
        if (p.gop !== undefined) q.venc_gop = p.gop;
        if (p.rc !== undefined) q.venc_rc_mode = hisiRcId(p.rc);
        if (p.profile !== undefined) q.venc_profile = H264_PROFILES.indexOf(p.profile);
        if (p.codec !== undefined) q.venc_codec = HISI_CODEC_IDS[p.codec];
        await hisiGet(enc, '/set_output', q);
        const after = await hisiOutputXml(enc, input, index);
        const checks = { venc_bitrate: q.venc_bitrate, venc_framerate: q.venc_framerate, venc_gop: q.venc_gop, venc_rc_mode: q.venc_rc_mode, venc_codec: q.venc_codec, venc_profile: q.venc_profile };
        const ignored = Object.entries(checks).filter(([k, v]) => v !== undefined && after[k] !== undefined && String(after[k]) !== String(v)).map(([k]) => k);
        if (ignored.length) throw new ApiError(`El encoder no aplicó: ${ignored.join(', ')} (fuera de rango para este modelo)`, 'ENOTAPPLIED');
    },

    async setOutput(enc, outputId, p) {
        const m = /^(\d{1,2}):(\d{1,2}):([a-z_]+)$/.exec(String(outputId));
        const def = m && HISI_OUTPUT_KEYS[m[3]];
        if (!def) throw new ApiError('Salida no válida', 'EINVAL');
        const input = Number(m[1]);
        const index = Number(m[2]);
        const q = { input, output: index };
        if (p.url !== undefined) {
            if (!def.url) throw new ApiError('Esta salida no tiene URL', 'EINVAL');
            if (!def.scheme.test(p.url)) throw new ApiError('La URL no corresponde al protocolo de la salida', 'EINVAL');
            q[def.url] = p.url;
        }
        if (p.port !== undefined) {
            if (!def.port) throw new ApiError('Esta salida no tiene puerto de escucha', 'EINVAL');
            q[def.port] = p.port;
        }
        if (p.enabled !== undefined) q[def.enable] = p.enabled ? 1 : 0;
        await hisiGet(enc, '/set_output', q);
        const after = await hisiOutputXml(enc, input, index);
        if (p.enabled !== undefined && after[def.enable] !== undefined && after[def.enable] !== (p.enabled ? '1' : '0')) {
            throw new ApiError('El encoder no cambió el estado de la salida', 'ENOTAPPLIED');
        }
        if (p.port !== undefined && after[def.port] !== undefined && after[def.port] !== String(p.port)) {
            throw new ApiError(`El encoder no aceptó el puerto ${p.port}`, 'ENOTAPPLIED');
        }
    },

    async reboot(enc) {
        const text = await hisiGet(enc, '/reboot');
        if (/fail/i.test(text)) throw new ApiError('El encoder rechazó el reinicio', 'EREFUSED');
    }
};

/* =======================================
 *  DRIVER Zowietek (ZowieAPI): una entrada, streams main (0) y sub (1)
 * ======================================= */
const ZOWIE_OK = new Set(['00000', '000000']);
const ZOWIE_ERRORS = {
    '00002': 'el programa del equipo aún no está listo', '00003': 'faltan parámetros', '00004': 'el modelo no lo admite',
    '00009': 'operación demasiado rápida, espera un momento', '00010': 'el equipo se está reiniciando', '10001': 'sin señal de entrada',
    '60002': 'no se pudo iniciar la emisión', '60003': 'no se pudo parar la emisión', '60004': 'URL no válida',
    '60005': 'protocolo no admitido', '60007': 'hay que parar la emisión antes de cambiarla', '60013': 'índice de emisión no válido',
    '110001': 'la grabación ya está en marcha', '110002': 'soporte de grabación no válido',
    '110005': 'no se pudo iniciar la grabación (¿hay USB/SD/NAS montado y con espacio?)', '110007': 'hay una grabación en curso',
    '80003': 'la API pide iniciar sesión', '80004': 'la cuenta no es de administrador', '80005': 'contraseña incorrecta'
};

async function zowie(enc, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (enc.api_user) headers.Authorization = 'Basic ' + Buffer.from(`${enc.api_user}:${enc.api_pass || ''}`).toString('base64');
    const r = await request(enc, { method: 'POST', path: `${path}&login_check_flag=1`, body, headers });
    if (r.status === 401 || r.status === 403) throw new ApiError('Usuario o contraseña de la API incorrectos', 'EAUTH');
    if (r.status >= 400) throw new ApiError(`El encoder respondió HTTP ${r.status}`, r.status === 404 ? 'ENOTFOUND_API' : 'EHTTP');
    let json;
    try { json = JSON.parse(r.text); } catch { throw new ApiError('Respuesta no reconocida (no es ZowieAPI)', 'EFORMAT'); }
    if (!json || typeof json.status !== 'string') throw new ApiError('Respuesta no reconocida (no es ZowieAPI)', 'EFORMAT');
    if (!ZOWIE_OK.has(json.status)) {
        const code = ['80003', '80004', '80005'].includes(json.status) ? 'EAUTH' : 'EDEVICE';
        throw new ApiError(`ZowieAPI ${json.status}: ${ZOWIE_ERRORS[json.status] || json.rsp || 'error del equipo'}`, code);
    }
    return json;
}

const pick = (obj) => (obj && typeof obj === 'object' ? obj : {});
const listSel = (o, listKey) => { const x = pick(o); const l = Array.isArray(x[listKey]) ? x[listKey] : []; return l[Number(x.selected_id)] ?? null; };

// ZowieAPI da el profile abreviado (BP/MP/HP)
const ZOWIE_PROFILES = { BP: 'Baseline', MP: 'Main', HP: 'High' };
const zowieProfileName = (x) => (x == null ? null : ZOWIE_PROFILES[String(x).toUpperCase()] || String(x));

function zowieStream(v, outputs) {
    const index = Number(v.venc_chnid) || 0;
    return {
        id: `0:${index}`,
        input: 0,
        index,
        name: streamName(index),
        enabled: true,
        codec: listSel(v.codec, 'codec_list'),
        codecs: (pick(v.codec).codec_list || []).filter(c => c === 'H.264' || c === 'H.265'),
        width: Number(v.width) || null,
        height: Number(v.height) || null,
        fps: Number(v.framerate) || null,
        bitrate: Number(v.bitrate) || null,
        rc: listSel(v.ratecontrol, 'mode_list'),
        rcs: (pick(v.ratecontrol).mode_list || []).filter(Boolean),
        profile: listSel(v.codec, 'codec_list') === 'H.264' ? zowieProfileName(listSel(v.profile, 'profile_list')) : null,
        profiles: (pick(v.profile).profile_list || []).map(zowieProfileName).filter(Boolean),
        gop: Number(v.gop) || Number(v.keyinterval) || null,
        // Las emisiones de ZowieBox salen del stream principal
        outputs: index === 0 ? outputs : []
    };
}

// La lista de emisiones (publish) cambia de forma según el firmware: se buscan objetos con index + switch
function zowiePublishList(data) {
    const found = [];
    const seen = new Set();
    const walk = (x, depth) => {
        if (!x || typeof x !== 'object' || depth > 4) return;
        if (Array.isArray(x)) return x.forEach(i => walk(i, depth + 1));
        if ('index' in x && 'switch' in x && ('url' in x || 'protocol' in x || 'service' in x) && !seen.has(String(x.index))) {
            seen.add(String(x.index));
            found.push(x);
            return;
        }
        Object.values(x).forEach(v => walk(v, depth + 1));
    };
    walk(data, 0);
    return found.map(p => {
        const proto = String(p.protocol || p.service || '').toLowerCase();
        const url = String(p.url || '');
        const kind = proto.includes('srt') || /^srt:/i.test(url) ? 'srt' : proto.includes('rtmp') || /^rtmps?:/i.test(url) ? 'rtmp' : (proto || 'stream');
        // Las emisiones (publish) de ZowieBox salen del equipo: SRT en caller, RTMP en push
        const mode = /mode=listener/i.test(url) ? 'listener' : kind === 'srt' ? 'caller' : kind === 'rtmp' ? 'push' : '';
        return {
            id: `pub:${p.index}`,
            kind,
            mode,
            label: p.name || p.desc || p.service || `Emisión ${p.index}`,
            url,
            enabled: Number(p.switch) === 1,
            editable: false // cambiar la URL exige borrar y volver a crear la emisión: se hace en su web
        };
    });
}

// Grabación local (USB, tarjeta SD, NAS): una tarea por soporte. status: 0 parada, 1 grabando,
// 2 en pausa, 3 soporte lleno, 4 soporte no montado, 5 sin señal
const ZOWIE_REC_LABELS = { usb: 'USB', sdcard: 'SD', sd: 'SD', nas: 'NAS' };
const ZOWIE_REC_STATES = ['stopped', 'recording', 'paused', 'full', 'nostorage', 'nosignal'];
const ZOWIE_REC_COMMANDS = { stop: 0, start: 1, pause: 2, resume: 3 };

function zowieRecordList(data) {
    const found = [];
    const seen = new Set();
    const walk = (x, depth) => {
        if (!x || typeof x !== 'object' || depth > 4) return;
        if (Array.isArray(x)) return x.forEach(i => walk(i, depth + 1));
        const key = x.id ?? x.index;
        if (key !== undefined && 'status' in x && /^(usb|sdcard|sd|nas)\d*_\d+$/i.test(String(key)) && !seen.has(String(key))) {
            seen.add(String(key));
            found.push(x);
            return;
        }
        Object.values(x).forEach(v => walk(v, depth + 1));
    };
    walk(data, 0);
    return found.map(t => {
        const storage = String(t.id ?? t.index);
        const status = Number(t.status);
        const state = ZOWIE_REC_STATES[status] || 'stopped';
        return {
            id: `rec:${storage}`,
            storage,
            label: ZOWIE_REC_LABELS[storage.replace(/\d*_\d+$/, '').toLowerCase()] || storage,
            name: t.name || '',
            status,
            state,
            recording: state === 'recording' || state === 'paused',
            start: t.start_time || ''
        };
    });
}

async function zowieRecords(enc) {
    try {
        const r = await zowie(enc, '/record?option=getinfo', { group: 'record', opt: 'get_task_list' });
        const list = zowieRecordList(r.data);
        return list.length ? list : null;
    } catch {
        return null; // modelo sin grabación local o firmware que no la expone
    }
}

async function zowieVenc(enc) {
    const r = await zowie(enc, '/video?option=getinfo', { group: 'all' });
    return Array.isArray(pick(r.data).venc) ? r.data.venc : [];
}

async function zowieRead(enc) {
    const [inp, venc, pub, records] = await Promise.all([
        zowie(enc, '/video?option=getinfo', { group: 'hdmi', opt: 'get_input_info' }).catch(() => null),
        zowieVenc(enc),
        zowie(enc, '/streamplay?option=getinfo', { group: 'streamplay', opt: 'streamplay_get_all' }).catch(() => null),
        zowieRecords(enc)
    ]);
    return { inp, d: pick(inp && inp.data), venc, outputs: pub ? zowiePublishList(pub.data) : null, records };
}

const zowietek = {
    async detect(enc) {
        await zowie(enc, '/system?option=getinfo', { group: 'systime', opt: 'get_systime_info' });
        return { model: 'Zowietek', version: '', inputs: 1 };
    },

    async poll(enc) {
        const { inp, d, venc, outputs, records } = await zowieRead(enc);
        const streams = venc.map(v => ({
            index: Number(v.venc_chnid) || 0,
            bitrate: Number(v.bitrate) || null,
            codec: listSel(v.codec, 'codec_list'),
            streaming: Number(v.venc_chnid) === 0 && outputs ? outputs.some(o => o.enabled) : null
        }));
        return {
            cpu: null,
            inputs: [{
                id: 0,
                signal: inp ? Number(d.hdmi_signal) === 1 : null,
                width: Number(d.width) || null, height: Number(d.height) || null, fps: Number(d.framerate) || null,
                streams,
                streaming: outputs ? outputs.some(o => o.enabled) : null,
                recording: records ? records.some(r => r.recording) : null
            }]
        };
    },

    async state(enc) {
        const { inp, d, venc, outputs, records } = await zowieRead(enc);
        return {
            device: { model: 'Zowietek', version: '', cpu: null },
            inputs: [{
                id: 0, name: inputName(0),
                signal: inp ? Number(d.hdmi_signal) === 1 : null,
                width: Number(d.width) || null, height: Number(d.height) || null, fps: Number(d.framerate) || null, desc: d.desc || '',
                streams: venc.map(v => zowieStream(v, outputs || [])),
                recordings: records || []
            }],
            caps: { codec: true, rc: true, gop: true, fps: true, bitrate: { min: 64, max: 51200 }, reboot: true, record: !!records }
        };
    },

    async setRecord(enc, recordId, command) {
        const m = /^rec:((?:usb|sdcard|sd|nas)\d*_\d+)$/i.exec(String(recordId));
        if (!m) throw new ApiError('Grabación no válida', 'EINVAL');
        if (!(command in ZOWIE_REC_COMMANDS)) throw new ApiError('Orden de grabación no válida', 'EINVAL');
        await zowie(enc, '/record?option=setinfo', { group: 'record', opt: 'set_task_enable', data: { index: m[1], enable: ZOWIE_REC_COMMANDS[command] } });
    },

    async setStream(enc, streamId, p) {
        const { input, index } = parseStreamId(streamId);
        if (input !== 0) throw new ApiError('Este encoder sólo tiene una entrada', 'EINVAL');
        const venc = await zowieVenc(enc);
        const cur = venc.find(v => Number(v.venc_chnid) === index);
        if (!cur) throw new ApiError('Ese stream no existe en el encoder', 'EINVAL');
        const next = JSON.parse(JSON.stringify(cur));
        if (p.bitrate !== undefined) next.bitrate = p.bitrate;
        if (p.fps !== undefined) next.framerate = p.fps;
        if (p.gop !== undefined) next.gop = p.gop;
        const setSel = (o, listKey, value) => {
            const i = (pick(o)[listKey] || []).indexOf(value);
            if (i < 0) throw new ApiError(`El encoder no admite ${value}`, 'EINVAL');
            o.selected_id = i;
        };
        if (p.codec !== undefined) setSel(next.codec, 'codec_list', p.codec);
        if (p.rc !== undefined) setSel(next.ratecontrol, 'mode_list', p.rc);
        if (p.profile !== undefined) {
            const list = pick(next.profile).profile_list || [];
            const i = list.findIndex(x => zowieProfileName(x) === p.profile);
            if (i < 0) throw new ApiError(`El encoder no admite el profile ${p.profile}`, 'EINVAL');
            next.profile.selected_id = i;
        }
        await zowie(enc, '/video?option=setinfo', { group: 'venc', venc: [next] });
    },

    async setOutput(enc, outputId, p) {
        const m = /^pub:(\d+)$/.exec(String(outputId));
        if (!m) throw new ApiError('Salida no válida', 'EINVAL');
        if (p.url !== undefined || p.port !== undefined) throw new ApiError('En Zowietek el destino de una emisión se cambia desde su web', 'EINVAL');
        if (p.enabled === undefined) return;
        await zowie(enc, '/streamplay?option=setinfo', { group: 'publish', opt: 'update_publish_switch', data: { index: Number(m[1]), switch: p.enabled ? 1 : 0 } });
    },

    async reboot(enc) {
        await zowie(enc, '/system?option=setinfo', { group: 'syscontrol', opt: 'set_reboot_info', data: { command: 'reboot' } });
    }
};

/* =======================================
 *  DRIVER DECODER SDI HW Stream / URAY (firmware «sdi_hb», p. ej. ver2.2.8_20200723_sdi_hb_01_03)
 *
 *  Leído de la propia web del decoder. GET con autenticación básica (admin/admin), respuestas JSON:
 *    /get_status   { result: { split_screen_count, video_stream_urls{0..3}, output_screen_resolution }, status }
 *                  status 3 = no está reproduciendo ningún stream
 *    /get_codec    { data: { split_mode, input_urls{0..3}, hdmi_mode, hdmi_modes[], cvbs_mode, cvbs_modes[],
 *                    addr_way, play_file, current_play, output_mode_selected, audio_source_channel }, status: 0 }
 *    /set_codec?request=<JSON>  { output_mode_selected, split_mode, addr_way, play_file, current_play,
 *                    input_urls{0..3} } -> { status: 0 } si se aplicó
 *    /set_hdmi_mode?hdmi_mode=1920x1080i-50 -> "succeed"
 *    /get_version  { status: 1, versionData: { versionName } }
 *    /reboot -> "succeed"   (/reset es el restablecimiento de fábrica: no se usa nunca)
 *    /get_srt      { split_mode, srt1..srt4: { status, ip, port, latency, passphrase, listen, srt_ip,
 *                    srt_port, transport, udp_ip, udp_port, id } }   (apartado «SRT Settings»)
 *    /set_srt?request=<JSON>  el mismo objeto (sin id) -> { status: 0 }
 *  current_play (en /get_codec) es la fuente que reproduce: 0 URL («Open protocol»), 2 protocolo
 *  privado, 3 SRT (visto con SRT1 activo). Guardar un apartado pasa el decoder a esa fuente, como
 *  en su web. split_mode de SRT: 0 un canal, 1 dos, 2 cuatro.
 *  Su web manda request ya pasado por encodeURIComponent y jQuery lo vuelve a codificar: el firmware
 *  espera el JSON codificado dos veces, y así se envía aquí.
 * ======================================= */
const DEC_CHANNELS = 4;
const DEC_SOURCES = { 0: 'url', 1: 'file', 2: 'private', 3: 'srt' };
const DEC_SRT_SPLITS = [{ value: 0, label: '1 canal', channels: 1 }, { value: 1, label: '2 canales', channels: 2 }, { value: 2, label: '4 canales', channels: 4 }];

// Canal SRT del decoder tal como lo maneja el panel
function decSrtChannel(c) {
    c = c || {};
    return {
        enabled: !!c.status,
        mode: c.listen ? 'listener' : 'caller',
        host: c.listen ? '' : String(c.ip || ''),
        port: Number(c.port) > 0 ? Number(c.port) : null,
        listenPort: Number(c.srt_port) > 0 ? Number(c.srt_port) : null,
        latency: Number(c.latency) > 0 ? Number(c.latency) : null,
        passphrase: String(c.passphrase || '')
    };
}

async function decSrt(enc) {
    const r = await decJson(enc, '/get_srt');
    if (!r || typeof r.srt1 !== 'object') throw new ApiError('Respuesta no reconocida en /get_srt', 'EFORMAT');
    return r;
}
// split_mode: su web ofrece 1 X 1 (0) y 2 X 2 (2); el 1 lo trata también como división en 4
const DEC_SPLITS = [{ value: 0, label: '1×1', channels: 1 }, { value: 2, label: '2×2', channels: 4 }];

async function decJson(enc, path, params) {
    const text = await hisiGet(enc, path, params);
    try { return JSON.parse(text); } catch { throw new ApiError(`Respuesta no reconocida en ${path}`, 'EFORMAT'); }
}

const decUrls = (obj) => Array.from({ length: DEC_CHANNELS }, (_, i) => String((obj && (obj[i] ?? obj[String(i)])) || ''));

async function decCodec(enc) {
    const r = await decJson(enc, '/get_codec');
    if (!r || !r.data || typeof r.data.input_urls !== 'object') throw new ApiError('Respuesta no reconocida en /get_codec', 'EFORMAT');
    return r.data;
}

const hwsdec = {
    async detect(enc) {
        await decCodec(enc);
        return {};
    },

    async poll(enc) {
        const [r, d, s] = await Promise.all([
            decJson(enc, '/get_status'),
            decCodec(enc).catch(() => null),
            decSrt(enc).catch(() => null)
        ]);
        if (!r || !r.result) throw new ApiError('Respuesta no reconocida en /get_status', 'EFORMAT');
        const split = Number(r.result.split_screen_count) || 0;
        const out = { decoder: true, playing: Number(r.status) !== 3, split, urls: decUrls(r.result.video_stream_urls) };
        if (d) out.source = DEC_SOURCES[Number(d.current_play)] || `modo ${d.current_play}`;
        if (s) {
            const n = (DEC_SRT_SPLITS.find(x => x.value === Number(s.split_mode)) || DEC_SRT_SPLITS[0]).channels;
            out.srt = [1, 2, 3, 4].slice(0, n).map(i => decSrtChannel(s[`srt${i}`])).map(({ passphrase, ...c }) => ({ ...c, encrypted: !!passphrase }));
        }
        return out;
    },

    async state(enc) {
        const [d, st, ver, srt] = await Promise.all([
            decCodec(enc),
            decJson(enc, '/get_status').catch(() => null),
            decJson(enc, '/get_version').catch(() => null),
            decSrt(enc).catch(() => null)
        ]);
        const split = Number(d.split_mode) || 0;
        return {
            decoder: true,
            device: { model: 'Decoder SDI', version: ver && ver.versionData ? ver.versionData.versionName : '' },
            playing: st ? Number(st.status) !== 3 : null,
            source: DEC_SOURCES[Number(d.current_play)] || `modo ${d.current_play}`,
            srt: srt ? { split: Number(srt.split_mode) || 0, splits: DEC_SRT_SPLITS, channels: [1, 2, 3, 4].map(i => decSrtChannel(srt[`srt${i}`])) } : null,
            split,
            splits: DEC_SPLITS,
            urls: decUrls(d.input_urls),
            fileMode: String(d.addr_way) === '1',
            privateProtocol: Number(d.current_play) === 2,
            hdmiMode: d.hdmi_mode || '',
            hdmiModes: Array.isArray(d.hdmi_modes) ? d.hdmi_modes.map(String) : []
        };
    },

    // Cambia la división y las URLs; el resto de la configuración se reenvía tal como está
    async setConfig(enc, { split, urls }) {
        const d = await decCodec(enc);
        const cur = decUrls(d.input_urls);
        const next = Array.isArray(urls) ? cur.map((u, i) => (urls[i] === undefined || urls[i] === null ? u : String(urls[i]))) : cur;
        const request = {
            output_mode_selected: d.output_mode_selected ?? 0,
            split_mode: split === undefined ? Number(d.split_mode) || 0 : split,
            addr_way: '0', // reproducir por URL (no un archivo local del decoder)
            play_file: d.play_file || '',
            current_play: Number(d.current_play) === 2 ? 2 : 0,
            input_urls: Object.fromEntries(next.map((u, i) => [String(i), u]))
        };
        const r = await decJson(enc, '/set_codec', { request: encodeURIComponent(JSON.stringify(request)), _: Date.now() });
        if (!r || Number(r.status) !== 0) throw new ApiError('El decoder rechazó la configuración', 'EREJECTED');
        // Estos firmwares a veces responden OK sin aplicar: se comprueba leyendo de nuevo
        const after = await decCodec(enc);
        const got = decUrls(after.input_urls);
        if (got.some((u, i) => u !== next[i]) || (Number(after.split_mode) || 0) !== request.split_mode) {
            throw new ApiError('El decoder respondió OK pero no guardó los cambios', 'ENOTAPPLIED');
        }
    },

    // Apartado SRT: división y, por canal, activado, caller (destino) o listener (puerto propio),
    // latencia y passphrase. Lo demás del canal (salida UDP, transporte) se reenvía tal como está.
    async setSrt(enc, { split, channels }) {
        const cur = await decSrt(enc);
        const request = { split_mode: split === undefined ? Number(cur.split_mode) || 0 : split };
        for (let i = 1; i <= DEC_CHANNELS; i++) {
            const { id, ...c } = cur[`srt${i}`] || {};
            const p = Array.isArray(channels) ? channels[i - 1] : null;
            const next = {
                status: !!c.status, ip: String(c.ip || ''), port: Number(c.port ?? -1), transport: !!c.transport,
                latency: Number(c.latency) || 0, passphrase: String(c.passphrase || ''), listen: !!c.listen,
                srt_ip: String(c.srt_ip || ''), srt_port: Number(c.srt_port) || 0,
                udp_ip: String(c.udp_ip || ''), udp_port: Number(c.udp_port) || 0
            };
            if (p) {
                if (p.enabled !== undefined) next.status = !!p.enabled;
                if (p.mode !== undefined) next.listen = p.mode === 'listener';
                if (p.host !== undefined && !next.listen) next.ip = p.host;
                if (p.port !== undefined && p.port !== null) next.port = p.port;
                if (p.listenPort !== undefined && p.listenPort !== null) next.srt_port = p.listenPort;
                if (p.latency !== undefined && p.latency !== null) next.latency = p.latency;
                if (p.passphrase !== undefined && p.passphrase !== null) next.passphrase = p.passphrase;
            }
            request[`srt${i}`] = next;
        }
        const r = await decJson(enc, '/set_srt', { request: encodeURIComponent(JSON.stringify(request)), _: Date.now() });
        if (!r || Number(r.status) !== 0) throw new ApiError('El decoder rechazó la configuración SRT', 'EREJECTED');
        // Comprobación: lo leído después tiene que coincidir con lo enviado
        const after = await decSrt(enc);
        const keys = ['status', 'ip', 'port', 'latency', 'passphrase', 'listen', 'srt_port'];
        const bad = [1, 2, 3, 4].some(i => {
            const a = after[`srt${i}`] || {};
            const b = request[`srt${i}`];
            return keys.some(k => (k === 'ip' && b.listen ? false : String(typeof b[k] === 'boolean' ? !!a[k] : a[k]) !== String(b[k])));
        });
        if (bad || (Number(after.split_mode) || 0) !== request.split_mode) {
            throw new ApiError('El decoder respondió OK pero no guardó la configuración SRT', 'ENOTAPPLIED');
        }
    },

    async setHdmiMode(enc, mode) {
        const d = await decCodec(enc);
        if (!(d.hdmi_modes || []).map(String).includes(mode)) throw new ApiError('Resolución HDMI no admitida por el decoder', 'EINVAL');
        const text = await hisiGet(enc, '/set_hdmi_mode', { hdmi_mode: mode, _: Date.now() });
        if (text.trim() !== 'succeed') throw new ApiError('El decoder no aceptó la resolución', 'EREJECTED');
    },

    async reboot(enc) {
        await hisiGet(enc, '/reboot', { _: Date.now() });
    }
};

/* =======================================
 *  REGISTRO Y DETECCIÓN
 * ======================================= */
const DRIVERS = {
    uray: { label: 'URAY (CGI)', impl: hisilicon },
    hwstream: { label: 'HW Stream (CGI)', impl: hisilicon },
    zowietek: { label: 'Zowietek (ZowieAPI)', impl: zowietek },
    hwsdec: { label: 'Decoder SDI HW Stream / URAY', impl: hwsdec, decoder: true }
};
// Fabricantes que se pueden elegir según el tipo de equipo
const DRIVER_CHOICES = ['auto', 'none', ...Object.keys(DRIVERS).filter(d => !DRIVERS[d].decoder)];
const DECODER_DRIVER_CHOICES = ['auto', 'none', ...Object.keys(DRIVERS).filter(d => DRIVERS[d].decoder)];

// Decoders: hoy sólo hay una API conocida
async function detectDecoder(enc) {
    try {
        return { driver: 'hwsdec', info: await hwsdec.detect(enc) };
    } catch (e) {
        if (e.code === 'EAUTH') return { driver: 'hwsdec', info: null, error: e };
        if (e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH') throw e;
        throw new ApiError('API del decoder no reconocida: elige el fabricante o usa su web', 'EUNKNOWN');
    }
}

// Un canal SRT del decoder tal como llega del panel. null = no tocarlo.
function validateDecoderSrt(p, n) {
    if (p === null || p === undefined) return null;
    const label = `SRT ${n}`;
    const out = { enabled: !!p.enabled, mode: p.mode === 'listener' ? 'listener' : 'caller' };
    const intIn = (v, min, max, what) => {
        if (v === '' || v === null || v === undefined) return null;
        const x = Number(v);
        if (!Number.isInteger(x) || x < min || x > max) throw new ApiError(`${label}: ${what} entre ${min} y ${max}`, 'EINVAL');
        return x;
    };
    out.port = intIn(p.port, 1, 65535, 'puerto');
    out.listenPort = intIn(p.listenPort, 1, 65535, 'puerto de escucha');
    out.latency = intIn(p.latency, 20, 8000, 'latencia (ms)');
    if (out.mode === 'caller') {
        const host = String(p.host || '').trim();
        if (host && (host.length > 253 || !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host))) throw new ApiError(`${label}: dirección no válida`, 'EINVAL');
        if (out.enabled && (!host || !out.port)) throw new ApiError(`${label}: en modo caller hacen falta dirección y puerto`, 'EINVAL');
        out.host = host;
    } else if (out.enabled && !out.listenPort) {
        throw new ApiError(`${label}: en modo listener hace falta el puerto de escucha`, 'EINVAL');
    }
    if (p.passphrase !== undefined && p.passphrase !== null) {
        const pass = String(p.passphrase);
        // SRT exige de 10 a 79 caracteres; vacío = sin cifrar
        if (pass && (pass.length < 10 || pass.length > 79 || /[\s"'<>\\]/.test(pass))) throw new ApiError(`${label}: la passphrase va de 10 a 79 caracteres, sin espacios ni comillas`, 'EINVAL');
        out.passphrase = pass;
    }
    return out;
}

// URLs de stream de un decoder: vacía (canal sin usar) o srt/rtmp/udp/rtp/rtsp/http, sin espacios ni comillas
function validateDecoderUrl(u) {
    const url = String(u === null || u === undefined ? '' : u).trim();
    if (!url) return '';
    if (url.length > 512 || /[\s"'<>\\]/.test(url) || !/^(srt|rtmp|rtmps|udp|rtp|rtsp|http|https):\/\//i.test(url)) {
        throw new ApiError(`URL no válida: ${url.slice(0, 60)} (srt://, rtmp://, udp://, rtsp://…)`, 'EINVAL');
    }
    return url;
}

// Prueba las APIs en orden. Un error de credenciales cuenta como detectado (la API existe).
// HiSilicon va primero: su 401 de autenticación básica identifica el firmware; ZowieAPI no la usa.
async function detect(enc) {
    for (const [name, impl] of [['uray', hisilicon], ['zowietek', zowietek]]) {
        try {
            const info = await impl.detect(enc);
            return { driver: name, info };
        } catch (e) {
            if (e.code === 'EAUTH') return { driver: name, info: null, error: e };
            if (e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH') throw e; // no responde: no seguir probando
        }
    }
    throw new ApiError('API no reconocida: elige el fabricante en el encoder o usa su web', 'EUNKNOWN');
}

function impl(driver) {
    const d = DRIVERS[driver];
    if (!d) throw new ApiError('Este encoder no tiene control por API', 'ENODRIVER');
    return d.impl;
}

/* =======================================
 *  VALIDACIÓN DE ÓRDENES
 * ======================================= */
function validateStreamParams(body, caps) {
    const out = {};
    const intIn = (k, min, max, label) => {
        if (body[k] === undefined || body[k] === '' || body[k] === null) return;
        const n = Number(body[k]);
        if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(`${label}: entre ${min} y ${max}`, 'EINVAL');
        out[k] = n;
    };
    const br = (caps && caps.bitrate) || { min: 32, max: 51200 };
    intIn('bitrate', br.min, br.max, 'Bitrate (kbps)');
    intIn('fps', 1, 60, 'Fotogramas por segundo');
    intIn('gop', 1, 600, 'GOP (fotogramas entre claves)');
    if (body.codec !== undefined && body.codec !== '') {
        if (!['H.264', 'H.265'].includes(body.codec)) throw new ApiError('Códec no válido', 'EINVAL');
        out.codec = body.codec;
    }
    // Modo y profile se comprueban además contra lo que ofrece ese stream (rcs / profiles)
    if (body.rc !== undefined && body.rc !== '') {
        if (typeof body.rc !== 'string' || !/^[A-Za-z0-9 ._-]{1,24}$/.test(body.rc)) throw new ApiError('Modo de bitrate no válido', 'EINVAL');
        out.rc = body.rc;
    }
    if (body.profile !== undefined && body.profile !== '') {
        if (!H264_PROFILES.includes(body.profile)) throw new ApiError('Profile H.264 no válido (Baseline, Main o High)', 'EINVAL');
        out.profile = body.profile;
    }
    if (!Object.keys(out).length) throw new ApiError('No hay cambios que aplicar', 'EINVAL');
    return out;
}

module.exports = {
    DRIVERS, DRIVER_CHOICES, DECODER_DRIVER_CHOICES, DEC_SPLITS, DEC_SRT_SPLITS, validateDecoderSrt, ApiError, detect, detectDecoder, impl,
    validateStreamParams, validateDecoderUrl, locate, parseStreamId,
    _test: { parseXml, flat, hisilicon, zowietek, hwsdec, zowiePublishList, zowieRecordList }
};
