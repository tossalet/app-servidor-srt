/**
 * PUERTOS OCUPADOS
 *
 * Dos entradas/salidas escuchando en el mismo puerto no pueden funcionar a la vez: la segunda no
 * llega a abrir el puerto y la señal "no entra" sin un error claro. SRT va sobre UDP, así que
 * un listener SRT y una entrada UDP en el mismo número también chocan.
 *
 * Se comprueba al guardar y al habilitar:
 *  - contra el resto de entradas y salidas de la base de datos (con su nombre), y
 *  - contra el sistema (otro programa, p. ej. WireGuard en 51820), intentando abrir el puerto.
 */
const dgram = require('dgram');
const db = require('./db');

const MULTICAST_RE = /^(22[4-9]|23\d)\./;

// Puerto UDP que esta máquina abre para esa URL, o null si no abre ninguno fijo.
// isInput: una URL udp:// de entrada escucha; de salida sólo envía.
function listenPort(url, isInput) {
    const m = String(url || '').match(/^(srt|udp):\/\/(\[[^\]]*\]|[^:/?]*):(\d+)([^?]*)(\?.*)?$/);
    if (!m) return null;
    const [, proto, host, port, , query] = m;
    const params = new URLSearchParams((query || '').slice(1));
    if (proto === 'srt') {
        const mode = params.get('mode') || 'caller';
        if (mode === 'listener' || mode === 'rendezvous') return parseInt(port, 10);
        // Un caller sólo ocupa un puerto fijo si se le pone localport
        const lp = parseInt(params.get('localport'), 10);
        return lp > 0 ? lp : null;
    }
    // UDP multicast: varios receptores pueden compartir puerto (reuse), no es conflicto
    if (!isInput || MULTICAST_RE.test(host.replace(/^@/, ''))) return null;
    return parseInt(port, 10);
}

const all = (sql) => new Promise((resolve, reject) => db.all(sql, [], (err, rows) => err ? reject(err) : resolve(rows)));

// Todo lo configurado que escucha en ese puerto, salvo el propio elemento (self = { kind, id })
async function usersOf(port, self) {
    const [inputs, outputs] = await Promise.all([
        all('SELECT channel, name, url, enabled FROM inputs'),
        all('SELECT o.id, o.url, o.location, o.enabled, i.name AS inputName FROM outputs o LEFT JOIN inputs i ON o.channel = i.channel')
    ]);
    const found = [];
    for (const r of inputs) {
        if (self && self.kind === 'input' && String(self.id) === String(r.channel)) continue;
        if (listenPort(r.url, true) === port) found.push({ enabled: !!r.enabled, label: `la entrada «${r.name || 'Entrada ' + r.channel}»` });
    }
    for (const r of outputs) {
        if (self && self.kind === 'output' && String(self.id) === String(r.id)) continue;
        if (listenPort(r.url, false) === port) {
            found.push({ enabled: !!r.enabled, label: `la salida ${r.location ? `«${r.location}» ` : ''}de «${r.inputName || 'entrada borrada'}»` });
        }
    }
    return found;
}

// ¿Lo tiene abierto otro programa? Se intenta abrir y se suelta enseguida.
function systemBusy(port) {
    return new Promise((resolve) => {
        const s = dgram.createSocket('udp4');
        s.once('error', (err) => { s.close(); resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES'); });
        s.bind(port, () => s.close(() => resolve(false)));
    });
}

/**
 * Comprueba si se puede usar el puerto de `url`.
 *  self:       { kind: 'input'|'output', id } al editar o habilitar; null al crear
 *  willEnable: el elemento va a quedar habilitado
 *  previousUrl: URL guardada antes de editar (si el puerto no cambia, el puerto ya es suyo)
 * Devuelve { error } si no se puede, { warning } si se puede pero conviene saberlo, o {}.
 */
async function check(url, { isInput, self = null, willEnable = true, previousUrl = null } = {}) {
    const port = listenPort(url, isInput);
    if (!port) return {};

    const users = await usersOf(port, self);
    const active = users.filter(u => u.enabled);
    if (willEnable && active.length) {
        return { error: `El puerto ${port} ya lo usa ${active[0].label}. Usa otro puerto o deshabilita esa primero.` };
    }

    // Un puerto ocupado fuera de la app sólo importa si el elemento va a arrancar,
    // y si es el mismo puerto que ya tenía, lo tiene abierto él mismo
    const samePort = previousUrl && listenPort(previousUrl, isInput) === port;
    if (willEnable && !samePort && await systemBusy(port)) {
        return { error: `El puerto ${port} lo está usando otro programa del servidor. Elige otro.` };
    }

    if (users.length) {
        return { warning: `Ojo: ${users[0].label} (deshabilitada) usa también el puerto ${port}. No podrán estar activas a la vez.` };
    }
    return {};
}

// Para el aviso en el formulario mientras se escribe: sólo la base de datos, sin abrir el puerto
async function describe(port, self) {
    const users = await usersOf(port, self);
    const active = users.find(u => u.enabled);
    if (active) return { error: `El puerto ${port} ya lo usa ${active.label}.` };
    if (users.length) return { warning: `${users[0].label[0].toUpperCase()}${users[0].label.slice(1)} (deshabilitada) usa también el puerto ${port}.` };
    return {};
}

module.exports = { listenPort, check, describe };
