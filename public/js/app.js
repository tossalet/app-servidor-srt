// Sesión: si el servidor responde 401 (o exige cambiar la contraseña) volvemos al login
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
    const res = await nativeFetch(...args);
    if (res.status === 401) {
        window.location.href = '/login.html';
    } else if (res.status === 403) {
        const body = await res.clone().json().catch(() => ({}));
        if (body.error === 'password_change_required') window.location.href = '/login.html';
    }
    return res;
};

const socket = io();
socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') window.location.href = '/login.html';
});
// El servidor cierra el socket si borran el usuario o cambian su contraseña
socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') fetch('/api/auth/me');
});

let currentUser = null;
const ROLE_ADMIN = 4;

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadSession() {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return;
    currentUser = await res.json();
    document.getElementById('session-user').innerText = currentUser.username;
    document.getElementById('session-role').innerText = currentUser.role === ROLE_ADMIN ? 'Administrador' : 'Operador';
    // Puertos y usuarios sólo para administradores (el servidor también lo exige)
    document.getElementById('nav-settings').style.display = currentUser.role === ROLE_ADMIN ? '' : 'none';

    // Enlace a Grafana (mismo host, su propio puerto) si está instalado
    const status = await fetch('/api/status').then(r => r.json()).catch(() => ({}));
    if (status.grafanaPort) {
        const link = document.getElementById('nav-grafana');
        link.href = `${window.location.protocol}//${window.location.hostname}:${status.grafanaPort}/d/tsst`;
        link.style.display = '';
    }
}

async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
}

async function submitOwnPassword(e) {
    e.preventDefault();
    const newPassword = document.getElementById('pwd_new').value;
    if (newPassword !== document.getElementById('pwd_repeat').value) {
        return alert('Las contraseñas nuevas no coinciden');
    }
    const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ currentPassword: document.getElementById('pwd_current').value, newPassword })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return alert(data.error || 'No se pudo cambiar la contraseña');
    document.getElementById('formPassword').reset();
    closeModal('passwordModal');
    alert('Contraseña actualizada. Las demás sesiones abiertas de tu usuario se han cerrado.');
}

// State
let inputs = [];
let outputs = [];
let telemetryChart = null;
let selectedAnalyticsChannels = new Set();
let frontendTelemetryCache = {};
let serverIp = window.location.hostname;
const chartColors = ['#60A5FA', '#34d399', '#f87171', '#fbbf24', '#c084fc', '#f472b6', '#38bdf8', '#a3e635'];

// Boot configuration
fetch('/api/ports').then(r=>r.json()).then(d=>{ window.currentRtmpPort = d.rtmpPort || 1935; }).catch(()=>{ window.currentRtmpPort = 1935; });

// SPA Navigation
let currentDashboardFilter = null;

function setDashboardFilter(filter) {
    currentDashboardFilter = filter;
    renderDashboardStreams();
}

function renderDashboardStreams() {
    const container = document.getElementById('dashboard-filter-results');
    if (!container) return;
    
    if (currentDashboardFilter === null) {
        container.innerHTML = '';
        return;
    }
    
    let html = '';
    
    // Evaluate inputs
    inputs.forEach(i => {
        // Obtenemos el último valor de bitrate de la telemetría (si existe) para saber si de verdad recibe señal
        const history = frontendTelemetryCache[i.channel.toString()];
        const lastBitrate = (history && history.length > 0) ? history[history.length - 1].y : 0;
        const isOnline = i.enabled && lastBitrate > 0;
        
        let statusClass = isOnline ? 'ok' : (i.enabled ? 'warning' : '');
        if (!i.enabled) statusClass = 'error';
        
        const isOfflineCategory = !isOnline; // Si está esperando señal o apagado, es offline/erróneo
        
        if (currentDashboardFilter === 'active' && !isOnline) return;
        if (currentDashboardFilter === 'offline' && !isOfflineCategory) return;
        
        html += `
            <div class="sys-stat-card ${statusClass}" style="padding:12px 15px; border-left: 4px solid ${isOnline ? 'var(--color-green)' : (i.enabled ? 'var(--color-yellow)' : 'var(--color-red)')};">
                <div style="font-size:0.7rem; opacity:0.7; font-family:monospace;">${i.url.split('://')[0].toUpperCase()}</div>
                <div style="font-size:1rem; font-weight:600; margin:5px 0;">${i.name}</div>
                <div style="font-size:1.1rem;">
                    <i class="fa-solid ${isOnline ? 'fa-circle-check' : (i.enabled ? 'fa-spinner fa-spin' : 'fa-circle-xmark')}"></i>
                </div>
            </div>
        `;
    });
    
    // Evaluate outputs
    outputs.forEach(o => {
        let isOnline = o.enabled; // Outputs son activos por el mero hecho de estar enabled
        let statusClass = isOnline ? 'ok' : 'error';
        
        if (currentDashboardFilter === 'active' && !isOnline) return;
        if (currentDashboardFilter === 'offline' && isOnline) return;
        
        html += `
            <div class="sys-stat-card ${statusClass}" style="padding:12px 15px; border-left: 4px solid ${isOnline ? 'var(--color-green)' : 'var(--color-red)'}; background:rgba(255,255,255,0.02);">
                <div style="font-size:0.7rem; opacity:0.7; font-family:monospace;">${o.url.split('://')[0].toUpperCase()}</div>
                <div style="font-size:0.85rem; font-weight:500; margin:5px 0; word-break:break-all;">${(o.location || o.url).substring(0, 45)}</div>
                <div style="font-size:1.1rem;">
                    <i class="fa-solid ${isOnline ? 'fa-satellite-dish' : 'fa-plug-circle-xmark'}"></i>
                </div>
            </div>
        `;
    });
    
    if (html === '') html = '<div style="color:var(--text-muted); padding:20px; text-align:center; width:100%;">No hay elementos en esta categoría.</div>';
    
    container.innerHTML = html;
}

function switchTab(tabId) {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('nav-' + tabId).classList.add('active');

    if (tabId === 'streams') {
        document.getElementById('streamsContainer').style.display = 'block';
        document.getElementById('analyticsContainer').style.display = 'none';
        document.getElementById('systemContainer').style.display = 'none';
        document.getElementById('settingsContainer').style.display = 'none';
        document.getElementById('storageContainer').style.display = 'none';
        document.getElementById('topbar-title').innerText = 'Streams Manager';
        document.getElementById('topbar-subtitle').innerText = 'Live endpoints control panel';
        document.getElementById('btn-add-input').style.display = 'inline-block';
    } else if (tabId === 'analytics') {
        document.getElementById('streamsContainer').style.display = 'none';
        document.getElementById('analyticsContainer').style.display = 'block';
        document.getElementById('systemContainer').style.display = 'none';
        document.getElementById('settingsContainer').style.display = 'none';
        document.getElementById('storageContainer').style.display = 'none';
        document.getElementById('topbar-title').innerText = 'Analytics & Telemetry';
        document.getElementById('topbar-subtitle').innerText = 'Deep network inspection tools';
        document.getElementById('btn-add-input').style.display = 'none';
        
        populateAnalyticsGrid();
    } else if (tabId === 'system') {
        document.getElementById('streamsContainer').style.display = 'none';
        document.getElementById('analyticsContainer').style.display = 'none';
        document.getElementById('systemContainer').style.display = 'block';
        document.getElementById('settingsContainer').style.display = 'none';
        document.getElementById('storageContainer').style.display = 'none';
        document.getElementById('topbar-title').innerText = 'System Dashboard';
        document.getElementById('topbar-subtitle').innerText = 'Host hardware & overview';
        document.getElementById('btn-add-input').style.display = 'none';
    } else if (tabId === 'settings') {
        document.getElementById('streamsContainer').style.display = 'none';
        document.getElementById('analyticsContainer').style.display = 'none';
        document.getElementById('systemContainer').style.display = 'none';
        document.getElementById('settingsContainer').style.display = 'block';
        document.getElementById('storageContainer').style.display = 'none';
        document.getElementById('topbar-title').innerText = 'Settings / Setup';
        document.getElementById('topbar-subtitle').innerText = 'Access control & Configuration';
        document.getElementById('btn-add-input').style.display = 'none';
        
        fetchSettingsData();
    } else if (tabId === 'storage') {
        document.getElementById('streamsContainer').style.display = 'none';
        document.getElementById('analyticsContainer').style.display = 'none';
        document.getElementById('systemContainer').style.display = 'none';
        document.getElementById('settingsContainer').style.display = 'none';
        document.getElementById('storageContainer').style.display = 'block';
        document.getElementById('topbar-title').innerText = 'Media Storage';
        document.getElementById('topbar-subtitle').innerText = 'Local recordings & file manager';
        document.getElementById('btn-add-input').style.display = 'none';
        
        fetchStorage();
    }
}

function initChart() {
    const ctx = document.getElementById('bitrateChart').getContext('2d');
    telemetryChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: []
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: { 
                legend: { 
                    display: true, 
                    labels: { color: 'rgba(255,255,255,0.7)', font: { family: 'Inter', size: 11 } }
                },
                tooltip: { backgroundColor: 'rgba(0,0,0,0.8)' }
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(255,255,255,0.4)', maxTicksLimit: 10 } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(255,255,255,0.4)' }, min: 0 }
            }
        }
    });
}

function populateAnalyticsGrid() {
    const grid = document.getElementById('analytics_grid');
    grid.innerHTML = '';
    let hasStreams = false;
    
    inputs.forEach(i => {
        if (i.enabled) {
            hasStreams = true;
            grid.innerHTML += `
                <div class="analytics-card ${selectedAnalyticsChannels.has(i.channel.toString()) ? 'selected' : ''}" onclick="toggleAnalyticsChannel('${i.channel}')">
                    <div class="acard-title">${i.name}</div>
                    <div class="acard-badge">IN_${i.channel}</div>
                </div>
            `;
            
            // Render corresponding Output cards right next to their Input
            const inputOutputs = outputs.filter(o => o.channel === i.channel && o.enabled);
            inputOutputs.forEach(o => {
                const outId = 'out_' + o.id;
                const locName = o.location ? o.location : o.url;
                grid.innerHTML += `
                    <div class="analytics-card ${selectedAnalyticsChannels.has(outId) ? 'selected' : ''}" onclick="toggleAnalyticsChannel('${outId}')" style="margin-left: 20px; border-left: 3px solid rgba(255,255,255,0.2);">
                        <div class="acard-title" style="font-size:0.8rem; opacity:0.8;">${locName.substring(0,30)}</div>
                        <div class="acard-badge" style="background: rgba(255,255,255,0.1);">OUT_${o.id}</div>
                    </div>
                `;
            });
        }
    });
    
    if(!hasStreams) {
        grid.innerHTML = '<div style="color:var(--text-muted); font-size:0.9rem;">-- No Active Streams --</div>';
    }
}

