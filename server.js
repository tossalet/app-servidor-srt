const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const auth = require('./auth');
const metrics = require('./metrics');
const streamManager = require('./streamManager');
const sysMonitor = require('./sysMonitor');
const rtmpServer = require('./rtmpServer');
const si = require('systeminformation');

const app = express();
const server = http.createServer(app);
// Sin CORS: el panel se sirve desde el mismo origen y la cookie de sesión es SameSite=Strict
const io = new Server(server);
io.use(auth.socketAuth);
auth.init().catch(err => console.error('[AUTH] Error inicializando usuarios', err));
streamManager.setIo(io);
sysMonitor.setIo(io);
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
// Miniaturas servidas desde RAM (tmpfs) y sin caché
app.use('/thumbs', express.static(streamManager.THUMBS_DIR, { maxAge: 0, etag: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(mediaRoot));

// Simple API status endpoint
app.get('/api/status', (req, res) => {
    // grafanaPort: el panel muestra el enlace "Gráficas" sólo si hay Grafana instalado
    res.json({ online: true, app: 'TSST SERVER', version: '1.0.0', grafanaPort: parseInt(process.env.GRAFANA_PORT, 10) || null });
});

const os = require('os');
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
app.get('/api/inputs', (req, res) => {
    db.all('SELECT * FROM inputs ORDER BY channel ASC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/inputs', (req, res) => {
    const { url, name, provider, location, remote, audiowtdg, wtdgsecs, enabled } = req.body;

    // Asignar Udpsrv respetando los límites de Firewall (Settings)
    db.get('SELECT udpMin, udpMax FROM ports LIMIT 1', [], (err, ports) => {
        let udpsrv = req.body.udpsrv;
        if (!udpsrv) {
            const min = ports ? ports.udpMin : 10000;
            const max = ports ? ports.udpMax : 30000;
            udpsrv = Math.floor(Math.random() * (max - min + 1)) + min;
        }

        const query = `INSERT INTO inputs (url, name, provider, location, remote, enabled, udpsrv, delay_ms)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        const params = [ url || '', name || 'Stream', provider || 'TodoStreaming', location || '', remote || '',
                         enabled !== false ? 1 : 0, udpsrv, parseInt(req.body.delay_ms, 10) || 0 ];

        db.run(query, params, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const channelId = this.lastID;
            res.status(201).json({ channel: channelId });
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
app.post('/api/inputs/:channel/toggle', (req, res) => {
    const channelId = req.params.channel;
    db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Not found' });
        const newEnabled = row.enabled ? 0 : 1;
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

app.post('/api/inputs/:channel/preview', (req, res) => {
    const channelId = req.params.channel;
    db.get('SELECT preview_enabled FROM inputs WHERE channel = ?', [channelId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Not found' });
        const newState = row.preview_enabled ? 0 : 1;
        db.run('UPDATE inputs SET preview_enabled = ? WHERE channel = ?', [newState, channelId], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            io.emit('db_update', { event: 'preview_changed', channel: channelId, preview_enabled: newState });

            // Start or stop the actual visual ffmpeg processor independently
            if (newState === 1) {
                streamManager.startPreview(channelId);
            } else {
                streamManager.stopPreview(channelId);
                // Extraer un fotograma congelado al pararlo
                setTimeout(() => streamManager.startPreview(channelId, true), 1000);
            }
            res.json({ preview_enabled: newState });
        });
    });
});

app.post('/api/inputs/:channel/snapshot', (req, res) => {
    const channelId = req.params.channel;
    streamManager.startPreview(channelId, true);
    res.json({ status: 'Snapshot requested' });
});

// Sincronización: retardo en vivo (ms) de un input. Se aplica sin reiniciar nada.
app.post('/api/inputs/:channel/delay', (req, res) => {
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

app.put('/api/inputs/:channel', (req, res) => {
    const channelId = req.params.channel;
    const { url, name } = req.body;
    const query = `UPDATE inputs SET url = ?, name = ? WHERE channel = ?`;

    db.run(query, [url, name, channelId], function(err) {
        if (err) return res.status(500).json({ error: err.message });

        // Restart the process if it was running with new data
        streamManager.stopInput(channelId);
        db.get('SELECT * FROM inputs WHERE channel = ?', [channelId], (err, row) => {
            if (row && row.enabled) streamManager.startInput(row);
            io.emit('db_update', { event: 'inputs_changed' });
            res.json({ updated: this.changes });
        });
    });
});

app.delete('/api/inputs/:channel', (req, res) => {
    const channelId = req.params.channel;
    streamManager.stopInput(channelId);

    db.run('DELETE FROM inputs WHERE channel = ?', [channelId], function(err) {
        if (err) return res.status(500).json({ error: err.message });

        // Stop related outputs
        db.all('SELECT id FROM outputs WHERE channel = ?', [channelId], (err, rows) => {
            if (rows) rows.forEach(r => streamManager.stopOutput(r.id));
            db.run('DELETE FROM outputs WHERE channel = ?', [channelId], () => {
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
        res.json(rows);
    });
});

app.post('/api/outputs', (req, res) => {
    const { channel, url, location, remote, enabled, vcodec } = req.body;
    if (!channel) return res.status(400).json({ error: "Input 'channel' is required" });

    // We need the udpsrv of the parent channel to link them
    db.get('SELECT udpsrv FROM inputs WHERE channel = ?', [channel], (err, parentRaw) => {
        if (err || !parentRaw) return res.status(400).json({ error: "Parent input not found" });

        const udpsrv = parentRaw.udpsrv;
        const query = `INSERT INTO outputs (channel, url, location, remote, enabled, udpsrv, vcodec)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`;
        const params = [ channel, url || '', location || '', remote || '', enabled !== false ? 1 : 0, udpsrv, vcodec || 'copy' ];

        db.run(query, params, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const outId = this.lastID;
            res.status(201).json({ id: outId });
            io.emit('db_update', { event: 'outputs_changed' });

            if (enabled !== false) {
                db.get('SELECT * FROM outputs WHERE id = ?', [outId], (err, row) => {
                    if (row) streamManager.startOutput(row);
                });
            }
        });
    });
});

app.post('/api/outputs/:id/toggle', (req, res) => {
    const id = req.params.id;
    db.get('SELECT * FROM outputs WHERE id = ?', [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Not found' });
        const newEnabled = row.enabled ? 0 : 1;
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

app.put('/api/outputs/:id', (req, res) => {
    const id = req.params.id;
    const { url, location, vcodec } = req.body;
    db.run(`UPDATE outputs SET url = ?, location = ?, vcodec = ? WHERE id = ?`, [url, location, vcodec || 'copy', id], function(err) {
        if (err) return res.status(500).json({ error: err.message });

        // Restart the process if it was running with new data
        streamManager.stopOutput(id);
        db.get('SELECT o.*, i.udpsrv FROM outputs o JOIN inputs i ON o.channel = i.channel WHERE o.id = ?', [id], (err, row) => {
            if (row && row.enabled) streamManager.startOutput(row);
            io.emit('db_update', { event: 'outputs_changed' });
            res.json({ updated: this.changes });
        });
    });
});

app.delete('/api/outputs/:id', (req, res) => {
    const id = req.params.id;
    streamManager.stopOutput(id);

    db.run('DELETE FROM outputs WHERE id = ?', [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deleted: this.changes });
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
                    path: f.mount
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
        }

        res.json(drives);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/files', async (req, res) => {
    // ParentDisk es ahora una ruta ABSOLUTA enviada desde el frontend
    const scanPath = req.query.disk;
    if (!scanPath) return res.json([]);

    try {
        // Asíncrono: un USB lento no debe congelar el servidor
        const items = await fs.promises.readdir(scanPath, { withFileTypes: true }).catch(() => null);
        if (!items) return res.json([]);
        const files = [];

        for (const item of items) {
            if (item.isFile() && item.name.match(/\.(mp4|mkv|ts|flv)$/i)) {
                const absolutePath = path.join(scanPath, item.name);
                const stat = await fs.promises.stat(absolutePath);
                files.push({
                    name: item.name,
                    size: stat.size,
                    date: stat.mtime,
                    // Devolvemos el absolutePath bruto, y usaremos una url especial para cargar videos absolutos
                    url: `/api/media/play?path=${encodeURIComponent(absolutePath)}`,
                    absolutePath: absolutePath
                });
            }
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
    if (!fs.existsSync(fpath)) return res.status(404).send('Not found');
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
    socket.emit('telemetry_snapshot', streamManager.getTelemetry());
});

// Un fallo puntual en una promesa no debe tumbar todos los streams
process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err));

// Apagado ordenado (systemd stop / docker stop): cierra grabaciones y no deja FFmpeg huérfanos
let shuttingDown = false;
function gracefulShutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${sig}] Deteniendo streams...`);
    streamManager.shutdown().finally(() => {
        db.close(() => process.exit(0));
    });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start Server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`TSST SERVER running on port ${PORT}`);
});
