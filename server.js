const express = require('express');
const tlsConfig = require('./tlsConfig'); // HTTPS si hay TLS_CERT_FILE/TLS_KEY_FILE; si no, HTTP
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const auth = require('./auth');
const access = require('./access');
const { checkOperatorUrl, serverLocalHosts, hostToResolve, checkResolvedHost, ERR_RESOLVER } = require('./urlGuard');
const dns = require('dns');
const { channelOfRecording, RECORDING_DIR } = require('./recordings');
const metrics = require('./metrics');
const srt = require('./srt');
const portCheck = require('./portCheck');
const history = require('./history');
const streamManager = require('./streamManager');
const sysMonitor = require('./sysMonitor');
const rtmpServer = require('./rtmpServer');
const encoders = require('./encoders');
const telegram = require('./telegram');
const si = require('systeminformation');

const app = express();
const server = tlsConfig.createServer(app);
// Sin CORS: el panel se sirve desde el mismo origen y la cookie de sesión es SameSite=Strict
const io = new Server(server);
io.use(auth.socketAuth);
access.setIo(io);
// Permisos por entrada: se cargan después de los usuarios
auth.init().catch(err => console.error('[AUTH] Error inicializando usuarios', err))
    .then(() => access.init())
    .catch(err => console.error('[ACCESS] Error cargando permisos', err));
streamManager.setIo(io);
sysMonitor.setIo(io);
encoders.init(io).catch(err => console.error('[ENCODERS] Error inicializando', err));
db.get('SELECT rtmpPort FROM ports LIMIT 1', (err, row) => {
    let port = 1935;
    if (row && row.rtmpPort) port = row.rtmpPort;
    rtmpServer.startRtmpServer(port);
});

// Media Root for USB Recording and Playback
const mediaRoot = process.platform === 'win32' ? path.join(__dirname, 'media') : '/media';
if (!fs.existsSync(mediaRoot)) {
    try { fs.mkdirSync(mediaRoot, { recursive: true }); } catch (e) {}
}

// Rutas de soportes permitidas para reproducir/borrar grabaciones
const allowedMediaRoots = [mediaRoot, '/media', '/mnt'].map(r => path.resolve(r));
function isAllowedMediaPath(p) {
    if (!p) return false;
    const abs = path.resolve(p); // Normaliza "..": evita path traversal
    return allowedMediaRoots.some(root => abs === root || abs.startsWith(root + path.sep));
}

// Middleware
app.use(express.json());
// Prometheus: token o acceso local (va antes del login, que exige cookie)
app.get('/metrics', metrics.authorize, metrics.handler);
// Todo (panel, API, miniaturas, grabaciones) exige sesión salvo la pantalla de login
app.use(auth.requireAuth);
auth.registerRoutes(app, io);

// Aviso por Telegram de lo que se hace con entradas y salidas desde el panel (quién y qué)
app.use('/api', (req, res, next) => {
    if (req.method === 'GET') return next();
    const m = req.path.match(/^\/(inputs|outputs)(?:\/(\d+))?(?:\/(toggle))?$/);
    if (!m) return next();
    const kind = m[1] === 'inputs' ? 'input' : 'output';
    const json = res.json.bind(res);
    res.json = (body) => {
        if (res.statusCode < 400 && body && !res.locals.notified) {
            res.locals.notified = true;
            let id = m[2];
            let action = null;
            if (m[3] === 'toggle') action = body.enabled ? 'on' : 'off';
            else if (req.method === 'POST' && !m[2]) { id = body.channel || body.id; action = 'create'; }
            else if (req.method === 'PUT' && m[2]) action = 'edit';
            else if (req.method === 'DELETE' && m[2]) action = 'delete';
            if (action && id) telegram.panelAction(req.user && req.user.username, kind, id, action);
        }
        return json(body);
    };
    next();
});
// Miniaturas servidas desde RAM (tmpfs) y sin caché. Sólo las de entradas que el usuario ve.
app.use('/thumbs', (req, res, next) => {
    const m = req.path.match(/^\/thumb_(\d+)\.jpg$/);
    if (!m || !access.canSee(req.user, m[1])) return res.status(404).end();
    next();
});
app.use('/thumbs', express.static(streamManager.THUMBS_DIR, { maxAge: 0, etag: false }));
app.use(express.static(path.join(__dirname, 'public')));
// Acceso directo a /media sólo para administradores (los operadores van por /api/media/play)
app.use('/media', auth.requireAdmin, express.static(mediaRoot));