function updateTelemetryChart() {
    if (!telemetryChart) return;
    
    let allTimesSet = new Set();
    const activeChannels = Array.from(selectedAnalyticsChannels);
    
    // Recopilar la base de tiempo común de los canales seleccionados
    activeChannels.forEach(ch => {
        if(frontendTelemetryCache[ch]) {
            frontendTelemetryCache[ch].forEach(dp => allTimesSet.add(dp.t));
        }
    });
    
    const sortedTimes = Array.from(allTimesSet).sort();
    telemetryChart.data.labels = sortedTimes;
    
    // Reconstruir datasets superpuestos
    telemetryChart.data.datasets = activeChannels.map((ch, index) => {
        const color = chartColors[index % chartColors.length];
        
        let labelName = `Channel ${ch}`;
        if (ch.toString().startsWith('out_')) {
            const numId = parseInt(ch.toString().replace('out_', ''));
            const outInfo = outputs.find(o => o.id === numId);
            if (outInfo) labelName = `OUT_${numId} (${(outInfo.location || outInfo.url).substring(0, 20)})`;
        } else {
            const inpInfo = inputs.find(i => i.channel.toString() === ch.toString());
            if (inpInfo) labelName = `IN_${ch} (${inpInfo.name})`;
        }
        
        // Mapear datos a la base de tiempo unificada (0 si no existe para ese tick)
        const dataMap = new Map();
        if(frontendTelemetryCache[ch]) {
            frontendTelemetryCache[ch].forEach(dp => dataMap.set(dp.t, dp.y));
        }
        
        const mappedData = sortedTimes.map(t => dataMap.has(t) ? dataMap.get(t) : null);

        return {
            label: labelName,
            data: mappedData,
            borderColor: color,
            backgroundColor: color.replace(')', ', 0.1)').replace('rgb', 'rgba'),
            borderWidth: 2,
            tension: 0.4,
            fill: false, // Superimposed graphs shouldn't be fully solid filled to avoid hiding each other
            pointRadius: 0
        };
    });
    
    telemetryChart.update();
}

function toggleAnalyticsChannel(channelId) {
    const chStr = channelId.toString();
    if (selectedAnalyticsChannels.has(chStr)) {
        selectedAnalyticsChannels.delete(chStr);
    } else {
        selectedAnalyticsChannels.add(chStr);
    }
    populateAnalyticsGrid(); // Refresca las clases "selected"
    updateTelemetryChart();
}

document.addEventListener('DOMContentLoaded', () => {
    loadSession();
    switchTab('system'); // Iniciar en el Dashboard
    fetchData();
    initChart();

    // Socket listeners
    socket.on('db_update', (data) => {
        console.log("DB Update:", data.event);

        // Cambio de sincronía: sólo actualizamos la etiqueta, sin re-renderizar (se arrastra el slider en vivo)
        if (data.event === 'delay_changed') {
            const inp = inputs.find(i => i.channel == data.channel);
            if (inp) inp.delay_ms = data.delay_ms;
            const el = document.getElementById(`delay-${data.channel}`);
            if (el) el.innerText = `${data.delay_ms} ms`;
            return;
        }

        // Optimización brutal: Si solo ha cambiado la previsualización, modificamos el DOM directamente
        // Así evitamos destruir el HTML de las las otras cámaras y perder sus estados (ej. barras vs imagen)
        if (data.event === 'preview_changed') {
            const inp = inputs.find(i => i.channel == data.channel);
            if (inp) inp.preview_enabled = data.preview_enabled;
            syncThumbPlayers();

            const img = document.getElementById(`thumb-img-${data.channel}`);
            if (img) {
                if (data.preview_enabled && inp.enabled) {
                    img.classList.add('preview-active');
                    if (img.classList.contains('has-signal')) {
                        img.style.filter = 'none'; // Restaurar color
                    }
                } else {
                    img.classList.remove('preview-active');
                    if (img.src.includes('thumb_')) {
                        img.style.filter = 'grayscale(100%) opacity(40%) blur(1px)';
                    }
                }
                
                // Buscar el botón justo al lado y actualizar su icono
                const btn = img.nextElementSibling;
                if (btn && btn.tagName === 'BUTTON') {
                    btn.style.color = data.preview_enabled ? 'var(--color-green)' : '#fff';
                    btn.title = data.preview_enabled ? 'Desactivar Previsualización (Ahorro CPU)' : 'Activar Previsualización';
                    btn.innerHTML = `<i class="fa-solid ${data.preview_enabled ? 'fa-eye' : 'fa-eye-slash'}"></i>`;
                }
            }
            return; // Salir! No hacemos fetchData ni repintamos todo el DOM.
        }
        if (data.event === 'input_toggled') {
            const inp = inputs.find(i => i.channel == data.channel);
            if (inp) inp.enabled = data.enabled;
            
            // LED
            const led = document.getElementById(`led-${data.channel}`);
            if (led) {
                led.className = `connection-led ${data.enabled ? 'active yellow' : 'error'} tooltip`;
                const tt = led.querySelector('.tooltiptext');
                if (tt) tt.innerText = data.enabled ? 'Enabled' : 'Disabled';
            }
            // Toggle Icon
            const btn = document.querySelector(`#input-card-${data.channel} .toggle-enabled i`);
            if (btn) btn.className = `fa-solid ${data.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}`;
            // Quality Bar
            const qbar = document.getElementById(`qbar-${data.channel}`);
            if (qbar) {
                qbar.className = `fill ${data.enabled ? 'yellow' : 'red'}`;
                qbar.style.width = data.enabled ? '100%' : '0%';
            }
            // Si lo deshabilitamos (OFF), la imagen pasa forzosamente a barras
            if (!data.enabled) {
                const img = document.getElementById(`thumb-img-${data.channel}`);
                if (img) {
                    img.src = '/images/bars.svg';
                    img.style.filter = 'none';
                    img.classList.remove('has-signal');
                }
            }
            syncThumbPlayers();
            if (currentDashboardFilter !== null) renderDashboardStreams();
            return;
        }
        if (data.event === 'output_toggled') {
            const out = outputs.find(o => o.id == data.id);
            if (out) out.enabled = data.enabled;
            // LED
            const led = document.getElementById(`led-out_${data.id}`);
            if (led) {
                led.className = `connection-led ${data.enabled ? 'active yellow' : 'error'} tooltip`;
                const tt = led.querySelector('.tooltiptext');
                if (tt) tt.innerText = data.enabled ? 'Enabled' : 'Disabled';
            }
            // Toggle Icon
            const btn = document.querySelector(`#outputs-container-${out ? out.channel : ''} button[onclick="toggleOutput(${data.id})"] i`);
            if (btn) btn.className = `fa-solid ${data.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}`;
            
            if (currentDashboardFilter !== null) renderDashboardStreams();
            return;
        }
        
        fetchData();
    });

    socket.on('telemetry_snapshot', (snapshot) => {
        frontendTelemetryCache = snapshot || {};
        updateTelemetryChart();
    });

    socket.on('stats', (data) => {
        const bitElem = document.getElementById(`bitrate-${data.channel}`);
        const timeElem = document.getElementById(`time-${data.channel}`);
        const ledElem = document.getElementById(`led-${data.channel}`);

        if (bitElem && timeElem && ledElem) {
            if (data.active) {
                bitElem.innerText = data.bitrate.replace('bits/s', 'ps');
                timeElem.innerText = data.time;
                
                const bitVal = parseFloat(data.bitrate);
                if (bitVal > 0) {
                    ledElem.className = 'connection-led active tooltip'; // green (receiving data)
                } else {
                    ledElem.className = 'connection-led active yellow tooltip'; // yellow (waiting for data)
                }
            } else {
                bitElem.innerText = '--:-- Mbps';
                timeElem.innerText = '--:--:--';
                ledElem.className = 'connection-led error tooltip'; // red
            }
        }
        
        // Auto-cambio de Barras vs Imagen según Señal Real (Bitrate > 0)
        const imgElem = document.getElementById(`thumb-img-${data.channel}`);
        if (imgElem) {
            const bitVal = data.active && data.bitrate ? parseFloat(data.bitrate) : 0;
            const isPreviewLive = imgElem.classList.contains('preview-active');
            
            if (bitVal > 0) {
                // Hay señal
                if (!imgElem.classList.contains('has-signal')) {
                    imgElem.classList.add('has-signal');
                    imgElem.style.filter = isPreviewLive ? 'none' : 'grayscale(100%) opacity(40%) blur(1px)';
                    // La miniatura JPEG es siempre un fotograma fijo; en vivo la tapa el vídeo HLS
                    fetch(`/api/inputs/${data.channel}/snapshot`, { method: 'POST' }).catch(e => console.error(e));
                }

                if (!imgElem.src.includes('thumb_')) {
                    // Restaurar foto estática single-frame a prueba de fallos y sin parpadeos
                    const temp = new Image();
                    temp.onload = () => { imgElem.src = temp.src; };
                    temp.src = `/thumbs/thumb_${data.channel}.jpg?t=${Math.floor(Date.now()/5000)}`;
                }
            } else {
                // No hay señal real
                if (imgElem.classList.contains('has-signal')) imgElem.classList.remove('has-signal');
                // Nos aseguramos de mantener las barras
                if (!imgElem.src.includes('bars.svg')) {
                    imgElem.src = '/images/bars.svg';
                    imgElem.style.filter = 'none';
                }
            }
        }
        
        if (data.codec) {
            const codecElem = document.getElementById(`codec-${data.channel}`);
            if (codecElem && data.codec.length > 0) codecElem.innerText = data.codec;
        }

        if ('srt' in data) renderSrtStats(String(data.channel), data.srt);

        if (data.delay !== undefined) {
            const delayElem = document.getElementById(`delay-${data.channel}`);
            if (delayElem) delayElem.innerText = `${data.delay} ms`;
        }

        // Backend sends only the new point; full history arrives once in 'telemetry_snapshot'
        if (data.point) {
            const key = data.channel.toString();
            const hist = frontendTelemetryCache[key] || (frontendTelemetryCache[key] = []);
            hist.push(data.point);
            if (hist.length > 60) hist.shift();
            if (selectedAnalyticsChannels.has(key)) {
                updateTelemetryChart();
            }
        }
        // Render streams list locally on dash
        renderDashboardStreams();
    });

    socket.on('audio_levels', renderAudioLevels);

    socket.on('sys_stats', (stats) => {
        // CPU
        const cpuLabel = document.getElementById('sys_cpu');
        const cpuBar = document.getElementById('sys_cpu_bar');
        if (cpuLabel) {
            cpuLabel.innerText = stats.cpuLoad;
            cpuBar.style.width = stats.cpuLoad + '%';
            cpuBar.style.background = stats.cpuLoad > 85 ? 'var(--color-red)' : 'var(--accent-blue)';
        }
        
        // RAM
        const ramLabel = document.getElementById('sys_ram');
        const ramTotalLabel = document.getElementById('sys_ram_total');
        const ramBar = document.getElementById('sys_ram_bar');
        if (ramLabel) {
            ramLabel.innerText = stats.memUsed;
            ramTotalLabel.innerText = stats.memTotal;
            ramBar.style.width = stats.memPercent + '%';
            ramBar.style.background = stats.memPercent > 85 ? 'var(--color-red)' : 'var(--color-green)';
        }

        // Net
        const txLabel = document.getElementById('sys_tx');
        const rxLabel = document.getElementById('sys_rx');
        if(txLabel) {
            txLabel.innerText = stats.netTx;
            rxLabel.innerText = stats.netRx;
        }

        // Logical Streams overview
        const tTotal = document.getElementById('sys_routes_total');
        const tOk = document.getElementById('sys_routes_ok');
        const tErr = document.getElementById('sys_routes_err');
        if(tTotal) {
            tTotal.innerText = stats.streamsTotal;
            tOk.innerText = stats.streamsActive;
            tErr.innerText = stats.streamsError;
        }
    });

    // Thumbnail auto-refresh
    setInterval(() => {
        const thumbs = document.querySelectorAll('.thumb-container img');
        thumbs.forEach(img => {
            const baseSrc = img.dataset.src;
            if (baseSrc && img.classList.contains('preview-active')) {
                const tempImg = new Image();
                tempImg.onload = () => { img.src = tempImg.src; };
                tempImg.onerror = () => { img.src = '/images/bars.svg'; };
                tempImg.src = `${baseSrc}?t=${Date.now()}`;
            }
        });
    }, 5000); // refresh every 5s corresponding to ffmpeg capture rate
});

