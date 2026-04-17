const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');

let ioInstance = null;
function setIo(io) { ioInstance = io; }

// In-memory store for active processes
const activeInputs = {};
const activeOutputs = {};
const telemetryCache = {};

// Locate FFmpeg binary (handles Windows local download vs Linux global)
function getFFmpegPath() {
    if (os.platform() === 'win32') {
        const binDir = path.join(__dirname, 'ffmpeg_bin');
        if (fs.existsSync(binDir)) {
            // Find inner folder (like ffmpeg-7.0.2-essentials_build)
            const subdirs = fs.readdirSync(binDir);
            for (let sub of subdirs) {
                const exePath = path.join(binDir, sub, 'bin', 'ffmpeg.exe');
                if (fs.existsSync(exePath)) return exePath;
            }
        }
    }
    return 'ffmpeg'; // Linux Docker fallback
}

/**
 * Start an Input Stream (Listener or Pull)
 * Receives external signal and pushes to Local UDP multiplexer.
 */
function startInput(inputObj) {
    const { channel, url, udpsrv, audiowtdg, wtdgsecs } = inputObj;
    if (activeInputs[channel]) {
        console.log(`Input ${channel} is already running.`);
        return;
    }

    const ffmpegCmd = getFFmpegPath();
    const localUdpOut = `udp://127.0.0.1:${udpsrv}?pkt_size=1316&buffer_size=8388608`;

    // Base args: Read from URL
    const args = [
        '-hide_banner',
        '-y',
        '-fflags', '+genpts',
        '-i', url
    ];

    // Main Output: copy codec, output to local MPEG-TS UDP
    args.push('-map', '0:v?');
    args.push('-map', '0:a?');
    args.push('-c:v', 'copy');
    args.push('-c:a', 'copy');
    if (url.startsWith('rtmp')) {
        args.push('-bsf:v', 'h264_mp4toannexb'); // Force bitstream conversion only for RTMP to avoid corrupting native SRT
    }
    args.push('-f', 'mpegts');
    args.push('-muxdelay', '0.1'); // Fix TS mux errors with missing audio/video sync
    args.push(localUdpOut);

    // Thumbnail Output: 1 frame every 5 secs, low perf impact
    const extPath = path.join(__dirname, 'public', 'thumbs', `thumb_${channel}.jpg`);
    args.push('-map', '0:v?');
    args.push('-r', '1/5');
    args.push('-update', '1');
    args.push('-q:v', '5');
    args.push('-f', 'image2');
    args.push(extPath);

    // Watchdog Output: decode audio, silence detect, drop to null sink
    if (audiowtdg === 1 && wtdgsecs > 0) {
        args.push('-map', '0:a?');
        args.push('-vn'); // no video
        args.push('-af', `silencedetect=noise=-50dB:d=${wtdgsecs}`);
        args.push('-f', 'null');
        args.push('-');
    }

    console.log(`[STARTING INPUT ${channel}] ${ffmpegCmd} ${args.join(' ')}`);
    const child = spawn(ffmpegCmd, args);

    child.on('error', (err) => {
        console.error(`[FATAL IN-${channel}] FFmpeg missing or crashed:`, err.message);
    });

    child.stderr.on('data', (data) => {
        const out = data.toString();
        
        // Match FFmpeg stats
        const bitrateMatch = out.match(/bitrate=\s*([\d.]+kbits\/s)/);
        const timeMatch = out.match(/time=([\d:.]+)/);
        
        if (bitrateMatch && ioInstance) {
            if (activeInputs[channel]) activeInputs[channel].lastUpdate = Date.now();
            
            if (!telemetryCache[channel]) telemetryCache[channel] = [];
            const brText = bitrateMatch[1];
            const br = parseFloat(brText); // ej. "4500.5kbits/s" -> 4500.5
            
            telemetryCache[channel].push({ t: new Date().toLocaleTimeString(), y: br || 0 });
            if (telemetryCache[channel].length > 60) telemetryCache[channel].shift(); // Keep last 60 points
            
            ioInstance.emit('stats', {
                channel: channel,
                bitrate: brText,
                time: timeMatch ? timeMatch[1] : '--:--:--',
                active: true,
                history: telemetryCache[channel] // Payload con curva precargada
            });
        }

        // audio watchdog alerts
        if (out.includes('silence_start')) {
            console.log(`[ALARM IN-${channel}] Audio Silence Detected!`);
            if (ioInstance) ioInstance.emit('watchdog_alert', { channel, status: 'silence' });
        }
        if (out.includes('silence_end')) {
            console.log(`[ALARM IN-${channel}] Audio Returned.`);
            if (ioInstance) ioInstance.emit('watchdog_alert', { channel, status: 'clear' });
        }
    });

    // Setup UDP Multiplexer in Node.js
    const router = dgram.createSocket('udp4');
    const sender = dgram.createSocket('udp4'); // DEDICATED TX SOCKET to prevent ICMP Error poisoning!
    router.subscribers = new Set();
    
    // Auto-tune sending buffer for the dedicated TX socket
    try { sender.setSendBufferSize(8388608); } catch(e){}

    // Recover existing active outputs if this is a restart
    for (const outId in activeOutputs) {
        if (activeOutputs[outId].parentChannel === channel) {
            router.subscribers.add(activeOutputs[outId].localPort);
            console.log(`[ROUTER] Re-linked orphan output ${outId} (port ${activeOutputs[outId].localPort}) to Input ${channel}`);
        }
    }
    
    // Bind to the udpsrv generated port to receive FFmpeg feed
    router.bind(udpsrv, '127.0.0.1', () => {
        try { router.setRecvBufferSize(8388608); } catch(e){} // 8MB buffer to prevent Node UDP packet drop
        console.log(`[ROUTER] Channel ${channel} bound on UDP ${udpsrv}`);
    });
    
    // Error boundary fatal para ENOBUFS en Raspberry
    router.on('error', (err) => {
        console.error(`[ROUTER ${channel}] UDP Socket Error (Kernel buffer full?):`, err.message);
    });

    // Multiplex payload to all subscribers using the isolated DEDICATED TX SOCKET
    // Highly optimized using empty fallback callback instead of try/catch to avoid V8 de-optimization
    const noop = () => {};
    router.on('message', (msg) => {
        for (const port of router.subscribers) {
            sender.send(msg, port, '127.0.0.1', noop);
        }
    });

    // Swallow async datagram errors
    router.on('error', (err) => {});
    sender.on('error', (err) => {
        // ICMP Port Unreachable errors land here cleanly, without poisoning the router RX loop!
    });
    
    let intentionalStop = false;
    child.markIntentionalStop = () => { intentionalStop = true; };

    child.on('close', (code) => {
        console.log(`Input ${channel} exited with code ${code}`);
        // Shutdown router safely
        try { router.close(); } catch (e) {}
        try { sender.close(); } catch (e) {}
        
        if (telemetryCache[channel]) delete telemetryCache[channel]; // Limpiar RAM historico
        
        // Remove thumbnail so UI flips to TV Bars
        const extPath = path.join(__dirname, 'public', 'thumbs', `thumb_${channel}.jpg`);
        fs.unlink(extPath, (err) => {});

        // Auto-Restart Logic (If not deliberately stopped by user)
        if (!intentionalStop) {
            console.log(`[IN-${channel}] Connection lost or crashed. Auto-restarting in 3s...`);
            // Turn yellow in UI (we fake an active signal with 0 bitrate)
            if (ioInstance) ioInstance.emit('stats', { channel: channel, active: true, bitrate: '0.0kbits/s', time: '--:--:--' });
            
            // Si nadie reemplazó manualmente el activeInputs, usamos un timeout para reconectar
            if (activeInputs[channel] && activeInputs[channel].process === child) {
                activeInputs[channel].autoRestart = setTimeout(() => {
                    delete activeInputs[channel];
                    startInput(inputObj);
                }, 3000);
            } else if (!activeInputs[channel]) {
                setTimeout(() => { startInput(inputObj); }, 3000);
            }
        } else {
            // Intentional stop
            if (ioInstance) ioInstance.emit('stats', { channel: channel, active: false });
        }
    });

    activeInputs[channel] = { process: child, router: router, lastUpdate: Date.now(), inputObj: inputObj, isStopping: false };
    return true;
}