// Simple API status endpoint
app.get('/api/status', (req, res) => {
    // grafanaPort: el panel muestra el enlace "Gráficas" sólo si hay Grafana instalado.
    // Grafana va por HTTP salvo que el instalador le haya puesto el certificado (GRAFANA_PROTOCOL=https)
    res.json({
        online: true, app: 'TSST SERVER', version: '1.0.0',
        grafanaPort: parseInt(process.env.GRAFANA_PORT, 10) || null,
        grafanaProtocol: process.env.GRAFANA_PROTOCOL === 'https' ? 'https' : 'http',
        https: tlsConfig.enabled
    });
});

const os = require('os');
// Historial de Prometheus para el dashboard (consultas fijas; ver history.js)
app.get('/api/history', auth.requireAdmin, history.handler);
// Encoders remotos: lista, estado, proxy a su web y accesos WireGuard (ver encoders.js)
encoders.registerRoutes(app);

app.get('/api/server-ip', (req, res) => {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return res.json({ ip: iface.address });
            }
        }
    }
    res.json({ ip: '127.0.0.1' });
});

/* =======================================
 *  REST API: INPUTS
 * ======================================= */
// Filas que el usuario puede ver (visibleChannels null = administrador, todo)
function onlyVisible(user, rows) {
    const visible = access.visibleChannels(user);
    return visible ? rows.filter(r => visible.has(String(r.channel))) : rows;
}

app.get('/api/inputs', (req, res) => {
    db.all('SELECT * FROM inputs ORDER BY channel ASC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(onlyVisible(req.user, rows));
    });
});

// Opciones SRT (latencia, passphrase, cifrado) válidas antes de guardar: SRT rechaza en silencio
// una passphrase corta y la señal simplemente no llegaría
function validateSrtBody(req, res, next) {
    const error = srt.validateUrl(req.body && req.body.url);
    if (error) return res.status(400).json({ error });
    next();
}

const dbGet = (sql, params) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const dbAll = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));

