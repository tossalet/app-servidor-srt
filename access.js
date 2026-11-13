/**
 * PERMISOS POR ENTRADA
 *
 * Envuelve AccessState (accessCore.js) con la base de datos, middlewares Express
 * y el reparto de eventos Socket.IO filtrado por usuario.
 * No importa auth.js (auth.js importará este módulo): el rol admin viene de accessCore.
 *
 * Los cambios escriben en SQLite y después recargan la caché (BD y caché coherentes).
 */
const db = require('./db');
const { AccessState } = require('./accessCore');

const state = new AccessState();
let io = null;

const dbAll = (sql, p = []) => new Promise((ok, ko) => db.all(sql, p, (e, r) => e ? ko(e) : ok(r)));
const dbRun = (sql, p = []) => new Promise((ok, ko) => db.run(sql, p, function (e) { e ? ko(e) : ok(this); }));

async function reload() {
    const [inputs, outputs, grants, encoders] = await Promise.all([
        dbAll('SELECT channel, owner FROM inputs'),
        dbAll('SELECT id, channel FROM outputs'),
        dbAll('SELECT username, channel FROM input_access'),
        dbAll('SELECT id, channel FROM encoders'),
    ]);
    state.reset({ inputs, outputs, grants, encoders });
}

async function init() {
    await db.ready;
    await reload();
}

const canSee = (user, channel) => state.canSee(user, channel);
const canSeeOutput = (user, id) => state.canSeeOutput(user, id);
const canSeeEncoder = (user, id) => state.canSeeEncoder(user, id);
const visibleChannels = (user) => state.visibleChannels(user);
const filterFor = (user, event, data) => state.filterFor(user, event, data);
const ownedBy = (username) => state.ownedBy(username);
const grantsOf = (username) => state.grantsOf(username);

/* =======================================
 *  MIDDLEWARES
 * ======================================= */
const notFound = (res) => res.status(404).json({ error: 'Not found' });

function requireChannel(param = 'channel') {
    return (req, res, next) => canSee(req.user, req.params[param]) ? next() : notFound(res);
}

function requireOutput(param = 'id') {
    return (req, res, next) => canSeeOutput(req.user, req.params[param]) ? next() : notFound(res);
}

/* =======================================
 *  SOCKET.IO
 * ======================================= */
function setIo(instance) {
    io = instance;
}

// Emite a cada socket sólo lo que su usuario puede ver
function broadcast(event, data) {
    if (!io) return;
    for (const socket of io.sockets.sockets.values()) {
        const payload = filterFor(socket.data && socket.data.user, event, data);
        if (payload !== undefined) socket.emit(event, payload);
    }
}

/* =======================================
 *  ESCRITURAS
 * ======================================= */
async function setOwner(channel, username) {
    await dbRun('UPDATE inputs SET owner = ? WHERE channel = ?', [username, channel]);
    await reload();
}

// Ejecuta fn dentro de una transacción; la caché se recarga pase lo que pase
async function inTransaction(fn) {
    try {
        await dbRun('BEGIN');
        try {
            await fn();
            await dbRun('COMMIT');
        } catch (e) {
            await dbRun('ROLLBACK').catch(() => {});
            throw e;
        }
    } finally {
        await reload();
    }
}

// Sustituye todas las asignaciones del usuario
async function setGrants(username, channels) {
    await inTransaction(async () => {
        await dbRun('DELETE FROM input_access WHERE username = ?', [username]);
        for (const ch of [...new Set(channels)]) {
            await dbRun('INSERT OR IGNORE INTO input_access (username, channel) VALUES (?, ?)', [username, ch]);
        }
    });
}

// Al borrar un usuario: sus asignaciones se eliminan y sus entradas pasan a heir
async function dropUser(username, heir) {
    await inTransaction(async () => {
        await dbRun('DELETE FROM input_access WHERE username = ?', [username]);
        await dbRun('UPDATE inputs SET owner = ? WHERE owner = ?', [heir, username]);
    });
}

// Al borrar una entrada: se eliminan las asignaciones de ese canal
async function forgetChannel(channel) {
    await dbRun('DELETE FROM input_access WHERE channel = ?', [channel]);
    await reload();
}

module.exports = {
    init, reload, setIo, broadcast,
    canSee, canSeeOutput, canSeeEncoder, visibleChannels, filterFor,
    requireChannel, requireOutput,
    setOwner, setGrants, dropUser, forgetChannel,
    ownedBy, grantsOf,
};
