// Grabaciones en disco: cada entrada graba en su propia carpeta entrada_<n>, junto a la ruta elegida.
// Módulo puro (solo path): lo usan streamManager y las rutas de grabaciones.
const path = require('path');

const RECORDING_DIR = /^entrada_(\d+)$/;

// url: disk://<ruta>. Devuelve la ruta final con marca de fecha (evita sobrescribir), el formato
// de FFmpeg según la extensión y la carpeta de la entrada.
function recordingTarget(url, channel, now = new Date()) {
    const chosen = url.replace('disk://', '');
    const p2 = (n) => String(n).padStart(2, '0');
    const df = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}_${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;

    const lastSlash = Math.max(chosen.lastIndexOf('/'), chosen.lastIndexOf('\\'));
    const lastDot = chosen.lastIndexOf('.');
    let base, ext;
    if (lastDot > lastSlash) {
        base = chosen.substring(lastSlash + 1, lastDot);
        ext = chosen.substring(lastDot);
    } else {
        base = chosen.substring(lastSlash + 1);
        ext = '.mp4';
    }

    const dir = path.join(path.dirname(chosen), `entrada_${channel}`);
    const destUrl = path.join(dir, `${base}_${df}${ext}`);
    const lower = ext.toLowerCase();
    const format = lower === '.ts' ? 'mpegts' : lower === '.mkv' ? 'matroska' : 'mp4';
    return { destUrl, format, dir };
}

// Canal al que pertenece una grabación (carpeta padre entrada_<n>), o null si no está en una.
function channelOfRecording(filePath) {
    const m = path.basename(path.dirname(filePath)).match(RECORDING_DIR);
    return m ? m[1] : null;
}

module.exports = { recordingTarget, channelOfRecording, RECORDING_DIR };