async function fetchData() {
    try {
        const resIp = await fetch('/api/server-ip').catch(() => null);
        if (resIp && resIp.ok) {
            const dataIp = await resIp.json();
            serverIp = dataIp.ip;
        }

        const [resIn, resOut] = await Promise.all([
            fetch('/api/inputs', { cache: 'no-store' }),
            fetch('/api/outputs', { cache: 'no-store' })
        ]);
        inputs = await resIn.json();
        outputs = await resOut.json();
        
        renderStreams();
    } catch (e) {
        console.error("Error fetching data:", e);
    }
}

function renderStreams() {
    // Preserve UI State
    const expandedIds = new Set();
    document.querySelectorAll('.stream-card.expand-mode').forEach(c => expandedIds.add(c.id));

    const container = document.getElementById('streamsContainer');
    container.innerHTML = '';
    
    const serverIp = window.location.hostname;

    inputs.forEach(input => {
        const inputOutputs = outputs.filter(o => o.channel === input.channel);
        
        let protocolBadge = 'srt';
        let protocolText = 'SRT-L';
        if (input.url.startsWith('udp')) { protocolBadge = 'udp'; protocolText = 'UDP'; }
        else if (input.url.startsWith('rtmp://127.0.0.1')) { protocolBadge = 'rtmp'; protocolText = 'RTMP LOC'; }
        else if (input.url.startsWith('rtmp')) { protocolBadge = 'rtmp'; protocolText = 'RTMP REM'; }

        let latencyText = 'Auto';
        const latencyMatch = input.url.match(/latency=(\d+)/);
        if (latencyMatch) latencyText = latencyMatch[1] + ' ms';

        const isExpandedClass = expandedIds.has(`input-card-${input.channel}`) ? 'expand-mode' : '';

        const inputHTML = `
            <div class="stream-card ${isExpandedClass}" id="input-card-${input.channel}">
                <div class="stream-header">
                    <div class="left-section">
                        <button class="btn-expand" onclick="toggleExpand(${input.channel})"><i class="fa-solid fa-chevron-down"></i></button>
                        <div id="led-${input.channel}" class="connection-led ${input.enabled ? 'active yellow' : 'error'} tooltip">
                            <i class="fa-solid fa-lightbulb"></i>
                            <span class="tooltiptext">${input.enabled ? 'Enabled' : 'Disabled'}</span>
                        </div>
                        <div class="badge-protocol ${protocolBadge}">${protocolText}</div>
                        <span id="codec-${input.channel}" class="badge-protocol udp" style="background:#4b5563;">H.26X</span>
                        <span class="stream-name" style="display:flex; flex-direction:column; line-height:1.2;">
                            ${input.name || 'Channel ' + input.channel}
                            <span style="font-size:0.70rem; color:var(--accent-blue); font-family:monospace; font-weight:normal; user-select:all;">${maskUrl(input.url).replace(/127\.0\.0\.1|0\.0\.0\.0/g, serverIp)}</span>
                        </span>
                    </div>
                    <div class="mid-section">
                        <div class="stat-item ${!input.enabled ? 'disabled' : ''}">
                            <i class="fa-solid fa-clock"></i> <span id="time-${input.channel}">--:--:--</span>
                        </div>
                        <div class="stat-item ${!input.enabled ? 'disabled' : ''}">
                            <i class="fa-solid fa-gauge-high"></i> <span class="monospaced" id="bitrate-${input.channel}">-- Mbps</span>
                        </div>
                        <div class="quality-bar">
                            <div class="fill ${input.enabled ? 'yellow' : 'red'}" id="qbar-${input.channel}" style="width: ${input.enabled ? '100%' : '0%'}"></div>
                        </div>
                    </div>
                    <div class="right-section">
                        <div class="control-actions">
                            <button class="action-btn toggle-enabled tooltip" onclick="toggleInput(${input.channel})">
                                <i class="fa-solid ${input.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                                <span class="tooltiptext">Toggle Input</span>
                            </button>
                            <button class="action-btn edit-btn" onclick="openEditInput(${input.channel})"><i class="fa-solid fa-pen"></i></button>
                            <button class="action-btn delete-btn" onclick="deleteInput(${input.channel})"><i class="fa-solid fa-trash"></i></button>
                            <button class="btn-secondary add-output" onclick="openOutputModal(${input.channel})"><i class="fa-solid fa-arrow-right-to-bracket"></i> Add Output</button>
                        </div>
                    </div>
                </div>
                
                <div class="stream-outputs" id="outputs-container-${input.channel}">
                    <div class="thumb-container" style="padding: 1rem 1.5rem; background: rgba(0,0,0,0.3); border-bottom: 1px solid rgba(255,255,255,0.05); display: flex; gap: 20px; align-items: center;">
                        <div class="thumb-box" id="thumb-box-${input.channel}" style="position:relative; width:160px; height:90px; border-radius:6px; overflow:hidden; border:1px solid rgba(255,255,255,0.1); box-shadow: 0 4px 10px rgba(0,0,0,0.5);">
                            <img id="thumb-img-${input.channel}" class="${input.preview_enabled && input.enabled ? 'preview-active' : ''}" data-src="/thumbs/thumb_${input.channel}.jpg" src="${input.enabled ? '/thumbs/thumb_' + input.channel + '.jpg' + (input.preview_enabled ? '?t=' + Date.now() : '') : '/images/bars.svg'}" onerror="if(!this.src.includes('bars.svg')){this.src='/images/bars.svg';}" onclick="openLive(${input.channel})" title="Ver en directo" style="cursor:${input.enabled ? 'pointer' : 'default'}; width:100%; height:100%; object-fit:cover; filter: ${input.preview_enabled && input.enabled ? 'none' : 'grayscale(100%) opacity(40%) blur(1px)'}; transition: filter 0.3s;" />
                            <button onclick="togglePreview(${input.channel})" class="action-btn thumb-eye" style="color:${input.preview_enabled ? 'var(--color-green)' : '#fff'};" title="${input.preview_enabled ? 'Desactivar Previsualización (Ahorro CPU)' : 'Activar Previsualización'}">
                                <i class="fa-solid ${input.preview_enabled ? 'fa-eye' : 'fa-eye-slash'}"></i>
                            </button>
                            <span class="vu-warn" id="vu-warn-${input.channel}">Sin audio</span>
                        </div>
                        <div class="vu-block">
                            <div class="vu-meter" title="Nivel de audio (L/R)">
                                <div class="vu-col"><div class="vu-mask" id="vu-${input.channel}-0"></div><div class="vu-peak" id="vu-${input.channel}-0p"></div></div>
                                <div class="vu-col"><div class="vu-mask" id="vu-${input.channel}-1"></div><div class="vu-peak" id="vu-${input.channel}-1p"></div></div>
                            </div>
                            <button class="action-btn listen-btn ${listeningChannel === String(input.channel) ? 'on' : ''}" id="listen-${input.channel}" onclick="toggleListen(${input.channel})" title="Escuchar esta entrada" ${input.enabled ? '' : 'disabled'}>
                                <i class="fa-solid ${listeningChannel === String(input.channel) ? 'fa-volume-high' : 'fa-volume-xmark'}"></i>
                            </button>
                        </div>
                        <div style="font-size:0.85rem; color:var(--text-muted); line-height: 1.4; display:flex; flex-direction:column; gap:5px;">
                            <p><strong>Parámetros de Recepción:</strong></p>
                            <div style="display:flex; align-items:center; gap: 10px;">
                                <span class="badge-protocol ${protocolBadge === 'srt' ? 'udp' : 'rtmp'}">${protocolBadge === 'srt' ? 'Buffer SRT' : 'Buffer N/A'}</span>
                                <span style="color:#fff; font-weight:600;">${latencyText}</span>
                                ${protocolBadge === 'srt' ? `<button onclick="editLatency('${input.channel}')" style="background:transparent; border:none; color:var(--accent-blue); cursor:pointer; font-size:0.9rem;" title="Editar Latencia del Stream"><i class="fa-solid fa-pen"></i></button>` : ''}
                                ${srtCipherBadge(input.url)}
                            </div>
                            <p style="font-size: 0.75rem; margin-top: 2px; opacity:0.7;">Optimiza este valor según el retardo de la red (${protocolBadge === 'srt' ? 'Haivision recomienda 3-4 × RTT' : 'Sólo configurable en SRT'}).</p>
                            <div id="srtstats-${input.channel}" style="font-size:0.75rem;"></div>
                            <div style="display:flex; align-items:center; gap: 10px; margin-top:4px;">
                                <span class="badge-protocol udp">Sincronía</span>
                                <span style="color:#fff; font-weight:600;" id="delay-${input.channel}">${input.delay_ms || 0} ms</span>
                                <button onclick="openSyncModal(${input.channel})" style="background:transparent; border:none; color:var(--accent-blue); cursor:pointer; font-size:0.9rem;" title="Retardo para alinear esta señal con las demás"><i class="fa-solid fa-sliders"></i></button>
                            </div>
                        </div>
                    </div>
                    ${inputOutputs.map(out => `
                        <div class="output-row">
                            <div class="left-section sub">
                                <div id="led-out_${out.id}" class="connection-led ${out.enabled ? 'active yellow' : 'error'} tooltip" style="margin-right: -5px;">
                                    <i class="fa-solid fa-lightbulb"></i>
                                    <span class="tooltiptext">${out.enabled ? 'Enabled' : 'Disabled'}</span>
                                </div>
                                <span class="stream-name" style="display:flex; flex-direction:column; line-height:1.2;">
                                    ${out.location || maskUrl(out.url)}
                                    <span style="font-size:0.70rem; color:var(--text-muted); font-family:monospace; font-weight:normal; user-select:all;">${maskUrl(out.url).replace(/127\.0\.0\.1|0\.0\.0\.0/g, serverIp)}</span>
                                    ${out.url.startsWith('srt') ? `<span style="font-size:0.70rem; font-weight:normal; display:flex; align-items:center; gap:6px;">Latencia SRT <b style="color:#fff;">${currentLatencyMs(out.url, true)}</b><button onclick="editLatency('out_${out.id}')" style="background:transparent; border:none; color:var(--accent-blue); cursor:pointer; font-size:0.8rem; padding:0;" title="Editar latencia de esta salida"><i class="fa-solid fa-pen"></i></button>${srtCipherBadge(out.url)}</span>` : ''}
                                    <span id="srtstats-out_${out.id}" style="font-size:0.70rem; color:var(--text-muted); font-weight:normal;"></span>
                                </span>
                            </div>
                            <div class="mid-section">
                                <div class="stat-item ${!out.enabled ? 'disabled' : ''}">
                                    <i class="fa-solid fa-clock"></i> <span id="time-out_${out.id}">--:--:--</span>
                                </div>
                                <div class="stat-item ${!out.enabled ? 'disabled' : ''}">
                                    <i class="fa-solid fa-gauge-high"></i> <span class="monospaced" id="bitrate-out_${out.id}">-- Mbps</span>
                                </div>
                                <div class="quality-bar">
                                    <div class="fill ${out.enabled ? 'yellow' : 'red'}" id="qbar-out_${out.id}" style="width: ${out.enabled ? '100%' : '0%'}"></div>
                                </div>
                            </div>
                            <div class="right-section sub-controls">
                                <div class="control-actions">
                                    <button class="action-btn toggle-enabled" onclick="toggleOutput(${out.id})">
                                        <i class="fa-solid ${out.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                                    </button>
                                    <button class="action-btn edit-btn" onclick="openEditOutput(${out.id})"><i class="fa-solid fa-pen"></i></button>
                                    <button class="action-btn delete-btn" onclick="deleteOutput(${out.id})"><i class="fa-solid fa-trash"></i></button>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        container.innerHTML += inputHTML;
    });
    syncThumbPlayers(); // Recoloca los vídeos en vivo en las tarjetas nuevas sin cortarlos
}

