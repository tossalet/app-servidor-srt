const NodeMediaServer = require('node-media-server');

const config = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  }
};

let nms;

function startRtmpServer() {
    nms = new NodeMediaServer(config);
    nms.run();
    console.log('[RTMP] TSST Local Engine corriendo en puerto 1935');
}

module.exports = {
    startRtmpServer
};
