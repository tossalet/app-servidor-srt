const NodeMediaServer = require('node-media-server');
// node-media-server v4 guarda la config y las sesiones en un contexto global y no trae stop()
const Context = require('node-media-server/src/core/context.js');
const nmsLogger = require('node-media-server/src/core/logger.js');

let nms = null;
let retryTimer = null;

function startRtmpServer(port = 1935) {
    if (nms) {
        // Cambio de puerto: reutilizamos la instancia y sólo movemos el listener TCP
        stopListener();
        clearTimeout(retryTimer);
        Context.config.rtmp.port = port;
        nms.rtmpServer.tcpServer.listen(port);
    } else {
        // v4 sólo usa bind y rtmp.port (chunk_size, gop_cache, ping... ya no existen).
        // Sin bloque http: no levantamos el servidor HTTP-FLV en el 8000, que no se usa.
        nms = new NodeMediaServer({ rtmp: { port } });
        nmsLogger.level = 'warn'; // El constructor lo pone en debug: un log por paquete de control
        // Puerto ocupado (otro servidor RTMP, una instancia anterior...): sin este manejador el
        // 'error' no capturado tumba todo el servidor, SRT incluido. Avisamos y reintentamos.
        nms.rtmpServer.tcpServer.on('error', (err) => {
            console.error(`[RTMP] No se puede escuchar en el puerto ${Context.config.rtmp.port}: ${err.code || err.message}. Reintento en 10 s; SRT y el panel siguen funcionando.`);
            clearTimeout(retryTimer);
            retryTimer = setTimeout(() => {
                try { nms.rtmpServer.tcpServer.listen(Context.config.rtmp.port); } catch (e) {}
            }, 10000);
        });
        // Sólo cuando escucha de verdad (también tras un reintento o un cambio de puerto)
        nms.rtmpServer.tcpServer.on('listening', () => {
            console.log(`[RTMP] TSST Local Engine corriendo en puerto ${Context.config.rtmp.port}`);
        });
        nms.run();
    }
}

function stopListener() {
    try { nms.rtmpServer.tcpServer.close(); } catch (e) {}
    // Cerrar las sesiones abiertas para que publicadores y lectores reconecten al puerto nuevo
    for (const session of Context.sessions.values()) {
        try { if (session.socket) session.socket.destroy(); } catch (e) {}
    }
}

function restartRtmpServer(newPort) {
    startRtmpServer(newPort);
}

module.exports = {
    startRtmpServer,
    restartRtmpServer
};