function toggleExpand(channel) {
    const card = document.getElementById(`input-card-${channel}`);
    card.classList.toggle('expand-mode');
    const icon = card.querySelector('.btn-expand i');
    if (card.classList.contains('expand-mode')) {
        icon.className = 'fa-solid fa-chevron-down';
    } else {
        icon.className = 'fa-solid fa-chevron-right';
    }
    syncThumbPlayers(); // Plegada no se ve: su vídeo en vivo se para
}

// Modal Logic
function openModal(id) {
    document.getElementById(id).style.display = 'flex';
}
function closeModal(id) {
    document.getElementById(id).style.display = 'none';
    if (id === 'previewModal') {
        const video = document.getElementById('previewVideo');
        if (video) {
            video.pause();
            video.removeAttribute('src'); // Stop downloading segment
            video.load(); // Reset video element completely
        }
    }
}

// Abre el modal de nuevo input reseteado y con los campos correctos visibles
function openAddInputModal() {
    document.getElementById('inp_is_edit').value = 'false';
    document.getElementById('inp_edit_channel').value = '';
    document.getElementById('formInput').reset();
    document.querySelector('#inputModal .modal-header h3').innerText = 'Add New Input Stream';
    // Restablecer selects al valor por defecto antes de actualizar los campos
    document.getElementById('inp_protocol').value = 'srt';
    document.getElementById('inp_mode').value = 'listener';
    document.getElementById('inp_is_edit').dataset.url = '';
    fillSrtFields('inp', '');
    updateInputFields();
    openModal('inputModal');
}

function openOutputModal(channel) {
    document.getElementById('out_channel').value = channel;
    document.getElementById('out_is_edit').value = 'false';
    document.querySelector('#outputModal .modal-header h3').innerText = 'Add Output';
    document.getElementById('formOutput').reset();
    document.getElementById('out_protocol').value = 'srt';
    document.getElementById('out_mode').value = 'caller';
    document.getElementById('out_is_edit').dataset.url = '';
    fillSrtFields('out', '');
    updateOutputFields();
    openModal('outputModal');
}

// API Interactions
function updateInputFields() {
    const proto = document.getElementById('inp_protocol').value;
    const modeContainer = document.getElementById('inp_mode_container');
    const ipContainer = document.getElementById('inp_ip_container');
    const portContainer = document.getElementById('inp_port_container');
    const ipLabel = document.getElementById('inp_ip_label');
    const portLabel = document.getElementById('inp_port_label');
    
    document.getElementById('inp_srt_opts').style.display = proto === 'srt' ? 'block' : 'none';
    if (proto === 'srt') {
        modeContainer.style.display = 'block';
        portContainer.style.display = 'block';
        ipLabel.innerText = 'Target IP';
        portLabel.innerText = 'Port (External)';
        const mode = document.getElementById('inp_mode').value;
        ipContainer.style.display = (mode === 'listener') ? 'none' : 'block';
    } else if (proto === 'rtmp') {
        modeContainer.style.display = 'none';
        portContainer.style.display = 'block';
        ipContainer.style.display = 'block';
        ipLabel.innerText = 'Servidor URL';
        document.getElementById('inp_ip').placeholder = 'rtmp://servidor.com/live';
        portLabel.innerText = 'Stream Key';
        document.getElementById('inp_port').placeholder = 'mi_clave_secreta';
        document.getElementById('inp_port').type = 'text';
    } else if (proto === 'rtmp_local') {
        modeContainer.style.display = 'none';
        portContainer.style.display = 'block';
        ipContainer.style.display = 'none';
        portLabel.innerText = 'Stream Key Local';
        document.getElementById('inp_port').placeholder = 'canal_1';
        document.getElementById('inp_port').type = 'text';
    } else {
        modeContainer.style.display = 'none';
        portContainer.style.display = 'block';
        ipContainer.style.display = 'block';
        ipLabel.innerText = 'Target IP';
        portLabel.innerText = 'Port (External)';
        document.getElementById('inp_port').type = 'number';
    }
}

