const NodeMediaServer = require('node-media-server');
// node-media-server v4 guarda la config y las sesiones en un contexto global y no trae stop()
const Context = require('node-media-server/src/core/context.js');
const nmsLogger = require('node-media-server/src/core/logger.js');

let nms = null;

function startRtmpServer(port = 1935) {
    if (nms) {
        // Cambio de puerto: reutilizamos la instancia y sólo movemos el listener TCP
        stopListener();
        Context.config.rtmp.port = port;
        nms.rtmpServer.tcpServer.listen(port);
    } else {
        // v4 sólo usa bind y rtmp.port (chunk_size, gop_cache, ping... ya no existen).
        // Sin bloque http: no levantamos el servidor HTTP-FLV en el 8000, que no se usa.
        nms = new NodeMediaServer({ rtmp: { port } });
        nmsLogger.level = 'warn'; // El constructor lo pone en debug: un log por paquete de control
        nms.run();
    }
    console.log(`[RTMP] TSST Local Engine corriendo en puerto ${port}`);
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