/**
 * Stop an Input Stream
 */
function stopInput(channel) {
    if (activeInputs[channel]) {
        console.log(`[STOPPING INPUT ${channel}] Killing process and router...`);
        if (activeInputs[channel].autoRestart) clearTimeout(activeInputs[channel].autoRestart);
        
        if (activeInputs[channel].process) {
            if (typeof activeInputs[channel].process.markIntentionalStop === 'function') {
                activeInputs[channel].process.markIntentionalStop();
            }
            activeInputs[channel].process.kill('SIGKILL');
        }
        try { activeInputs[channel].router.close(); } catch(e){}
        
        delete activeInputs[channel];
        return true;
    }
    return false;
}

/**
 * Start an Output Stream
 * Pulls from the Local UDP multiplexer (udpsrv) and pushes to destination URL.
 */
function startOutput(outputObj) {
    const { id, channel, url } = outputObj; 
    if (activeOutputs[id]) {
        console.log(`Output ${id} is already running.`);
        return;
    }
    
    // Check if input stream is alive
    if (!activeInputs[channel]) {
        console.log(`Cannot start Output ${id}: Input ${channel} is offline.`);
        return; // Will stay disabled until input connects
    }

    // Generate unique local UDP port for this specific output receiver
    const localPort = 20000 + Math.floor(Math.random() * 30000); // 20000-50000 range
    
    // We assign child process FIRST so we can measure if it dies instantly
    let processStarted = false;

    const ffmpegCmd = getFFmpegPath();
    const localUdpIn = `udp://127.0.0.1:${localPort}?overrun_nonfatal=1`;

    const isRtmp = url.startsWith('rtmp');
    const isDisk = url.startsWith('disk://');
    let format = 'mpegts';
    let destUrl = url;
    
    if (isRtmp) format = 'flv';
    if (isDisk) {
        format = 'mp4';
        destUrl = url.replace('disk://', '');
    }

    const vcodec = outObj.vcodec || 'copy';

    const args = [
        '-hide_banner',
        '-y',
        '-i', localUdpIn
    ];
    
    if (vcodec === 'copy') {
        args.push('-c', 'copy');
    } else {
        args.push('-c:v', vcodec);
        args.push('-preset', 'ultrafast');
        args.push('-c:a', 'copy');
    }
    
    if (isDisk) {
        args.push('-movflags', '+frag_keyframe+empty_moov'); // Fragmented MP4 for live writing without RAM bloat
    }
    
    args.push('-f', format);
    args.push(destUrl);

    console.log(`[STARTING OUTPUT ${id}] ${ffmpegCmd} ${args.join(' ')}`);

    const child = spawn(ffmpegCmd, args);
    processStarted = true;
    
    // Subscribe this output ONLY IF ffmpeg survives the first 1.5 seconds.
    // If it dies early (e.g. bad remote RTMP) and we still subscribe, NodeJS floods a dead port causing Kernel ICMP Storms!
    setTimeout(() => {
        if (child.exitCode === null && activeInputs[channel] && activeInputs[channel].router) {
            activeInputs[channel].router.subscribers.add(localPort);
            console.log(`[OUT-${id}] Validated and successfully subscribed to local UDP ${localPort}`);
        }
    }, 1500);

    child.on('error', (err) => {
        console.error(`[FATAL OUT-${outId}] FFmpeg missing or crashed:`, err.message);
    });

    child.stderr.on('data', (data) => {
        console.log(`[OUT-${id}] ${data.toString().trim()}`);
    });

    let intentionalStop = false;
    child.markIntentionalStop = () => { intentionalStop = true; };

    child.on('close', (code) => {
        console.log(`Output ${id} exited with code ${code}`);
        // Remove subscriber port
        if (activeInputs[channel] && activeInputs[channel].router) {
            activeInputs[channel].router.subscribers.delete(localPort);
        }
        
        // Auto-Restart Logic
        if (!intentionalStop) {
            console.log(`[OUT-${id}] Connection lost or crashed. Auto-restarting target...`);
            if (activeOutputs[id] && activeOutputs[id].process === child) {
                activeOutputs[id].autoRestart = setTimeout(() => {
                    delete activeOutputs[id];
                    startOutput(outputObj);
                }, 3000);
            } else if (!activeOutputs[id]) {
                setTimeout(() => { startOutput(outputObj); }, 3000);
            }
        }
    });

    activeOutputs[id] = { process: child, localPort: localPort, parentChannel: channel, outputObj: outputObj };
    return true;
}