function updateOutputFields() {
    const proto = document.getElementById('out_protocol').value;
    const modeContainer = document.getElementById('out_mode_container');
    const ipContainer = document.getElementById('out_ip_container');
    const portContainer = document.getElementById('out_port_container');
    const diskContainer = document.getElementById('out_disk_container');
    const ipLabel = document.getElementById('out_ip_label');
    const portLabel = document.getElementById('out_port_label');
    
    // Default hiding
    diskContainer.style.display = 'none';
    document.getElementById('out_srt_opts').style.display = proto === 'srt' ? 'block' : 'none';

    if (proto === 'srt') {
        modeContainer.style.display = 'block';
        portContainer.style.display = 'block';
        ipLabel.innerText = 'IP Destino';
        portLabel.innerText = 'Puerto';
        document.getElementById('out_port').type = 'number';
        const mode = document.getElementById('out_mode').value;
        ipContainer.style.display = (mode === 'listener') ? 'none' : 'block';
    } else if (proto === 'rtmp') {
        modeContainer.style.display = 'none';
        portContainer.style.display = 'block';
        ipContainer.style.display = 'block';
        ipLabel.innerText = 'RTMP URL de Youtube/Twitch/etc';
        document.getElementById('out_ip').placeholder = 'rtmp://a.rtmp.youtube.com/live2';
        portLabel.innerText = 'Stream Key';
        document.getElementById('out_port').placeholder = 'xxxx-xxxx-xxxx-xxxx';
        document.getElementById('out_port').type = 'text';
    } else if (proto === 'rtmp_local') {
        modeContainer.style.display = 'none';
        portContainer.style.display = 'block';
        ipContainer.style.display = 'none';
        portLabel.innerText = 'Generar Stream Key Propio';
        document.getElementById('out_port').placeholder = 'ej: streaming_final';
        document.getElementById('out_port').type = 'text';
    } else if (proto === 'disk') {
        modeContainer.style.display = 'none';
        portContainer.style.display = 'none';
        ipContainer.style.display = 'none';
        diskContainer.style.display = 'block';
        
        // Cargar discos para el dropdown
        fetch('/api/disks').then(r=>r.json()).then(disks => {
            const select = document.getElementById('out_disk');
            select.innerHTML = disks.map(d => `<option value="${d.path}">${d.name}</option>`).join('');
        });
        
        if (!document.getElementById('out_location').value || document.getElementById('out_location').value.startsWith('rec_')) {
            const channel = document.getElementById('out_channel').value;
            const inData = inputs.find(i => i.channel == channel);
            let inName = inData && inData.name ? inData.name.replace(/[^a-zA-Z0-9_\-]/g, '_') : ('CH' + channel);
            document.getElementById('out_location').value = inName + '_Grabacion.mp4';
        }
    } else {
        modeContainer.style.display = 'none';
        portContainer.style.display = 'block';
        ipContainer.style.display = 'block';
        ipLabel.innerText = 'IP Destino';
        portLabel.innerText = 'Puerto';
        document.getElementById('out_port').type = 'number';
    }
}

function openEditInput(channel) {
    const input = inputs.find(i => i.channel === channel);
    if (!input) return;
    document.getElementById('inp_is_edit').value = 'true';
    document.getElementById('inp_edit_channel').value = channel;
    
    document.getElementById('inp_name').value = input.name;
    // Watchdog config fields removed
    
    // Parse url broadly
    document.getElementById('inp_is_edit').dataset.url = input.url;
    fillSrtFields('inp', input.url.startsWith('srt') ? input.url : '');
    if (input.url.startsWith('srt')) {
        document.getElementById('inp_protocol').value = 'srt';
        const { host, port, mode } = srtHostMode(input.url);
        document.getElementById('inp_mode').value = mode;
        document.getElementById('inp_port').value = port;
        if (mode !== 'listener') document.getElementById('inp_ip').value = host;
    } else if (input.url.startsWith('rtmp://127.0.0.1:1935/live/')) {
        document.getElementById('inp_protocol').value = 'rtmp_local';
        document.getElementById('inp_port').value = input.url.replace('rtmp://127.0.0.1:1935/live/', '');
    } else if (input.url.startsWith('rtmp')) {
        document.getElementById('inp_protocol').value = 'rtmp';
        const lastSlash = input.url.lastIndexOf('/');
        document.getElementById('inp_ip').value = input.url.substring(0, lastSlash);
        document.getElementById('inp_port').value = input.url.substring(lastSlash + 1);
    } else {
        document.getElementById('inp_protocol').value = 'udp';
        const portMatch = input.url.match(/:(\d+)/);
        if(portMatch) document.getElementById('inp_port').value = portMatch[1];
    }
    updateInputFields();
    
    // Changing Modal Header
    document.querySelector('#inputModal .modal-header h3').innerText = 'Editar Input Stream';
    openModal('inputModal');
}

function findStreamByKey(key) {
    key = String(key);
    return key.startsWith('out_')
        ? outputs.find(o => 'out_' + o.id === key)
        : inputs.find(i => String(i.channel) === key);
}

function editLatency(channelId) {
    const item = findStreamByKey(channelId);
    if (!item) return;
    const currentUrl = item.url;
    let currentLatency = '';
    const match = currentUrl.match(/latency=(\d+)/);
    if (match) currentLatency = match[1];

    document.getElementById('lat_channel').value = channelId;
    document.getElementById('lat_current_url').value = currentUrl;
    document.getElementById('lat_value').value = currentLatency;

    // Con estadísticas SRT en vivo proponemos la latencia según el RTT real
    const s = srtStatsCache[String(channelId)];
    const hint = document.getElementById('lat_hint');
    if (s && s.rtt > 0) {
        const rec = recommendedLatency(s.rtt);
        document.getElementById('lat_rtt').innerText = `${s.rtt} ms`;
        document.getElementById('lat_rec').innerText = `${rec} ms`;
        document.getElementById('lat_rec').dataset.value = rec;
        hint.style.display = 'block';
    } else {
        hint.style.display = 'none';
    }

    openModal('latencyModal');
}

// Salud del enlace SRT (estadísticas de srt-live-transmit). Últimos valores por canal ('3' / 'out_5')
const srtStatsCache = {};

function currentLatencyMs(url, asText = false) {
    const m = (url || '').match(/[?&]latency=(\d+)/);
    const ms = m ? parseInt(m[1], 10) : 120; // 120 ms: valor por defecto de libsrt
    return asText ? (m ? `${ms} ms` : '120 ms (defecto)') : ms;
}

/* ===================================
 * OPCIONES SRT EN LOS FORMULARIOS (latencia, cifrado, passphrase)
 * Se guardan en la URL con los nombres de libsrt: latency (ms), pbkeylen, passphrase.
 * Al editar se conservan el resto de parámetros que ya tuviera la URL.
 * =================================== */
const SRT_FORM_KEYS = ['mode', 'latency', 'passphrase', 'pbkeylen'];
const PASSPHRASE_RE = /^[A-Za-z0-9._~!@$*+,;:-]{10,64}$/;

function srtUrlParams(url) {
    const qi = (url || '').indexOf('?');
    if (qi < 0) return [];
    return url.slice(qi + 1).split('&').filter(Boolean).map(kv => {
        const i = kv.indexOf('=');
        return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
    });
}

const srtParam = (url, key) => (srtUrlParams(url).find(([k]) => k === key) || [])[1];

// Oculta la passphrase al mostrar URLs en pantalla
const maskUrl = (url) => (url || '').replace(/(passphrase=)[^&]+/g, '$1••••••');

function srtCipherBadge(url) {
    if (!(url || '').startsWith('srt') || !srtParam(url, 'passphrase')) return '';
    const bits = { '24': 192, '32': 256 }[srtParam(url, 'pbkeylen')] || 128;
    return `<span class="badge-protocol srt" title="Cifrado AES-${bits} con passphrase" style="font-size:0.65rem; padding:2px 6px;"><i class="fa-solid fa-lock"></i> AES-${bits}</span>`;
}

function updateSrtCipherFields(px) {
    const on = document.getElementById(`${px}_pbkeylen`).value !== '';
    document.getElementById(`${px}_pass_group`).style.display = on ? 'block' : 'none';
    document.getElementById(`${px}_passphrase`).required = on;
}

function fillSrtFields(px, url) {
    document.getElementById(`${px}_latency`).value = srtParam(url, 'latency') || '';
    const pass = srtParam(url, 'passphrase') || '';
    // Con passphrase y sin pbkeylen, SRT usa AES-128
    document.getElementById(`${px}_pbkeylen`).value = pass ? (srtParam(url, 'pbkeylen') || '16') : '';
    document.getElementById(`${px}_passphrase`).value = pass;
    document.getElementById(`${px}_passphrase`).type = 'password';
    updateSrtCipherFields(px);
}

// Construye la URL SRT: host/puerto/modo + opciones del formulario + parámetros extra que ya tuviera
function buildSrtUrl(px, host, port, mode, previousUrl) {
    const params = [['mode', mode]];
    const latency = document.getElementById(`${px}_latency`).value.trim();
    if (latency !== '') params.push(['latency', String(parseInt(latency, 10))]);
    const pbkeylen = document.getElementById(`${px}_pbkeylen`).value;
    if (pbkeylen) {
        params.push(['passphrase', document.getElementById(`${px}_passphrase`).value]);
        params.push(['pbkeylen', pbkeylen]);
    }
    for (const [k, v] of srtUrlParams(previousUrl)) {
        if (!SRT_FORM_KEYS.includes(k)) params.push([k, v]);
    }
    return `srt://${host}:${port}?` + params.map(([k, v]) => v === '' ? k : `${k}=${v}`).join('&');
}

function srtFormError(px) {
    if (document.getElementById(`${px}_pbkeylen`).value && !PASSPHRASE_RE.test(document.getElementById(`${px}_passphrase`).value)) {
        return 'La passphrase debe tener de 10 a 64 caracteres (letras, números o . _ ~ ! @ $ * + , ; : -) y ser la misma en los dos extremos.';
    }
    const lat = document.getElementById(`${px}_latency`).value.trim();
    if (lat !== '' && !(parseInt(lat, 10) >= 0 && parseInt(lat, 10) <= 8000)) return 'La latencia debe estar entre 0 y 8000 ms.';
    return null;
}

// Host y modo de una URL SRT existente (para editar)
function srtHostMode(url) {
    const m = (url || '').match(/^srt:\/\/(\[[^\]]+\]|[^:/?]*):(\d+)/);
    return { host: m ? m[1] : '', port: m ? m[2] : '', mode: srtParam(url, 'mode') || 'caller' };
}

// Recomendación de Haivision: latencia de 3 a 4 veces el RTT. Mínimo 40 ms: en LAN (RTT ~1 ms)
// bajar más deja sin margen para retransmitir un paquete perdido
const recommendedLatency = (rtt) => Math.max(40, Math.ceil(rtt * 4 / 10) * 10);