// URLs de operadores: ni direcciones de este servidor ni claves RTMP de señales ajenas
// (urlGuard.js), y las grabaciones sólo dentro de los soportes permitidos.
// Los administradores no pasan por aquí.
function operatorUrlGuard(isInput) {
    return async (req, res, next) => {
        const url = req.body && req.body.url;
        if (!req.user || req.user.role === auth.ROLE_ADMIN || typeof url !== 'string' || !url) return next();
        try {
            const items = await dbAll(`SELECT 'input' AS kind, channel, url FROM inputs
                                       UNION ALL SELECT 'output' AS kind, channel, url FROM outputs`);
            const opts = {
                isInput, items,
                canSeeChannel: c => access.canSee(req.user, c),
                localHosts: serverLocalHosts()
            };
            let error = checkOperatorUrl(url, opts);
            // Un nombre (el del propio equipo, x.nip.io...) puede apuntar a este servidor:
            // se resuelve y, si falla, se rechaza
            const host = !error && hostToResolve(url, isInput);
            if (host) {
                let addresses;
                try {
                    addresses = (await dns.promises.lookup(host, { all: true })).map(a => a.address);
                } catch (e) {
                    return res.status(400).json({ error: ERR_RESOLVER });
                }
                error = checkResolvedHost(url, addresses, opts);
            }
            if (error) return res.status(400).json({ error });
            // disk://<ruta>: la grabación se escribe en <carpeta de la ruta>/entrada_<n>; esa carpeta
            // tiene que estar dentro de los soportes (evita disk:///media/usb/../../etc/x)
            const disk = url.trim().match(/^disk:\/\/(.*)$/i);
            if (disk && !isAllowedMediaPath(path.dirname(path.resolve(disk[1])))) {
                return res.status(400).json({ error: 'Formato de URL no permitido' });
            }
            next();
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    };
}

// Puerto ya usado por otra entrada/salida o por otro programa: 409 con el motivo y null.
// Si se puede, devuelve { warning? } para añadirlo a la respuesta.
// Lo que el usuario no ve aparece como 'otra señal del servidor'.
async function portGuard(req, res, url, opts) {
    try {
        const r = await portCheck.check(url, { ...opts, canSeeChannel: c => access.canSee(req.user, c) });
        if (r.error) { res.status(409).json({ error: r.error }); return null; }
        return r;
    } catch (e) {
        console.error('[PORTS]', e.message);
        return {}; // Si la comprobación falla, no se bloquea el guardado
    }
}

// Aviso en el formulario mientras se escribe el puerto
app.get('/api/port-check', async (req, res) => {
    const port = parseInt(req.query.port, 10);
    if (!(port > 0 && port < 65536)) return res.json({});
    const { kind, id } = req.query;
    // self sólo si el usuario ve ese elemento: si no, se ignora (no revela canales ajenos)
    const visible = kind === 'input' ? access.canSee(req.user, id)
        : kind === 'output' ? access.canSeeOutput(req.user, id) : false;
    const self = kind && id && visible ? { kind, id } : null;
    try { res.json(await portCheck.describe(port, self, c => access.canSee(req.user, c))); } catch (e) { res.json({}); }
});

app.post('/api/inputs', validateSrtBody, operatorUrlGuard(true), async (req, res) => {
    const { url, name, provider, location, remote, audiowtdg, wtdgsecs, enabled } = req.body;
    const guard = await portGuard(req, res, url, { isInput: true, willEnable: enabled !== false });
    if (!guard) return;

    // Asignar Udpsrv respetando los límites de Firewall (Settings)
    db.get('SELECT udpMin, udpMax FROM ports LIMIT 1', [], (err, ports) => {
        let udpsrv = req.body.udpsrv;
        if (!udpsrv) {
            const min = ports ? ports.udpMin : 10000;
            const max = ports ? ports.udpMax : 30000;
            udpsrv = Math.floor(Math.random() * (max - min + 1)) + min;
        }

        // Quien la crea es su propietario
        const query = `INSERT INTO inputs (url, name, provider, location, remote, enabled, udpsrv, delay_ms, owner)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const params = [ url || '', name || 'Stream', provider || 'TodoStreaming', location || '', remote || '',
                         enabled !== false ? 1 : 0, udpsrv, parseInt(req.body.delay_ms, 10) || 0, req.user.username ];

        db.run(query, params, async function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const channelId = this.lastID;
            await access.reload().catch(e => console.error('[ACCESS]', e.message));
            res.status(201).json({ channel: channelId, warning: guard.warning });
            io.emit('db_update', { event: 'inputs_changed' });

            // If enabled, auto-start stream Manager
            if (enabled !== false) {
                db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], (err, row) => {
                    if (row) streamManager.startInput(row);
                });
            }
        });
    });
});

// For simplicity, a toggle endpoint
app.post('/api/inputs/:channel/toggle', access.requireChannel(), (req, res) => {
    const channelId = req.params.channel;
    db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], async (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Not found' });
        const newEnabled = row.enabled ? 0 : 1;
        if (newEnabled && !await portGuard(req, res, row.url, { isInput: true, self: { kind: 'input', id: channelId } })) return;
        db.run('UPDATE inputs SET enabled = ? WHERE channel = ?', [newEnabled, channelId], function(err) {
            io.emit('db_update', { event: 'input_toggled', channel: channelId, enabled: newEnabled });
            res.json({ enabled: newEnabled });
            if (newEnabled) {
                // Must get updated row to spawn
                db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], (err, newRow) => {
                   if (newRow) streamManager.startInput(newRow);
                });
            } else {
                streamManager.stopInput(channelId);
            }
        });
    });
});

app.post('/api/inputs/:channel/preview', access.requireChannel(), (req, res) => {
    const channelId = req.params.channel;
    db.get('SELECT preview_enabled FROM inputs WHERE channel = ?', [channelId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Not found' });
        const newState = row.preview_enabled ? 0 : 1;
        db.run('UPDATE inputs SET preview_enabled = ? WHERE channel = ?', [newState, channelId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('db_update', { event: 'preview_changed', channel: channelId, preview_enabled: newState });

            // Encendido: el panel reproduce el HLS dentro de la miniatura (no hay proceso aquí).
            // Apagado: fotograma fijo actualizado para la imagen congelada.
            if (newState === 0) streamManager.startPreview(channelId, true);
            res.json({ preview_enabled: newState });
        });
    });
});

app.post('/api/inputs/:channel/snapshot', access.requireChannel(), (req, res) => {
    const channelId = req.params.channel;
    streamManager.startPreview(channelId, true);
    res.json({ status: 'Snapshot requested' });
});

// Escucha del audio de un input en MP3. La respuesta se abre con el primer audio que sale:
// si el input no tiene pista de audio, FFmpeg termina antes y se devuelve 404.
app.get('/api/audio/:channel', access.requireChannel(), async (req, res) => {
    const child = await streamManager.startListen(req.params.channel).catch(() => null);
    if (!child) return res.status(404).json({ error: 'Entrada parada o demasiados oyentes' });

    const stop = () => child.kill('SIGKILL');
    const timeout = setTimeout(() => {
        stop();
        if (!res.headersSent) res.status(504).json({ error: 'Sin audio' });
    }, 10000);
    req.on('close', stop);

    child.stdout.once('data', (chunk) => {
        clearTimeout(timeout);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
        res.write(chunk);
        child.stdout.pipe(res);
    });
    child.on('close', () => {
        clearTimeout(timeout);
        if (!res.headersSent) res.status(404).json({ error: 'Sin audio' });
        else res.end();
    });
});

// Reproductor HLS bajo demanda. Pedir la lista arranca (o mantiene vivo) el HLS del input.
app.get('/hls/:channel/index.m3u8', access.requireChannel(), async (req, res) => {
    if (!/^\d+$/.test(req.params.channel)) return res.status(404).end();
    const dir = streamManager.ensureHls(req.params.channel);
    if (!dir) return res.status(404).end();
    const file = path.join(dir, 'index.m3u8');
    // La primera vez FFmpeg tarda un par de trozos en escribir la lista
    for (let i = 0; i < 40 && !fs.existsSync(file); i++) {
        await new Promise(r => setTimeout(r, 250));
    }
    res.set('Cache-Control', 'no-store');
    res.type('application/vnd.apple.mpegurl');
    res.sendFile(file, (err) => { if (err && !res.headersSent) res.status(504).end(); });
});

app.get('/hls/:channel/:segment', access.requireChannel(), (req, res) => {
    const { channel, segment } = req.params;
    if (!/^\d+$/.test(channel) || !/^seg_\d+\.ts$/.test(segment)) return res.status(404).end();
    res.set('Cache-Control', 'no-store');
    res.type('video/mp2t');
    res.sendFile(path.join(streamManager.HLS_DIR, channel, segment), (err) => {
        if (err && !res.headersSent) res.status(404).end();
    });
});

// Sincronización: retardo en vivo (ms) de un input. Se aplica sin reiniciar nada.
app.post('/api/inputs/:channel/delay', access.requireChannel(), (req, res) => {
    const channelId = req.params.channel;
    const ms = parseInt(req.body.delay_ms, 10);
    if (isNaN(ms) || ms < 0 || ms > streamManager.MAX_DELAY_MS) {
        return res.status(400).json({ error: `delay_ms debe estar entre 0 y ${streamManager.MAX_DELAY_MS}` });
    }
    db.run('UPDATE inputs SET delay_ms = ? WHERE channel = ?', [ms, channelId], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (!this.changes) return res.status(404).json({ error: 'Not found' });
        const applied = streamManager.setDelay(channelId, ms);
        io.emit('db_update', { event: 'delay_changed', channel: channelId, delay_ms: applied });
        res.json({ delay_ms: applied });
    });
});

app.put('/api/inputs/:channel', access.requireChannel(), validateSrtBody, operatorUrlGuard(true), async (req, res) => {
    const channelId = req.params.channel;
    const { url, name } = req.body;
    let guard = {};
    const prev = await dbGet('SELECT url, enabled FROM inputs WHERE channel = ?', [channelId]).catch(() => null);
    if (prev && url) {
        guard = await portGuard(req, res, url, { isInput: true, self: { kind: 'input', id: channelId }, willEnable: !!prev.enabled, previousUrl: prev.url });
        if (!guard) return;
    }
    // Campos no enviados se conservan (el editor de latencia sólo manda la URL)
    const query = `UPDATE inputs SET url = COALESCE(?, url), name = COALESCE(?, name) WHERE channel = ?`;

    db.run(query, [url ?? null, name ?? null, channelId], function(err) {
        if (err) return res.status(500).json({ error: err.message });

        // Restart the process if it was running with new data
        streamManager.stopInput(channelId);
        db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], (err, row) => {
            if (row && row.enabled) streamManager.startInput(row);
            io.emit('db_update', { event: 'inputs_changed' });
            res.json({ updated: this.changes, warning: guard.warning });
        });
    });
});

// Cambio de propietario de una entrada (sólo admin)
app.put('/api/inputs/:channel/owner', auth.requireAdmin, async (req, res) => {
    const channelId = req.params.channel;
    const owner = req.body && req.body.owner;
    const row = await dbGet('SELECT channel FROM inputs WHERE channel = ?', [channelId]).catch(() => null);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!auth.hasUser(owner)) return res.status(400).json({ error: 'Usuario no encontrado' });
    try {
        await access.setOwner(row.channel, String(owner));
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
    console.log(`[ACCESS] ${req.user.username} pasó la entrada ${row.channel} a ${owner}`);
    io.emit('db_update', { event: 'inputs_changed' });
    res.json({ owner: String(owner) });
});

app.delete('/api/inputs/:channel', access.requireChannel(), (req, res) => {
    const channelId = req.params.channel;
    streamManager.stopInput(channelId);

    db.run('DELETE FROM inputs WHERE channel = ?', [channelId], function(err) {
        if (err) return res.status(500).json({ error: err.message });

        // Stop related outputs
        db.all('SELECT id FROM outputs WHERE channel = ?', [channelId], (err, rows) => {
            if (rows) rows.forEach(r => streamManager.stopOutput(r.id));
            db.run('DELETE FROM outputs WHERE channel = ?', [channelId], async () => {
                // Fuera sus asignaciones; forgetChannel recarga la caché de permisos
                await access.forgetChannel(channelId).catch(e => console.error('[ACCESS]', e.message));
                res.json({ deleted: true });
                io.emit('db_update', { event: 'inputs_changed' });
            });
        });
    });
});

/* =======================================
 *  REST API: OUTPUTS
 * ======================================= */
app.get('/api/outputs', (req, res) => {
    db.all('SELECT * FROM outputs', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(onlyVisible(req.user, rows));
    });
});

app.post('/api/outputs', validateSrtBody, operatorUrlGuard(false), async (req, res) => {
    const { channel, url, location, remote, enabled, vcodec } = req.body;
    if (!channel) return res.status(400).json({ error: "Input 'channel' is required" });
    if (!access.canSee(req.user, channel)) return res.status(404).json({ error: 'Not found' });
    const guard = await portGuard(req, res, url, { isInput: false, willEnable: enabled !== false });
    if (!guard) return;

    // We need the udpsrv of the parent channel to link them
    db.get('SELECT udpsrv FROM inputs WHERE channel = ?', [channel], (err, parentRaw) => {
        if (err || !parentRaw) return res.status(400).json({ error: "Parent input not found" });

        const udpsrv = parentRaw.udpsrv;
        const query = `INSERT INTO outputs (channel, url, location, remote, enabled, udpsrv, vcodec)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`;
        const params = [ channel, url || '', location || '', remote || '', enabled !== false ? 1 : 0, udpsrv, vcodec || 'copy' ];

        db.run(query, params, async function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const outId = this.lastID;
            await access.reload().catch(e => console.error('[ACCESS]', e.message));
            res.status(201).json({ id: outId, warning: guard.warning });
            io.emit('db_update', { event: 'outputs_changed' });

            if (enabled !== false) {
                db.get('SELECT * FROM outputs WHERE id = ?', [outId], (err, row) => {
                    if (row) streamManager.startOutput(row);
                });
            }
        });
    });
});

app.post('/api/outputs/:id/toggle', access.requireOutput(), (req, res) => {
    const id = req.params.id;
    db.get('SELECT * FROM outputs WHERE id = ?', [id], async (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Not found' });
        const newEnabled = row.enabled ? 0 : 1;
        if (newEnabled && !await portGuard(req, res, row.url, { isInput: false, self: { kind: 'output', id } })) return;
        db.run('UPDATE outputs SET enabled = ? WHERE id = ?', [newEnabled, id], function(err) {
            io.emit('db_update', { event: 'output_toggled', id: id, enabled: newEnabled });
            res.json({ enabled: newEnabled });
            if (newEnabled) {
                db.get('SELECT * FROM outputs WHERE id = ?', [id], (err, newRow) => {
                   if (newRow) streamManager.startOutput(newRow);
                });
            } else {
                streamManager.stopOutput(id);
            }
        });
    });
});

app.put('/api/outputs/:id', access.requireOutput(), validateSrtBody, operatorUrlGuard(false), async (req, res) => {
    const id = req.params.id;
    const { url, location, vcodec } = req.body;
    let guard = {};
    const prev = await dbGet('SELECT url, enabled FROM outputs WHERE id = ?', [id]).catch(() => null);
    if (prev && url) {
        guard = await portGuard(req, res, url, { isInput: false, self: { kind: 'output', id }, willEnable: !!prev.enabled, previousUrl: prev.url });
        if (!guard) return;
    }
    // Campos no enviados se conservan (el editor de latencia sólo manda la URL)
    db.run(`UPDATE outputs SET url = COALESCE(?, url), location = COALESCE(?, location), vcodec = COALESCE(?, vcodec) WHERE id = ?`,
        [url ?? null, location ?? null, vcodec ?? null, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });

        // Restart the process if it was running with new data
        streamManager.stopOutput(id);
        db.get('SELECT o.*, i.udpsrv FROM outputs o JOIN inputs i ON o.channel = i.channel WHERE o.id = ?', [id], (err, row) => {
            if (row && row.enabled) streamManager.startOutput(row);
            io.emit('db_update', { event: 'outputs_changed' });
            res.json({ updated: this.changes, warning: guard.warning });
        });
    });
});

app.delete('/api/outputs/:id', access.requireOutput(), (req, res) => {
    const id = req.params.id;
    streamManager.stopOutput(id);

    db.run('DELETE FROM outputs WHERE id = ?', [id], async function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const deleted = this.changes;
        await access.reload().catch(e => console.error('[ACCESS]', e.message));
        res.json({ deleted });
        io.emit('db_update', { event: 'outputs_changed' });
    });
});

/* =======================================
 *  REST API: SETTINGS / USERS / PORTS
 * ======================================= */
// Usuarios: ver auth.js (gestor sólo para administradores)

/* =======================================
 *  REST API: FILES / STORAGE
 * ======================================= */
app.get('/api/disks', async (req, res) => {
    try {
        let drives = [];

        // Escáner dinámico multi-plataforma real (Evita trampas de carpetas vacías /media/usb0 sin montar)
        const fsSizes = await si.fsSize();

        fsSizes.forEach(f => {
            // En Linux, ignorar particiones internas base y quedarnos con externos (media/mnt). En Windows, coger discos secundarios
            if (f.mount && (f.mount.startsWith('/media') || f.mount.startsWith('/mnt') || (process.platform === 'win32' && f.mount !== 'C:\\' && f.mount !== 'C:'))) {
                drives.push({
                    id: f.mount.replace(/[:\\\/]/g, '_'), // ID seguro
                    name: `[${f.fs}] ${f.mount}`, // ej: [sda1] /media/pi/USB
                    path: f.mount,
                    device: f.fs,
                    size: f.size || 0, // bytes totales y usados: barra de capacidad en el panel
                    used: f.used || 0
                });
            }
        });

        // Fallback robusto/Manual: Si no hay discos detectados por hardware, metemos nuestro default
        if (drives.length === 0) {
            if (process.platform === 'win32') {
                drives.push({ id: 'local_test', name: 'Disco Prueba', path: mediaRoot });
            } else if (fs.existsSync(mediaRoot)) { // Unix fallback
                drives.push({ id: 'local_unix', name: 'Ruta Host Local', path: mediaRoot });
            }
            // Capacidad de la ruta por defecto (statfs existe desde Node 18.15)
            for (const d of drives) {
                try {
                    const s = await fs.promises.statfs(d.path);
                    d.size = s.blocks * s.bsize;
                    d.used = (s.blocks - s.bfree) * s.bsize;
                } catch (e) { /* sin datos de capacidad */ }
            }
        }

        res.json(drives);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ¿Puede el usuario reproducir esa grabación? Admin: cualquiera dentro de los soportes.
// Operador: además tiene que estar en la carpeta entrada_<n> de una entrada que ve.
function canSeeRecording(user, absPath) {
    if (!isAllowedMediaPath(absPath)) return false;
    if (user && user.role === auth.ROLE_ADMIN) return true;
    const channel = channelOfRecording(path.resolve(absPath));
    return channel !== null && access.canSee(user, channel);
}

app.get('/api/files', async (req, res) => {
    // ParentDisk es ahora una ruta ABSOLUTA enviada desde el frontend
    const scanPath = req.query.disk;
    if (!scanPath) return res.json([]);
    if (!isAllowedMediaPath(scanPath)) return res.status(403).json({ error: 'Acceso denegado a esa ruta' });

    try {
        // Asíncrono: un USB lento no debe congelar el servidor
        const items = await fs.promises.readdir(scanPath, { withFileTypes: true }).catch(() => null);
        if (!items) return res.json([]);

        // Vídeos de la carpeta y de sus subcarpetas entrada_<n> (un nivel: cada entrada graba en la suya)
        const found = [];
        for (const item of items) {
            if (item.isFile()) found.push({ dir: scanPath, name: item.name });
            else if (item.isDirectory() && RECORDING_DIR.test(item.name)) {
                const dir = path.join(scanPath, item.name);
                const sub = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
                for (const f of sub) if (f.isFile()) found.push({ dir, name: f.name });
            }
        }

        const files = [];
        for (const { dir, name } of found) {
            if (!name.match(/\.(mp4|mkv|ts|flv)$/i)) continue;
            const absolutePath = path.join(dir, name);
            if (!canSeeRecording(req.user, absolutePath)) continue;
            const stat = await fs.promises.stat(absolutePath).catch(() => null);
            if (!stat) continue;
            files.push({
                name,
                size: stat.size,
                date: stat.mtime,
                // Devolvemos el absolutePath bruto, y usaremos una url especial para cargar videos absolutos
                url: `/api/media/play?path=${encodeURIComponent(absolutePath)}`,
                absolutePath: absolutePath
            });
        }
        res.json(files.sort((a,b) => b.date - a.date)); // Fechas más recientes primero
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Play endpoint para bypasear la restriccion del static de /media a carpetas absolutas del OS como /mnt/usb
app.get('/api/media/play', (req, res) => {
    const fpath = req.query.path;
    if (!isAllowedMediaPath(fpath)) return res.status(403).send('Forbidden area');
    // Grabación de una entrada ajena: como si no existiera
    if (!canSeeRecording(req.user, fpath) || !fs.existsSync(fpath)) return res.status(404).send('Not found');
    res.sendFile(path.resolve(fpath));
});

app.post('/api/files/delete', auth.requireAdmin, (req, res) => {
    const { filepath } = req.body;

    // filepath podria venir como /api/media/play?path=...
    let absolutePath = filepath;
    if(filepath && filepath.includes('?path=')) {
        absolutePath = decodeURIComponent(filepath.split('?path=')[1]);
    }

    // Evita Path Traversal para proteger sistema
    if (!isAllowedMediaPath(absolutePath)) {
        return res.status(403).json({ error: 'Acceso denegado a esa ruta' });
    }
    if (!fs.existsSync(absolutePath)) return res.status(400).json({ error: 'Ruta invalida o no existe' });

    fs.unlink(path.resolve(absolutePath), (e) => {
        if (e) return res.status(500).json({ error: e.message });
        res.json({ success: true });
    });
});

app.get('/api/ports', (req, res) => {
    db.get('SELECT * FROM ports LIMIT 1', [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row);
    });
});

app.put('/api/ports', auth.requireAdmin, (req, res) => {
    const { chanMin, chanMax, udpMin, udpMax, rtmpPort } = req.body;

    // Obtenemos el viejo rtmpPort para saber si hay que hacer regex replace en BBDD
    db.get('SELECT rtmpPort FROM ports LIMIT 1', [], (err, row) => {
        const oldRtmpPort = row ? row.rtmpPort : 1935;
        const newRtmpPort = rtmpPort || oldRtmpPort;

        db.run('UPDATE ports SET chanMin=?, chanMax=?, udpMin=?, udpMax=?, rtmpPort=?',
            [chanMin, chanMax, udpMin, udpMax, newRtmpPort], function(err) {

            if (err) return res.status(500).json({ error: err.message });

            // Si el puerto RTMP fue modificado, migramos las URLs!
            if (newRtmpPort != oldRtmpPort) {
                console.log(`[RTMP MIGRATOR] Migrando de ${oldRtmpPort} a ${newRtmpPort}...`);
                const oldHost = `rtmp://127.0.0.1:${oldRtmpPort}/`;
                const newHost = `rtmp://127.0.0.1:${newRtmpPort}/`;

                db.serialize(() => {
                    db.run(`UPDATE inputs SET url = REPLACE(url, ?, ?) WHERE url LIKE ?`, [oldHost, newHost, `${oldHost}%`]);
                    db.run(`UPDATE outputs SET url = REPLACE(url, ?, ?) WHERE url LIKE ?`, [oldHost, newHost, `${oldHost}%`]);

                    // Reiniciar el NodeMediaServer subyacente de forma caliente
                    rtmpServer.restartRtmpServer(newRtmpPort);

                    // Detener TODOS los streams activos usando el streamManager
                    db.all('SELECT * FROM inputs WHERE enabled = 1', [], (err, rows) => {
                        if (rows) rows.forEach(r => streamManager.stopInput(r.channel));

                        db.all('SELECT id FROM outputs WHERE enabled = 1', [], (err, outRows) => {
                            if (outRows) outRows.forEach(o => streamManager.stopOutput(o.id));

                            // Emitir alerta a todos los dashoards para auto-refresh forzado de urls
                            setTimeout(() => io.emit('db_update', { event: 'inputs_changed' }), 500);
                            setTimeout(() => io.emit('db_update', { event: 'outputs_changed' }), 500);

                            // Re-levantarlos limpios con las URLs ya migradas
                            setTimeout(bootActiveStreams, 2000);
                        });
                    });
                });
            }

            res.json({ updated: true });
        });
    });
});