function stopOutput(id) {
    if (activeOutputs[id]) {
        console.log(`[STOPPING OUTPUT ${id}] Killing process...`);
        if (activeOutputs[id].autoRestart) clearTimeout(activeOutputs[id].autoRestart);
        
        const { process, localPort, parentChannel } = activeOutputs[id];
        
        if (process) {
            if (typeof process.markIntentionalStop === 'function') {
                process.markIntentionalStop();
            }
            process.kill('SIGKILL');
        }
        
        // Unsubscribe from router
        if (activeInputs[parentChannel] && activeInputs[parentChannel].router) {
            activeInputs[parentChannel].router.subscribers.delete(localPort);
        }
        delete activeOutputs[id];
        return true;
    }
    return false;
}

// Global Heartbeat Monitor: Detect frozen input streams and push zero telemetry
setInterval(() => {
    const now = Date.now();
    for (const channel in activeInputs) {
        const inp = activeInputs[channel];
        if (inp && inp.lastUpdate && (now - inp.lastUpdate > 2000)) {
            // Ha pasado más de 2 segundos sin respuesta de FFMPEG, registrar 0 de ancho de banda
            if (!telemetryCache[channel]) telemetryCache[channel] = [];
            telemetryCache[channel].push({ t: new Date().toLocaleTimeString(), y: 0 });
            if (telemetryCache[channel].length > 60) telemetryCache[channel].shift();
            
            if (ioInstance) {
                ioInstance.emit('stats', {
                    channel: channel,
                    bitrate: '0.0kbits/s',
                    time: '--:--:--', // Frozen time
                    active: true,
                    history: telemetryCache[channel]
                });
            }
            inp.lastUpdate = now; // Retrigger the heartbeat check window
        }
    }
}, 1000);

module.exports = {
    setIo,
    startInput,
    stopInput,
    startOutput,
    stopOutput
};