function renderSrtStats(channel, s) {
    const el = document.getElementById(`srtstats-${channel}`);
    if (!s) {
        delete srtStatsCache[channel];
        if (el) el.innerHTML = '';
        return;
    }
    srtStatsCache[channel] = s;
    if (!el) return;

    const item = channel.startsWith('out_')
        ? outputs.find(o => 'out_' + o.id === channel)
        : inputs.find(i => String(i.channel) === channel);
    const latency = currentLatencyMs(item && item.url);
    const lowLatency = s.rtt > 0 && latency < s.rtt * 3;
    const color = (bad, warn) => bad ? 'var(--color-red)' : (warn ? 'var(--color-yellow)' : 'var(--color-green)');

    el.innerHTML = `
        <span title="Ida y vuelta de la red">RTT <b style="color:${color(lowLatency, s.rtt > latency / 4)}">${s.rtt} ms</b></span> ·
        <span title="Paquetes reenviados por ARQ en el último segundo">Retrans <b style="color:${color(s.retransPct > 10, s.retransPct > 2)}">${s.retransPct}%</b></span> ·
        <span title="Paquetes perdidos detectados (la mayoría se recuperan con retransmisión)">Pérdida <b>${s.lossPct}%</b></span> ·
        <span title="Paquetes que no llegaron a tiempo: provocan cortes en la imagen">Drops <b style="color:${color(s.drops > 0, false)}">${s.drops}</b></span>
        ${s.latency ? ` · <span title="Latencia SRT negociada con el otro extremo">Latencia efectiva <b>${s.latency} ms</b></span>` : ''}
        ${lowLatency ? `<div style="color:var(--color-yellow); margin-top:2px;"><i class="fa-solid fa-triangle-exclamation"></i> Latencia ${latency} ms por debajo de 3 × RTT: sube a ${recommendedLatency(s.rtt)} ms</div>` : ''}`;
}

// Sincronía entre señales: retardo por input aplicado en vivo (sin cortar la señal)
let syncSendTimer = null;

function openSyncModal(channelId) {
    const input = inputs.find(i => i.channel === channelId);
    if (!input) return;
    document.getElementById('sync_channel').value = channelId;
    document.getElementById('sync_name').innerText = input.name || `Channel ${channelId}`;
    setSyncFields(input.delay_ms || 0);
    openModal('syncModal');
}

function setSyncFields(ms) {
    document.getElementById('sync_value').value = ms;
    document.getElementById('sync_range').value = ms;
}

function onSyncInput(value) {
    const ms = Math.max(0, Math.min(10000, parseInt(value, 10) || 0));
    setSyncFields(ms);
    // Debounce: mientras se arrastra el slider se envía como mucho cada 150 ms
    clearTimeout(syncSendTimer);
    syncSendTimer = setTimeout(() => sendSyncDelay(ms), 150);
}

function nudgeSync(delta) {
    onSyncInput((parseInt(document.getElementById('sync_value').value, 10) || 0) + delta);
}

async function sendSyncDelay(ms) {
    const channelId = document.getElementById('sync_channel').value;
    try {
        await fetch(`/api/inputs/${channelId}/delay`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ delay_ms: ms })
        });
    } catch (e) {
        console.error("Error updating sync delay", e);
    }
}

async function submitLatency(e) {
    e.preventDefault();
    const key = document.getElementById('lat_channel').value;
    const currentUrl = document.getElementById('lat_current_url').value;
    const newVal = document.getElementById('lat_value').value;

    const match = currentUrl.match(/latency=(\d+)/);
    let newUrl = currentUrl;
    
    if (newVal === '') {
        // Remove latency completely
        newUrl = newUrl.replace(/([&?])latency=\d+&?/, '$1').replace(/[&?]$/, '');
    } else {
        if (match) {
            newUrl = newUrl.replace(/latency=\d+/, `latency=${newVal}`);
        } else {
            const separator = newUrl.includes('?') ? '&' : '?';
            newUrl = newUrl + separator + `latency=${newVal}`;
        }
    }

    // Sólo se envía la URL: el servidor conserva nombre, códec, etc. Reconecta sólo esta señal.
    const endpoint = key.startsWith('out_') ? `/api/outputs/${key.slice(4)}` : `/api/inputs/${key}`;
    try {
        const res = await fetch(endpoint, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ url: newUrl })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return alert(err.error || 'No se pudo guardar la latencia');
        }
        closeModal('latencyModal');
        fetchData();
    } catch (e) {
        console.error("Error updating latency", e);
    }
}

// ===================================
// FILE MANAGEMENT LOGIC
// ===================================
async function fetchStorage() {
    try {
        const res = await fetch('/api/disks');
        const disks = await res.json();
        
        // Populate Grid
        const grid = document.getElementById('storageDisksGrid');
        grid.innerHTML = '';
        const select = document.getElementById('storageDiskSelect');
        const currentSelection = select.value;
        select.innerHTML = '';
        
        if (disks.length === 0) {
            grid.innerHTML = '<div style="grid-column: span 3; text-align:center; padding: 20px; color:var(--text-muted);">No hay discos externos conectados.</div>';
            return;
        }

        disks.forEach(d => {
            // UI Grid
            grid.innerHTML += `
                <div class="analytics-card" style="box-shadow: 0 4px 10px rgba(0,0,0,0.5);">
                    <div class="acard-title"><i class="fa-solid fa-hard-drive"></i> ${d.name}</div>
                    <div class="acard-badge" style="background:var(--accent-blue);">Activo</div>
                    <div style="font-size: 0.8rem; margin-top: 10px; color: var(--text-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${d.path}</div>
                </div>
            `;
            // Select Population
            const opt = document.createElement('option');
            opt.value = d.path; // Enviamos absolPath limpio a /api/files
            opt.innerText = d.name;
            select.appendChild(opt);
        });

        // Maintain selection or def to first
        if (currentSelection && disks.find(d => d.path === currentSelection)) {
            select.value = currentSelection;
        } else {
            select.selectedIndex = 0;
        }
        
        fetchFiles();
        
    } catch(e) { console.error('fetchStorage failed', e); }
}

async function fetchFiles() {
    const parentDisk = document.getElementById('storageDiskSelect').value;
    if (!parentDisk) return;
    try {
        const res = await fetch(`/api/files?disk=${encodeURIComponent(parentDisk)}`);
        const files = await res.json();
        
        const tbody = document.getElementById('storageFilesList');
        tbody.innerHTML = '';
        
        if (files.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 20px; color:var(--text-muted);">No hay grabaciones en este disco.</td></tr>';
            return;
        }

        files.forEach(f => {
            const sizeMB = (f.size / (1024*1024)).toFixed(1);
            const dStr = new Date(f.date).toLocaleString('es-ES', { dateStyle:'short', timeStyle:'short' });
            const sName = f.name;
            
            tbody.innerHTML += `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.05); transition: background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">
                    <td style="padding: 12px 10px; color: var(--text-main); font-weight: 500;"><i class="fa-regular fa-file-video" style="color:var(--accent-blue); margin-right:8px;"></i>${sName}</td>
                    <td style="padding: 12px 10px;">${sizeMB} MB</td>
                    <td style="padding: 12px 10px;">${dStr}</td>
                    <td style="padding: 12px 10px; text-align:right;">
                        <button onclick="previewFile('${f.url}', '${f.name}')" class="action-btn toggle-enabled" title="Previsualizar" style="background:var(--accent-blue);"><i class="fa-solid fa-play"></i></button>
                        <a href="${f.url}" download="${f.name}" class="action-btn toggle-enabled" title="Descargar" style="text-decoration:none; display:inline-flex; align-items:center; justify-content:center; margin-left: 5px;"><i class="fa-solid fa-download"></i></a>
                        <button onclick="deleteFile('${f.url}')" class="action-btn terminate" title="Eliminar" style="margin-left: 5px;"><i class="fa-solid fa-trash"></i></button>
                    </td>
                </tr>
            `;
        });
    } catch(e) { console.error('fetchFiles failed', e); }
}

async function deleteFile(urlPath) {
    if (confirm("¿Estás seguro de eliminar esta grabación de forma permanente?")) {
        try {
            await fetch('/api/files/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filepath: urlPath })
            });
            fetchFiles();
        } catch(e) { alert("Error deleting."); }
    }
}

function previewFile(url, fname) {
    document.getElementById('previewTitle').innerText = fname;
    const video = document.getElementById('previewVideo');
    video.src = url;
    openModal('previewModal');
    video.play();
}

// Ensure video stops when modal is closed



function openEditOutput(id) {
    const out = outputs.find(o => o.id === id);
    if (!out) return;
    
    document.getElementById('out_is_edit').value = 'true';
    document.getElementById('out_edit_id').value = id;
    document.getElementById('out_location').value = out.location;
    document.getElementById('out_vcodec').value = out.vcodec || 'copy';
    
    // Parse url broadly
    document.getElementById('out_is_edit').dataset.url = out.url;
    fillSrtFields('out', out.url.startsWith('srt') ? out.url : '');
    if (out.url.startsWith('srt')) {
        document.getElementById('out_protocol').value = 'srt';
        const { host, port, mode } = srtHostMode(out.url);
        document.getElementById('out_mode').value = mode;
        document.getElementById('out_port').value = port;
        if (mode !== 'listener') document.getElementById('out_ip').value = host;
    } else if (out.url.startsWith('rtmp://127.0.0.1:1935/out/')) {
        document.getElementById('out_protocol').value = 'rtmp_local';
        document.getElementById('out_port').value = out.url.replace('rtmp://127.0.0.1:1935/out/', '');
    } else if (out.url.startsWith('disk://')) {
        document.getElementById('out_protocol').value = 'disk';
        const fullDiskUrl = out.url.replace('disk://', '');
        const lastSlash = fullDiskUrl.lastIndexOf('/') > fullDiskUrl.lastIndexOf('\\') ? fullDiskUrl.lastIndexOf('/') : fullDiskUrl.lastIndexOf('\\');
        document.getElementById('out_location').value = fullDiskUrl.substring(lastSlash + 1);
        
        // Wait briefly for updateOutputFields to populate the disk select, then select the right one
        setTimeout(() => {
            const select = document.getElementById('out_disk');
            const pathMatch = fullDiskUrl.substring(0, lastSlash);
            if (select) {
                Array.from(select.options).forEach(opt => {
                    if (pathMatch.includes(opt.value)) select.value = opt.value;
                });
            }
        }, 150);
    } else if (out.url.startsWith('rtmp')) {
        document.getElementById('out_protocol').value = 'rtmp';
        const lastSlash = out.url.lastIndexOf('/');
        document.getElementById('out_ip').value = out.url.substring(0, lastSlash);
        document.getElementById('out_port').value = out.url.substring(lastSlash + 1);
    } else {
        document.getElementById('out_protocol').value = 'udp';
        const portMatch = out.url.match(/:(\d+)/);
        if(portMatch) document.getElementById('out_port').value = portMatch[1];
        const ipMatch = out.url.match(/\/\/([^:]+)/);
        if(ipMatch) document.getElementById('out_ip').value = ipMatch[1];
    }
    updateOutputFields();
    
    document.querySelector('#outputModal .modal-header h3').innerText = 'Editar Output Stream';
    openModal('outputModal');
}

