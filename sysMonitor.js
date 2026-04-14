const si = require('systeminformation');
const db = require('./db');

let ioInstance = null;

function setIo(io) {
    ioInstance = io;
    startMonitoring();
}

function startMonitoring() {
    setInterval(async () => {
        if (!ioInstance) return;

        try {
            const [cpu, mem, net] = await Promise.all([
                si.currentLoad(),
                si.mem(),
                si.networkStats('*') // Asterisco fuerza la lectura de TODAS las IPs y Tarjetas (Soluciona Windows bug)
            ]);

            // Filter network interfaces byte traffic
            let txSeq = 0, rxSeq = 0;
            if (net && net.length > 0) {
                net.forEach(iface => {
                    if (iface.operstate === 'up' || iface.tx_sec > 0 || iface.rx_sec > 0) {
                        txSeq += iface.tx_sec || 0;
                        rxSeq += iface.rx_sec || 0;
                    }
                });
            }

            // Count streams logically from DB
            db.all('SELECT enabled FROM inputs', [], (err, inps) => {
                db.all('SELECT enabled FROM outputs', [], (err, outs) => {
                    let streamsTotal = 0, streamsActive = 0, streamsError = 0;
                    if(inps) {
                        streamsTotal += inps.length;
                        inps.forEach(i => i.enabled ? streamsActive++ : streamsError++);
                    }
                    if(outs) {
                        streamsTotal += outs.length;
                        outs.forEach(i => i.enabled ? streamsActive++ : streamsError++);
                    }

                    const stats = {
                        cpuLoad: cpu.currentLoad.toFixed(1),
                        memUsed: (mem.active / (1024*1024*1024)).toFixed(2), // GB
                        memTotal: (mem.total / (1024*1024*1024)).toFixed(2), // GB
                        memPercent: ((mem.active / mem.total) * 100).toFixed(1),
                        netTx: (txSeq / (1024*1024)).toFixed(2), // MB/s
                        netRx: (rxSeq / (1024*1024)).toFixed(2), // MB/s
                        streamsTotal,
                        streamsActive,
                        streamsError
                    };

                    ioInstance.emit('sys_stats', stats);
                });
            });
        } catch (e) {
            console.error("System Polling Error", e);
        }
    }, 2500); // Pool every 2.5s for stability
}

module.exports = { setIo };