/* =======================================
 *  BOOT SEQUENCE & WEBSOCKETS
 * ======================================= */

// Boot active streams based on DB state (Resume capability)
function bootActiveStreams() {
    console.log("[BOOT] Iniciando secuencia de encendido escalonado de Streams...");
    setTimeout(() => {
        db.all('SELECT * FROM inputs WHERE enabled = 1', [], (err, rows) => {
            if(rows && rows.length > 0) {
                let delayAccumulator = 0;

                // Stagger launches by 100ms each to avoid a spawn storm
                rows.forEach(r => {
                    setTimeout(() => streamManager.startInput(r), delayAccumulator);
                    delayAccumulator += 100;
                });

                // Outputs of enabled inputs. They wait for signal on their own, no ordering needed.
                db.all('SELECT o.* FROM outputs o JOIN inputs i ON o.channel = i.channel WHERE o.enabled = 1 AND i.enabled = 1', [], (err, outRows) => {
                    if(outRows && outRows.length > 0) {
                        outRows.forEach(o => {
                            setTimeout(() => streamManager.startOutput(o), delayAccumulator);
                            delayAccumulator += 100;
                        });
                    }
                });
            }
        });
    }, 1000);
}
bootActiveStreams();

io.on('connection', (socket) => {
    console.log(`Frontend Connected: ${socket.id}`);
    // Histórico completo una sola vez; después sólo se envía el punto nuevo en cada 'stats'
    // Cada evento inicial se filtra por usuario; si filterFor devuelve undefined, no se envía
    const initial = [
        ['telemetry_snapshot', streamManager.getTelemetry()],
        ['encoders_status', encoders.statusList()],
        ['rtmp_viewers', streamManager.rtmpViewers()]
    ];
    for (const [event, data] of initial) {
        const filtered = access.filterFor(socket.data.user, event, data);
        if (filtered !== undefined) socket.emit(event, filtered);
    }
});

// Un fallo puntual en una promesa no debe tumbar todos los streams
process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err));

// Apagado ordenado (systemd stop / docker stop): cierra grabaciones y no deja FFmpeg huérfanos
let shuttingDown = false;
function gracefulShutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${sig}] Deteniendo streams...`);
    encoders.shutdown();
    const why = sig === 'SIGTERM' ? 'se ha parado o reiniciado el servicio' : sig;
    Promise.all([telegram.shutdown(why), streamManager.shutdown()]).finally(() => {
        db.close(() => process.exit(0));
    });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start Server
const PORT = process.env.PORT || 4000;
telegram.init();
server.listen(PORT, () => {
    console.log(`TSST SERVER running on port ${PORT} (${tlsConfig.protocol.toUpperCase()})`);
});