async function submitInput(e) {
    e.preventDefault();
    const proto = document.getElementById('inp_protocol').value;
    const port = document.getElementById('inp_port').value;
    let outUrl = '';

    if (proto === 'srt') {
        const srtError = srtFormError('inp');
        if (srtError) return alert(srtError);
        const mode = document.getElementById('inp_mode').value;
        const ip = (mode === 'listener') ? '0.0.0.0' : document.getElementById('inp_ip').value;
        const previous = document.getElementById('inp_is_edit').value === 'true' ? document.getElementById('inp_is_edit').dataset.url : '';
        outUrl = buildSrtUrl('inp', ip, port, mode, previous);
    } else if (proto === 'udp') {
        const ip = document.getElementById('inp_ip').value || '0.0.0.0';
        outUrl = `udp://${ip}:${port}`;
    } else if (proto === 'rtmp') {
        const ip = document.getElementById('inp_ip').value; // e.g. rtmp://x.com/live
        const key = document.getElementById('inp_port').value; // e.g. xyz
        outUrl = ip.endsWith('/') ? `${ip}${key}` : `${ip}/${key}`;
    } else if (proto === 'rtmp_local') {
        const key = document.getElementById('inp_port').value || 'canal_1';
        outUrl = `rtmp://127.0.0.1:${window.currentRtmpPort || 1935}/live/${key}`;
    } else {
        outUrl = document.getElementById('inp_ip').value || '';
    }

    const data = {
        name: document.getElementById('inp_name').value,
        url: outUrl
    };
    
    const isEdit = document.getElementById('inp_is_edit').value === 'true';
    const cId = document.getElementById('inp_edit_channel').value;
    const res = await fetch(isEdit ? `/api/inputs/${cId}` : '/api/inputs', {
        method: isEdit ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return alert(err.error || 'No se pudo guardar la entrada');
    }
    
    closeModal('inputModal');
    e.target.reset();
    document.getElementById('inp_is_edit').value = 'false';
    document.querySelector('#inputModal .modal-header h3').innerText = 'Add New Input Stream';
    updateInputFields();
}

async function submitOutput(e) {
    e.preventDefault();
    const proto = document.getElementById('out_protocol').value;
    const port = document.getElementById('out_port').value;
    let outUrl = '';

    if (proto === 'disk') {
        const disk = document.getElementById('out_disk').value;
        const location = document.getElementById('out_location').value || 'rec_' + Date.now() + '.mp4';
        let filename = location;
        if (!filename.match(/\.(mp4|mkv|ts)$/i)) filename += '.mp4';
        const slash = disk.endsWith('/') || disk.endsWith('\\') ? '' : '/';
        outUrl = `disk://${disk}${slash}${filename}`;
    } else if (proto === 'rtmp') {
        const ip = document.getElementById('out_ip').value;
        const key = document.getElementById('out_port').value;
        outUrl = ip.endsWith('/') ? `${ip}${key}` : `${ip}/${key}`;
    } else if (proto === 'rtmp_local') {
        const key = document.getElementById('out_port').value || 'streaming_final';
        outUrl = `rtmp://127.0.0.1:${window.currentRtmpPort || 1935}/out/${key}`;
    } else if (proto === 'srt') {
        const srtError = srtFormError('out');
        if (srtError) return alert(srtError);
        const mode = document.getElementById('out_mode').value;
        const ip = (mode === 'listener') ? '0.0.0.0' : document.getElementById('out_ip').value;
        const previous = document.getElementById('out_is_edit').value === 'true' ? document.getElementById('out_is_edit').dataset.url : '';
        outUrl = buildSrtUrl('out', ip, port, mode, previous);
    } else {
        const ip = document.getElementById('out_ip').value || '127.0.0.1';
        outUrl = `udp://${ip}:${port}`;
    }

    const data = {
        channel: parseInt(document.getElementById('out_channel').value),
        url: outUrl,
        location: document.getElementById('out_location').value,
        vcodec: document.getElementById('out_vcodec').value || 'copy'
    };

    const isEdit = document.getElementById('out_is_edit').value === 'true';
    const oId = document.getElementById('out_edit_id').value;
    const res = await fetch(isEdit ? `/api/outputs/${oId}` : '/api/outputs', {
        method: isEdit ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return alert(err.error || 'No se pudo guardar la salida');
    }
    
    closeModal('outputModal');
    e.target.reset();
    document.getElementById('out_is_edit').value = 'false';
    document.querySelector('#outputModal .modal-header h3').innerText = 'Add Output';
    updateOutputFields();
}
async function fetchSettingsData() {
    try {
        const [resUsers, resPorts] = await Promise.all([
            fetch('/api/users'),
            fetch('/api/ports')
        ]);
        const users = await resUsers.json();
        const ports = await resPorts.json();
        
        // Populate Ports
        if (ports) {
            document.getElementById('cfg_chanMin').value = ports.chanMin;
            document.getElementById('cfg_chanMax').value = ports.chanMax;
            document.getElementById('cfg_udpMin').value = ports.udpMin;
            document.getElementById('cfg_udpMax').value = ports.udpMax;
            document.getElementById('cfg_rtmpPort').value = ports.rtmpPort || 1935;
            window.currentRtmpPort = ports.rtmpPort || 1935;
        }

        // Render Users
        if (!Array.isArray(users)) return;
        usersCache = users;
        const container = document.getElementById('usersListContainer');
        container.innerHTML = users.map(u => {
            const roleBadge = u.role === ROLE_ADMIN ? '<span style="color:var(--color-red); font-weight:bold;">Admin</span>' : '<span style="color:var(--text-muted);">Operador</span>';
            const pending = u.mustChange ? ' | <span style="color:var(--color-yellow);">Cambio de contraseña pendiente</span>' : '';
            const isMe = currentUser && currentUser.username === u.username;
            return `
                <div style="display:flex; justify-content:space-between; align-items:center; padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <div>
                        <strong style="color:var(--text-main); font-size:1.05rem;">${escapeHtml(u.username)}</strong>${isMe ? ' <span style="color:var(--text-muted); font-size:0.8rem;">(tú)</span>' : ''}
                        <div style="font-size:0.8rem; margin-top:2px;">Rol: ${roleBadge} | ${escapeHtml(u.email) || 'Sin email'}${pending}</div>
                    </div>
                    <div style="display:flex; gap:6px;">
                        <button class="action-btn edit-btn" onclick="openEditUser('${escapeHtml(u.username)}')" title="Editar / restablecer contraseña">
                            <i class="fa-solid fa-pen"></i>
                        </button>
                        <button class="action-btn terminate" onclick="deleteUser('${escapeHtml(u.username)}')" title="Borrar cuenta" ${isMe ? 'disabled' : ''}>
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    } catch(e) { console.error("Error fetching settings:", e); }
}

let usersCache = [];

function openNewUserModal() {
    document.getElementById('formUser').reset();
    document.getElementById('usr_is_edit').value = 'false';
    document.getElementById('usr_username').readOnly = false;
    document.getElementById('usr_password').required = true;
    document.getElementById('usr_password_label').innerText = 'Contraseña (mínimo 8 caracteres)';
    document.getElementById('usr_must_change').checked = true;
    document.getElementById('usr_title').innerText = 'Añadir Nuevo Usuario';
    document.getElementById('usr_submit').innerText = 'Crear Cuenta';
    openModal('userModal');
}

function openEditUser(username) {
    const u = usersCache.find(x => x.username === username);
    if (!u) return;
    document.getElementById('formUser').reset();
    document.getElementById('usr_is_edit').value = 'true';
    document.getElementById('usr_username').value = u.username;
    document.getElementById('usr_username').readOnly = true;
    document.getElementById('usr_password').required = false;
    document.getElementById('usr_password_label').innerText = 'Nueva contraseña (vacío = no cambiarla)';
    document.getElementById('usr_role').value = String(u.role);
    document.getElementById('usr_email').value = u.email || '';
    document.getElementById('usr_must_change').checked = !!u.mustChange;
    document.getElementById('usr_title').innerText = `Editar ${u.username}`;
    document.getElementById('usr_submit').innerText = 'Guardar cambios';
    openModal('userModal');
}

async function savePorts(e) {
    e.preventDefault();
    const payload = {
        chanMin: parseInt(document.getElementById('cfg_chanMin').value),
        chanMax: parseInt(document.getElementById('cfg_chanMax').value),
        udpMin: parseInt(document.getElementById('cfg_udpMin').value),
        udpMax: parseInt(document.getElementById('cfg_udpMax').value),
        rtmpPort: parseInt(document.getElementById('cfg_rtmpPort').value)
    };
    try {
        await fetch('/api/ports', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        alert('Configuración de Puertos UDP Actualizada.');
    } catch(e) { console.error(e); }
}

async function submitUser(e) {
    e.preventDefault();
    const isEdit = document.getElementById('usr_is_edit').value === 'true';
    const username = document.getElementById('usr_username').value.trim();
    const payload = {
        role: parseInt(document.getElementById('usr_role').value),
        email: document.getElementById('usr_email').value,
        mustChange: document.getElementById('usr_must_change').checked
    };
    const password = document.getElementById('usr_password').value;
    if (password) payload.password = password;
    if (!isEdit) payload.username = username;

    try {
        const res = await fetch(isEdit ? `/api/users/${encodeURIComponent(username)}` : '/api/users', {
            method: isEdit ? 'PUT' : 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        if(res.ok) {
            closeModal('userModal');
            fetchSettingsData();
            if (isEdit && currentUser && username === currentUser.username) loadSession();
        } else {
            const err = await res.json();
            alert(`Error al ${isEdit ? 'guardar' : 'crear'} usuario: ${err.error}`);
        }
    } catch(e) { console.error(e); }
}

async function deleteUser(username) {
    if(!confirm(`¿Borrar definitivamente a ${username}?`)) return;
    try {
        const res = await fetch(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert('No se pudo borrar: ' + (err.error || res.status));
        }
        fetchSettingsData();
    } catch(e) { console.error(e); }
}

async function toggleInput(channel) {
    await fetch(`/api/inputs/${channel}/toggle`, { method: 'POST' });
    fetchData();
}

/* =======================================
 *  AUDIO: vúmetros y escucha
 * ======================================= */
const VU_FLOOR_DB = -60;          // Fondo de escala del vúmetro
const VU_SILENCE_DB = -60;        // Por debajo de esto cuenta como silencio
const VU_SILENCE_MS = 5000;       // Silencio o sin pista durante este tiempo → "Sin audio"
const vuState = {};               // canal -> { level:[L,R], peak:[L,R], peakAt:[t,t], lastSound }

const dbToPct = (db) => Math.max(0, Math.min(100, (db - VU_FLOOR_DB) / -VU_FLOOR_DB * 100));

function renderAudioLevels(levels) {
    const now = Date.now();
    for (const [channel, lv] of Object.entries(levels)) {
        const s = vuState[channel] || (vuState[channel] = {
            level: [VU_FLOOR_DB, VU_FLOOR_DB], peak: [VU_FLOOR_DB, VU_FLOOR_DB], peakAt: [0, 0], lastSound: now
        });
        for (let i = 0; i < 2; i++) {
            const db = lv ? lv[i] : VU_FLOOR_DB;
            // Subida instantánea, caída de 3 dB por mensaje (~30 dB/s)
            s.level[i] = Math.max(db, s.level[i] - 3);
            // Marca de pico: se mantiene 1 s y luego cae
            if (db >= s.peak[i]) { s.peak[i] = db; s.peakAt[i] = now; }
            else if (now - s.peakAt[i] > 1000) s.peak[i] = Math.max(db, s.peak[i] - 2);

            const mask = document.getElementById(`vu-${channel}-${i}`);
            const peak = document.getElementById(`vu-${channel}-${i}p`);
            if (mask) mask.style.height = `${100 - dbToPct(s.level[i])}%`;
            if (peak) peak.style.bottom = `calc(${dbToPct(s.peak[i])}% - 1px)`;
        }
        if (lv && Math.max(lv[0], lv[1]) > VU_SILENCE_DB) s.lastSound = now;
        const warn = document.getElementById(`vu-warn-${channel}`);
        if (warn) warn.classList.toggle('show', now - s.lastSound > VU_SILENCE_MS);
    }
    // Inputs parados: dejan de venir en el mensaje, vaciamos su vúmetro
    for (const channel of Object.keys(vuState)) {
        if (channel in levels) continue;
        delete vuState[channel];
        for (let i = 0; i < 2; i++) {
            const mask = document.getElementById(`vu-${channel}-${i}`);
            const peak = document.getElementById(`vu-${channel}-${i}p`);
            if (mask) mask.style.height = '100%';
            if (peak) peak.style.bottom = '0';
        }
        document.getElementById(`vu-warn-${channel}`)?.classList.remove('show');
    }
}

// Un solo <audio> fuera de las tarjetas: renderStreams() reconstruye el HTML sin cortarlo
const listenAudio = new Audio();
let listeningChannel = null;

function updateListenButtons() {
    document.querySelectorAll('.listen-btn').forEach(btn => {
        const on = btn.id === `listen-${listeningChannel}`;
        btn.classList.toggle('on', on);
        btn.querySelector('i').className = `fa-solid ${on ? 'fa-volume-high' : 'fa-volume-xmark'}`;
    });
}

function stopListen() {
    listeningChannel = null;
    listenAudio.pause();
    listenAudio.removeAttribute('src');
    listenAudio.load(); // Cierra la conexión: el servidor mata su FFmpeg
    updateListenButtons();
}

function toggleListen(channelId) {
    const channel = String(channelId);
    if (listeningChannel === channel) return stopListen();
    stopListen();
    listeningChannel = channel;
    listenAudio.src = `/api/audio/${channel}?t=${Date.now()}`;
    listenAudio.play().catch(() => {});
    updateListenButtons();
}

// El servidor corta el audio si paran la entrada
listenAudio.addEventListener('ended', () => { if (listeningChannel) stopListen(); });
listenAudio.addEventListener('error', () => {
    if (!listeningChannel) return;
    stopListen();
    alert('No se puede escuchar esta entrada: no tiene audio o no hay señal.');
});

/* =======================================
 *  REPRODUCTOR EN DIRECTO (HLS)
 * ======================================= */
let liveHls = null;

function setLiveMsg(text) {
    const msg = document.getElementById('liveMsg');
    msg.textContent = text;
    msg.style.display = text ? 'block' : 'none';
}

function openLive(channelId) {
    const channel = String(channelId);
    const input = inputs.find(i => String(i.channel) === channel);
    if (!input || !input.enabled) return;
    if (listeningChannel) stopListen(); // Si no, se oiría dos veces con distinto retraso
    stopLiveStream();

    document.getElementById('liveTitle').textContent = input.name || `Channel ${channel}`;
    const video = document.getElementById('liveVideo');
    video.onplaying = () => setLiveMsg('');
    setLiveMsg('Conectando… (unos segundos)');
    openModal('liveModal');

    const src = `/hls/${channel}/index.m3u8`;
    if (window.Hls && Hls.isSupported()) {
        liveHls = new Hls({ liveSyncDurationCount: 2, manifestLoadingMaxRetry: 6, manifestLoadingRetryDelay: 1000 });
        liveHls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
        liveHls.on(Hls.Events.ERROR, (e, data) => {
            if (!data.fatal) return;
            stopLiveStream();
            setLiveMsg('No se puede reproducir esta señal: no hay señal o el navegador no admite su códec (H.265).');
        });
        liveHls.loadSource(src);
        liveHls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src; // Safari reproduce HLS sin librería
    } else {
        setLiveMsg('Este navegador no puede reproducir HLS.');
    }
}

function stopLiveStream() {
    if (liveHls) {
        liveHls.destroy();
        liveHls = null;
    }
    const video = document.getElementById('liveVideo');
    video.pause();
    video.removeAttribute('src');
    video.load();
}

// Al dejar de pedir la lista, el servidor para el HLS a los 15 s
function closeLive() {
    stopLiveStream();
    closeModal('liveModal');
}

/*
 * Miniaturas en vivo: con el ojo encendido y la tarjeta desplegada, el HLS se reproduce
 * sin sonido encima de la imagen fija. Los <video> viven fuera del HTML de las tarjetas:
 * renderStreams() las reconstruye y syncThumbPlayers() los vuelve a colocar sin cortarlos.
 */
const thumbPlayers = {}; // canal -> { video, hls, retry }

function wantsThumbLive(input) {
    const card = document.getElementById(`input-card-${input.channel}`);
    return !!(input.preview_enabled && input.enabled && card && card.classList.contains('expand-mode'));
}

function syncThumbPlayers() {
    const wanted = new Set();
    for (const input of inputs) {
        const channel = String(input.channel);
        const box = document.getElementById(`thumb-box-${channel}`);
        if (!box || !wantsThumbLive(input)) continue;
        wanted.add(channel);
        const p = thumbPlayers[channel] || startThumbPlayer(channel);
        if (p.video.parentNode !== box) box.appendChild(p.video);
    }
    for (const channel of Object.keys(thumbPlayers)) {
        if (!wanted.has(channel)) stopThumbPlayer(channel);
    }
}

function startThumbPlayer(channel) {
    const video = document.createElement('video');
    video.className = 'live-thumb';
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.title = 'Ver en grande';
    video.onclick = () => openLive(channel);
    video.onplaying = () => video.classList.add('playing');
    const p = { video, hls: null, retry: null };
    thumbPlayers[channel] = p;
    loadThumbPlayer(p, channel);
    return p;
}

function loadThumbPlayer(p, channel) {
    const src = `/hls/${channel}/index.m3u8`;
    if (window.Hls && Hls.isSupported()) {
        p.hls = new Hls({ liveSyncDurationCount: 2, manifestLoadingMaxRetry: 6, manifestLoadingRetryDelay: 1000 });
        p.hls.on(Hls.Events.MANIFEST_PARSED, () => p.video.play().catch(() => {}));
        p.hls.on(Hls.Events.ERROR, (e, data) => {
            if (!data.fatal) return;
            // Sin señal o códec no soportado (H.265): queda la imagen fija y se reintenta
            p.hls.destroy();
            p.hls = null;
            p.video.classList.remove('playing');
            p.retry = setTimeout(() => {
                p.retry = null;
                if (thumbPlayers[channel] === p) loadThumbPlayer(p, channel);
            }, 10000);
        });
        p.hls.loadSource(src);
        p.hls.attachMedia(p.video);
    } else if (p.video.canPlayType('application/vnd.apple.mpegurl')) {
        p.video.src = src;
    }
}

function stopThumbPlayer(channel) {
    const p = thumbPlayers[channel];
    if (!p) return;
    delete thumbPlayers[channel];
    clearTimeout(p.retry);
    if (p.hls) p.hls.destroy();
    p.video.pause();
    p.video.removeAttribute('src');
    p.video.load();
    p.video.remove();
}

async function togglePreview(channelId) {
    try {
        await fetch(`/api/inputs/${channelId}/preview`, { method: 'POST' });
        // UI assumes success directly and waits for websocket, but we can optimistically disable polling for it
    } catch(e) { console.error('Error toggling preview', e); }
}

async function deleteInput(channelId) {
    if(confirm('Are you sure you want to delete this input and all its outputs?')) {
        await fetch(`/api/inputs/${channelId}`, { method: 'DELETE' });
    }
}

async function toggleOutput(id) {
    await fetch(`/api/outputs/${id}/toggle`, { method: 'POST' });
}

async function deleteOutput(id) {
    if(confirm('Are you sure you want to delete this output?')) {
        await fetch(`/api/outputs/${id}`, { method: 'DELETE' });
    }
}
