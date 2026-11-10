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

/* Avisos no bloqueantes (sustituyen a alert()): aparecen abajo, se van solos y por el mismo
   camino por el que entraron. Tipos: 'error' (por defecto), 'ok', 'warn'. */
function toast(msg, type = 'error', action = null) {
    let host = document.getElementById('toast-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'toast-host';
        host.setAttribute('role', 'status');
        host.setAttribute('aria-live', 'polite');
        document.body.appendChild(host);
    }
    const icon = { ok: 'fa-circle-check', warn: 'fa-triangle-exclamation', error: 'fa-circle-exclamation', info: 'fa-circle-info' }[type] || 'fa-circle-info';
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fa-solid ${icon}"></i><span></span><button type="button" aria-label="Cerrar"><i class="fa-solid fa-xmark"></i></button>`;
    el.querySelector('span').textContent = msg;
    if (action) {
        const a = document.createElement('button');
        a.type = 'button';
        a.className = 'toast-action';
        a.textContent = action.label;
        a.onclick = () => { action.fn(); close(); };
        el.insertBefore(a, el.lastElementChild);
    }
    const close = () => {
        if (el.classList.contains('leaving')) return;
        el.classList.add('leaving');
        el.addEventListener('animationend', () => el.remove(), { once: true });
        setTimeout(() => el.remove(), 400); // por si no hay animación (movimiento reducido)
    };
    el.lastElementChild.onclick = close;
    host.appendChild(el);
    // Los errores se quedan más tiempo: hay que poder leerlos
    setTimeout(close, type === 'error' ? 7000 : (action ? 6000 : 3500));
}

const socket = io();
// Luz de estado de la cabecera: refleja la conexión real con el servidor, no un texto fijo
function setConnectionBadge(online) {
    const b = document.querySelector('.status-badge');
    if (!b) return;
    b.classList.toggle('offline', !online);
    b.lastChild.textContent = online ? ' En línea' : ' Sin conexión';
    b.title = online ? 'Conectado al servidor' : 'Sin conexión con el servidor: reintentando…';
}
socket.on('connect', () => setConnectionBadge(true));
socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') window.location.href = '/login.html';
    setConnectionBadge(false);
});
// El servidor cierra el socket si borran el usuario o cambian su contraseña
socket.on('disconnect', (reason) => {
    setConnectionBadge(false);
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
    // Si ya se está en Encoders, los botones de administrador dependen de la sesión recién cargada
    if (document.getElementById('nav-encoders').classList.contains('active')) switchTab('encoders');

    // Enlace a Grafana (mismo host, su propio puerto) si está instalado
    const status = await fetch('/api/status').then(r => r.json()).catch(() => ({}));
    if (status.grafanaPort) {
        const link = document.getElementById('nav-grafana');
        link.href = `${window.location.protocol}//${window.location.hostname}:${status.grafanaPort}/d/tsst`;
        // Mismo enlace junto al historial del dashboard, para ir al detalle
        const histLink = document.getElementById('history-grafana');
        histLink.href = link.href;
        histLink.style.display = '';
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
        return toast('Las contraseñas nuevas no coinciden');
    }
    const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ currentPassword: document.getElementById('pwd_current').value, newPassword })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error || 'No se pudo cambiar la contraseña');
    document.getElementById('formPassword').reset();
    closeModal('passwordModal');
    toast('Contraseña actualizada. Las demás sesiones de tu usuario se han cerrado.', 'ok');
}

// State
let inputs = [];
let outputs = [];
let rtmpViewers = {}; // id de salida -> { count, clients } (salidas RTMP locales)
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
    document.getElementById('encodersContainer').style.display = tabId === 'encoders' ? 'block' : 'none';
    // El botón de la cabecera cambia de función en la pestaña Encoders
    const addBtn = document.getElementById('btn-add-input');
    document.getElementById('view-toggle').hidden = tabId !== 'streams';
    addBtn.onclick = tabId === 'encoders' ? openAddEncoderModal : openAddInputModal;
    addBtn.innerHTML = tabId === 'encoders' ? '<i class="fa-solid fa-plus"></i> Añadir encoder' : '<i class="fa-solid fa-plus"></i> Añadir entrada';

    if (tabId === 'encoders') {
        ['streamsContainer', 'analyticsContainer', 'systemContainer', 'settingsContainer', 'storageContainer']
            .forEach(id => { document.getElementById(id).style.display = 'none'; });
        document.getElementById('topbar-title').innerText = 'Encoders';
        document.getElementById('topbar-subtitle').innerText = 'Equipos remotos: estado, túnel VPN y acceso a su web';
        addBtn.style.display = currentUser && currentUser.role === ROLE_ADMIN ? 'inline-block' : 'none';
        fetchEncoders();
    } else if (tabId === 'streams') {
        document.getElementById('streamsContainer').style.display = ''; // lista o mosaico, según su clase
        document.getElementById('analyticsContainer').style.display = 'none';
        document.getElementById('systemContainer').style.display = 'none';
        document.getElementById('settingsContainer').style.display = 'none';
        document.getElementById('storageContainer').style.display = 'none';
        document.getElementById('topbar-title').innerText = 'Señales';
        document.getElementById('topbar-subtitle').innerText = 'Entradas y salidas en directo';
        document.getElementById('btn-add-input').style.display = 'inline-block';
    } else if (tabId === 'analytics') {
        document.getElementById('streamsContainer').style.display = 'none';
        document.getElementById('analyticsContainer').style.display = 'block';
        document.getElementById('systemContainer').style.display = 'none';
        document.getElementById('settingsContainer').style.display = 'none';
        document.getElementById('storageContainer').style.display = 'none';
        document.getElementById('topbar-title').innerText = 'Analítica';
        document.getElementById('topbar-subtitle').innerText = 'Telemetría de red y estado de las señales';
        document.getElementById('btn-add-input').style.display = 'none';

        // Por defecto, todas las entradas activas en la gráfica
        if (selectedAnalyticsChannels.size === 0) inputs.filter(i => i.enabled).forEach(i => selectedAnalyticsChannels.add(String(i.channel)));
        populateAnalyticsGrid();
        updateTelemetryChart();
        renderSignalStatus();
        placeHistorySection('analytics-history-slot');
        loadHistory();
    } else if (tabId === 'system') {
        document.getElementById('streamsContainer').style.display = 'none';
        document.getElementById('analyticsContainer').style.display = 'none';
        document.getElementById('systemContainer').style.display = 'block';
        document.getElementById('settingsContainer').style.display = 'none';
        document.getElementById('storageContainer').style.display = 'none';
        document.getElementById('topbar-title').innerText = 'Resumen';
        document.getElementById('topbar-subtitle').innerText = 'Estado del servidor y de las rutas';
        document.getElementById('btn-add-input').style.display = 'none';
        placeHistorySection(null);
        loadHistory();
    } else if (tabId === 'settings') {
        document.getElementById('streamsContainer').style.display = 'none';
        document.getElementById('analyticsContainer').style.display = 'none';
        document.getElementById('systemContainer').style.display = 'none';
        document.getElementById('settingsContainer').style.display = 'block';
        document.getElementById('storageContainer').style.display = 'none';
        document.getElementById('topbar-title').innerText = 'Ajustes';
        document.getElementById('topbar-subtitle').innerText = 'Puertos y usuarios';
        document.getElementById('btn-add-input').style.display = 'none';

        fetchSettingsData();
    } else if (tabId === 'storage') {
        document.getElementById('streamsContainer').style.display = 'none';
        document.getElementById('analyticsContainer').style.display = 'none';
        document.getElementById('systemContainer').style.display = 'none';
        document.getElementById('settingsContainer').style.display = 'none';
        document.getElementById('storageContainer').style.display = 'block';
        document.getElementById('topbar-title').innerText = 'Grabaciones';
        document.getElementById('topbar-subtitle').innerText = 'Discos USB y archivos grabados';
        document.getElementById('btn-add-input').style.display = 'none';

        fetchStorage();
    }
}

function initChart() {
    const ctx = document.getElementById('bitrateChart').getContext('2d');
    telemetryChart = new Chart(ctx, {
        type: 'line',
        data: { datasets: [] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            parsing: false,
            interaction: { mode: 'nearest', axis: 'x', intersect: false },
            plugins: {
                legend: {
                    display: true,
                    labels: { color: 'rgba(255,255,255,0.7)', boxWidth: 12, font: { family: getComputedStyle(document.body).fontFamily, size: 11 } }
                },
                tooltip: {
                    backgroundColor: 'rgba(0,0,0,0.85)',
                    callbacks: {
                        title: (items) => items.length ? new Date(items[0].parsed.x).toLocaleTimeString() : '',
                        label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(2)} Mbps`
                    }
                }
            },
            scales: {
                // Eje de tiempo real (ms): entradas y salidas informan en instantes distintos,
                // así que cada línea lleva sus propios puntos y no quedan huecos al mezclarlas
                x: {
                    type: 'linear',
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: 'rgba(255,255,255,0.4)', maxTicksLimit: 8, maxRotation: 0, callback: (v) => new Date(v).toLocaleTimeString() }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.05)' }, min: 0,
                    ticks: { color: 'rgba(255,255,255,0.4)', callback: (v) => `${v} Mbps` }
                }
            }
        }
    });
}

function analyticsLabel(ch) {
    if (ch.startsWith('out_')) {
        const id = parseInt(ch.slice(4), 10);
        const o = outputs.find(x => x.id === id);
        return o ? `OUT_${id} (${(o.location || maskUrl(o.url)).substring(0, 24)})` : `OUT_${id}`;
    }
    const i = inputs.find(x => String(x.channel) === ch);
    return i ? `IN_${ch} (${i.name})` : `IN_${ch}`;
}

function populateAnalyticsGrid() {
    const grid = document.getElementById('analytics_grid');
    let html = '';

    inputs.filter(i => i.enabled).forEach(i => {
        const ch = String(i.channel);
        html += `
            <div class="analytics-card ${selectedAnalyticsChannels.has(ch) ? 'selected' : ''}" onclick="toggleAnalyticsChannel('${ch}')">
                <div class="acard-title">${escapeHtml(i.name)}</div>
                <div class="acard-badge">IN_${ch}</div>
            </div>`;
        // Sus salidas justo al lado de la entrada
        outputs.filter(o => o.channel === i.channel && o.enabled).forEach(o => {
            const outId = 'out_' + o.id;
            html += `
                <div class="analytics-card ${selectedAnalyticsChannels.has(outId) ? 'selected' : ''}" onclick="toggleAnalyticsChannel('${outId}')" style="margin-left: 20px; border-left: 3px solid rgba(255,255,255,0.2);">
                    <div class="acard-title" style="font-size:0.8rem; opacity:0.8;">${escapeHtml((o.location || maskUrl(o.url)).substring(0, 30))}</div>
                    <div class="acard-badge" style="background: rgba(255,255,255,0.1);">OUT_${o.id}</div>
                </div>`;
        });
    });

    grid.innerHTML = html || '<div style="color:var(--text-muted); font-size:0.9rem;">No hay señales activas</div>';
}

function updateTelemetryChart() {
    if (!telemetryChart) return;
    telemetryChart.data.datasets = Array.from(selectedAnalyticsChannels).map((ch, index) => {
        const color = chartColors[index % chartColors.length];
        const points = (frontendTelemetryCache[ch] || [])
            .filter(dp => typeof dp.t === 'number')
            .map(dp => ({ x: dp.t, y: dp.y / 1000 })); // kbps -> Mbps
        return {
            label: analyticsLabel(ch),
            data: points,
            borderColor: color,
            backgroundColor: color + '22',
            borderWidth: 2,
            tension: 0.3,
            fill: false,
            pointRadius: 0
        };
    });
    telemetryChart.update('none');
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

/* ===================================
 * ESTADO DE LAS SEÑALES (Analytics), en vivo desde los eventos 'stats'
 * =================================== */
const liveStats = {}; // 'channel' | 'out_id' -> último evento stats + hora de llegada
let signalStatusTimer = null;

function noteLiveStats(data) {
    liveStats[String(data.channel)] = { ...data, at: Date.now() };
    // Como mucho un repintado por segundo, y sólo con Analytics a la vista
    if (signalStatusTimer || document.getElementById('analyticsContainer').style.display === 'none') return;
    signalStatusTimer = setTimeout(() => { signalStatusTimer = null; renderSignalStatus(); }, 1000);
}

function signalState(enabled, s) {
    if (!enabled) return { cls: 'off', text: 'Apagada' };
    if (!s || Date.now() - s.at > 6000 || !s.active) return { cls: 'bad', text: 'Sin datos' };
    return parseFloat(s.bitrate) > 0 ? { cls: 'good', text: 'En vivo' } : { cls: 'warn', text: 'Esperando señal' };
}

// Códec que sale por una salida: en passthrough es el mismo de la entrada; si no, el de la conversión
const OUTPUT_CODECS = {
    h264_vaapi: 'H.264 · Quick Sync',
    hevc_vaapi: 'H.265 · Quick Sync',
    libx264: 'H.264 · CPU',
    libx265: 'H.265 · CPU'
};
function outputCodecText(o) {
    const vcodec = o.vcodec || 'copy';
    if (vcodec !== 'copy') return OUTPUT_CODECS[vcodec] || vcodec;
    const inStats = liveStats[String(o.channel)];
    return inStats && inStats.codec ? `${inStats.codec} · passthrough` : 'Passthrough';
}

// Latencia SRT: la negociada si srt-live-transmit la informa (sólo en recepción);
// si no (las salidas no la reportan), la configurada en la URL
function srtLatencyCell(srt, url) {
    if (srt && srt.latency) return `<span title="Latencia negociada con el otro extremo">${srt.latency} ms</span>`;
    if (!url || !url.startsWith('srt://')) return '—';
    return `<span title="Latencia configurada en esta salida (el receptor puede pedir más)">${currentLatencyMs(url, true)}</span>`;
}

function signalRow(key, name, proto, enabled, isOutput, codecText, url) {
    const s = liveStats[key];
    const st = signalState(enabled, s);
    const kbps = s && st.cls !== 'off' ? parseFloat(s.bitrate) || 0 : null;
    const srt = s && s.srt;
    const dash = '—';
    return `<tr class="${isOutput ? 'sig-out' : 'sig-in'}">
        <td>${isOutput ? '<span class="sig-branch">↳</span>' : ''}${escapeHtml(name)} <span class="sig-proto">${proto}</span>${isOutput && enabled && isLocalRtmpOut(url) ? ` <span class="rtmp-viewers" data-viewers="${key.slice(4)}"></span>` : ''}</td>
        <td><span class="sig-state ${st.cls}">${st.text}</span></td>
        <td>${kbps === null ? dash : `${(kbps / 1000).toFixed(2)} Mbps`}</td>
        <td>${s && s.time && st.cls === 'good' ? s.time : dash}</td>
        <td>${codecText ? escapeHtml(codecText) : (!isOutput && s && s.codec ? escapeHtml(s.codec) : dash)}</td>
        <td class="${srt && srt.rtt > 100 ? 'warn' : ''}">${srt ? `${srt.rtt} ms` : dash}</td>
        <td class="${srt && srt.retransPct > 10 ? 'bad' : srt && srt.retransPct > 2 ? 'warn' : ''}">${srt ? `${srt.lossPct}% / ${srt.retransPct}%` : dash}</td>
        <td class="${srt && srt.drops > 0 ? 'bad' : ''}">${srt ? srt.drops : dash}</td>
        <td>${srtLatencyCell(srt, url)}</td>
        <td>${!isOutput && s && s.delay ? `${s.delay} ms` : dash}</td>
    </tr>`;
}

function renderSignalStatus() {
    const body = document.getElementById('signal-status-body');
    if (!body) return;
    let rows = '';
    let live = 0, waiting = 0, off = 0;
    inputs.forEach(i => {
        const key = String(i.channel);
        const st = signalState(i.enabled, liveStats[key]).cls;
        if (st === 'good') live++; else if (st === 'off') off++; else waiting++;
        rows += signalRow(key, i.name, i.url.split('://')[0].toUpperCase(), i.enabled, false, null, i.url);
        outputs.filter(o => o.channel === i.channel).forEach(o => {
            rows += signalRow('out_' + o.id, o.location || maskUrl(o.url), o.url.split('://')[0].toUpperCase(), o.enabled, true, outputCodecText(o), o.url);
        });
    });
    body.innerHTML = rows || '<tr><td colspan="10" style="color:var(--text-muted);">No hay señales configuradas.</td></tr>';
    paintRtmpViewers();
    document.getElementById('signal-status-count').textContent =
        `${live} en vivo · ${waiting} sin señal · ${off} apagadas`;
}

// El bloque de historial (Prometheus) es uno solo: se muestra en el Dashboard o en Analytics
let historyHome = null;
function placeHistorySection(slotId) {
    const section = document.getElementById('history-section');
    if (!section) return;
    if (!historyHome) historyHome = { parent: section.parentNode, next: section.nextSibling };
    if (slotId) document.getElementById(slotId).appendChild(section);
    else historyHome.parent.insertBefore(section, historyHome.next);
    // Chart.js recalcula el tamaño al volver a estar visible
    Object.values(historyCharts).forEach(c => c.resize());
}

document.addEventListener('DOMContentLoaded', () => {
    loadSession();
    switchTab('system'); // Iniciar en el Dashboard
    fetchData();
    initChart();

    // Socket listeners
    socket.on('db_update', (data) => {
        console.log("DB Update:", data.event);

        if (data.event === 'encoders_changed') {
            fetchEncoders();
            return;
        }

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
                if (tt) tt.innerText = data.enabled ? 'Habilitada' : 'Deshabilitada';
            }
            // Toggle Icon
            const btn = document.querySelector(`#input-card-${data.channel} .toggle-enabled i`);
            if (btn) btn.className = `fa-solid ${data.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}`;
            // Quality Bar
            const qbar = document.getElementById(`qbar-${data.channel}`);
            if (qbar) {
                // Habilitada pero aún sin datos: barra gris (en espera). La pinta 'stats' cuando hay señal
                qbar.className = `fill ${data.enabled ? 'idle' : ''}`;
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
                if (tt) tt.innerText = data.enabled ? 'Habilitada' : 'Deshabilitada';
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

        pushSpark(String(data.channel), data.active ? kbpsOf(data.bitrate) : 0);
        trackSignal(data);

        // Barra de estado: verde = llegan datos, gris = habilitada esperando señal, vacía = parada
        const qbarElem = document.getElementById(`qbar-${data.channel}`);
        if (qbarElem) {
            const hasData = data.active && parseFloat(data.bitrate) > 0;
            qbarElem.className = `fill ${hasData ? 'green' : (data.active ? 'idle' : '')}`;
            qbarElem.style.width = data.active ? '100%' : '0%';
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
        noteLiveStats(data);

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
    socket.on('encoders_status', applyEncoderStatus);
    socket.on('rtmp_viewers', (v) => { rtmpViewers = v || {}; paintRtmpViewers(); });

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
    const serverIp = window.location.hostname;

    // Estado vacío: explica qué hacer en lugar de una pantalla en blanco
    if (!inputs.length) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fa-solid fa-satellite-dish"></i>
                <h3>Aún no hay señales</h3>
                <p>Añade la primera entrada SRT, UDP o RTMP para empezar a recibir y repartir señal.</p>
                ${currentUser && currentUser.role === ROLE_ADMIN ? '<button class="btn-primary" onclick="openAddInputModal()"><i class="fa-solid fa-plus"></i> Añadir entrada</button>' : ''}
            </div>`;
        return;
    }
    container.querySelectorAll(':scope > :not(.stream-card)').forEach(n => n.remove());

    // Sólo se reconstruye la tarjeta cuya configuración ha cambiado: las demás se quedan tal cual
    // (sin parpadeos, conservan su minigráfico, su vídeo y lo que el usuario tenga abierto)
    const keep = new Set();
    inputs.forEach((input, index) => {
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
                        <button class="btn-expand" onclick="toggleExpand(${input.channel})" aria-label="Desplegar salidas"><i class="fa-solid fa-chevron-down"></i></button>
                        <div id="led-${input.channel}" class="connection-led ${input.enabled ? 'active yellow' : 'error'} tooltip">
                            <i class="fa-solid fa-lightbulb"></i>
                            <span class="tooltiptext">${input.enabled ? 'Habilitada' : 'Deshabilitada'}</span>
                        </div>
                        <div class="badge-protocol ${protocolBadge}">${protocolText}</div>
                        <span id="codec-${input.channel}" class="badge-protocol udp" style="background:#4b5563;">H.26X</span>
                        <span class="stream-name" style="display:flex; flex-direction:column; line-height:1.2;">
                            ${input.name || 'Channel ' + input.channel}
                            <span class="stream-url" title="${maskUrl(input.url).replace(/127\.0\.0\.1|0\.0\.0\.0/g, serverIp)}">${maskUrl(input.url).replace(/127\.0\.0\.1|0\.0\.0\.0/g, serverIp)}</span>
                        </span>
                    </div>
                    <div class="mid-section">
                        <div class="stat-item ${!input.enabled ? 'disabled' : ''}">
                            <i class="fa-solid fa-clock"></i> <span id="time-${input.channel}">${input.enabled ? '<span class="sk"></span>' : '—'}</span>
                        </div>
                        <div class="stat-item ${!input.enabled ? 'disabled' : ''}">
                            <i class="fa-solid fa-gauge-high"></i> <span class="monospaced" id="bitrate-${input.channel}">${input.enabled ? '<span class="sk"></span>' : '—'}</span>
                        </div>
                        <div class="quality-bar" title="Bitrate del último minuto">
                            <svg class="spark" data-key="${input.channel}" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"><path class="spark-area"/><path class="spark-line"/></svg>
                            <div class="fill ${input.enabled ? 'idle' : ''}" id="qbar-${input.channel}" style="width: ${input.enabled ? '100%' : '0%'}"></div>
                        </div>
                    </div>
                    <div class="right-section">
                        <div class="control-actions">
                            <button class="action-btn toggle-enabled tooltip" onclick="toggleInput(${input.channel})">
                                <i class="fa-solid ${input.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                                <span class="tooltiptext">Activar / desactivar</span>
                            </button>
                            <button class="action-btn edit-btn" onclick="openEditInput(${input.channel})"><i class="fa-solid fa-pen"></i></button>
                            <button class="action-btn delete-btn" onclick="deleteInput(${input.channel})"><i class="fa-solid fa-trash"></i></button>
                            <button class="btn-secondary add-output" onclick="openOutputModal(${input.channel})"><i class="fa-solid fa-arrow-right-to-bracket"></i> Añadir salida</button>
                        </div>
                    </div>
                </div>

                <div class="stream-outputs" id="outputs-container-${input.channel}"><div class="so-inner">
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
                            <p><strong>Recepción</strong></p>
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
                                    <span class="tooltiptext">${out.enabled ? 'Habilitada' : 'Deshabilitada'}</span>
                                </div>
                                <span class="stream-name" style="display:flex; flex-direction:column; line-height:1.2;">
                                    ${out.location || maskUrl(out.url)}
                                    <span class="stream-url muted" title="${maskUrl(out.url).replace(/127\.0\.0\.1|0\.0\.0\.0/g, serverIp)}">${maskUrl(out.url).replace(/127\.0\.0\.1|0\.0\.0\.0/g, serverIp)}</span>
                                    ${out.url.startsWith('srt') ? `<span style="font-size:0.70rem; font-weight:normal; display:flex; align-items:center; gap:6px;">Latencia SRT <b style="color:#fff;">${currentLatencyMs(out.url, true)}</b><button onclick="editLatency('out_${out.id}')" style="background:transparent; border:none; color:var(--accent-blue); cursor:pointer; font-size:0.8rem; padding:0;" title="Editar latencia de esta salida"><i class="fa-solid fa-pen"></i></button>${srtCipherBadge(out.url)}</span>` : ''}
                                    <span id="srtstats-out_${out.id}" style="font-size:0.70rem; color:var(--text-muted); font-weight:normal;"></span>
                                    ${isLocalRtmpOut(out.url) && out.enabled ? `<span class="rtmp-viewers" data-viewers="${out.id}"></span>` : ''}
                                </span>
                            </div>
                            <div class="mid-section">
                                <div class="stat-item ${!out.enabled ? 'disabled' : ''}">
                                    <i class="fa-solid fa-clock"></i> <span id="time-out_${out.id}">${out.enabled ? '<span class="sk"></span>' : '—'}</span>
                                </div>
                                <div class="stat-item ${!out.enabled ? 'disabled' : ''}">
                                    <i class="fa-solid fa-gauge-high"></i> <span class="monospaced" id="bitrate-out_${out.id}">${out.enabled ? '<span class="sk"></span>' : '—'}</span>
                                </div>
                                <div class="quality-bar" title="Bitrate del último minuto">
                                    <svg class="spark" data-key="out_${out.id}" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"><path class="spark-area"/><path class="spark-line"/></svg>
                                    <div class="fill ${out.enabled ? 'idle' : ''}" id="qbar-out_${out.id}" style="width: ${out.enabled ? '100%' : '0%'}"></div>
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
                </div></div>
            </div>
        `;
        const cardId = `input-card-${input.channel}`;
        keep.add(cardId);
        const key = JSON.stringify([input, inputOutputs, serverIp]);
        let card = document.getElementById(cardId);
        if (!card || card.dataset.key !== key) {
            const tpl = document.createElement('template');
            tpl.innerHTML = inputHTML.trim();
            const fresh = tpl.content.firstElementChild;
            fresh.dataset.key = key;
            if (card) {
                fresh.classList.toggle('expand-mode', card.classList.contains('expand-mode'));
                card.replaceWith(fresh);
            } else {
                container.appendChild(fresh);
            }
            card = fresh;
            redrawSparks(card);
            // Si en unos segundos no ha llegado ningún dato, el marcador de carga pasa a "—"
            setTimeout(() => card.querySelectorAll('.sk').forEach(sk => sk.replaceWith('—')), 6000);
        }
        if (container.children[index] !== card) container.insertBefore(card, container.children[index] || null);
    });
    container.querySelectorAll(':scope > .stream-card').forEach(c => { if (!keep.has(c.id)) c.remove(); });
    syncThumbPlayers(); // Recoloca los vídeos en vivo en las tarjetas nuevas sin cortarlos
    paintRtmpViewers();
}

function toggleExpand(channel) {
    const card = document.getElementById(`input-card-${channel}`);
    card.classList.toggle('expand-mode'); // la flecha gira y el contenido se despliega por CSS
    syncThumbPlayers(); // Plegada no se ve: su vídeo en vivo se para
}

// Modal Logic
// Cerrar con Esc (cualquier ventana) o tocando fuera (sólo las de vídeo: en un formulario
// un toque sin querer haría perder lo escrito)
const BACKDROP_CLOSE = new Set(['previewModal', 'liveModal']);
function closeModalById(id) {
    if (id === 'liveModal') closeLive(); // además de ocultar, para el HLS
    else closeModal(id);
}
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.modal-overlay')].filter(m => m.style.display === 'flex');
    if (open.length) closeModalById(open[open.length - 1].id);
});
document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains('modal-overlay') && BACKDROP_CLOSE.has(t.id)) closeModalById(t.id);
});

function openModal(id) {
    const ov = document.getElementById(id);
    clearTimeout(ov._closeTimer); // si se reabre mientras se cerraba, sigue desde donde está
    ov.classList.remove('closing');
    ov.style.display = 'flex';
}
function closeModal(id) {
    // Sale por el mismo camino por el que entró (escala + opacidad invertidas) y luego se oculta
    const ov = document.getElementById(id);
    if (ov._instantClose) { // ya ha salido de la pantalla arrastrándola: sin animación de cierre
        ov._instantClose = false;
        clearTimeout(ov._closeTimer);
        ov.classList.remove('closing');
        ov.style.display = 'none';
    } else if (ov.style.display === 'flex' && !ov.classList.contains('closing')) {
        ov.classList.add('closing');
        ov._closeTimer = setTimeout(() => { ov.style.display = 'none'; ov.classList.remove('closing'); }, 160);
    } else if (!ov.classList.contains('closing')) {
        ov.style.display = 'none';
    }
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
    document.querySelector('#inputModal .modal-header h3').innerText = 'Nueva entrada';
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
    document.querySelector('#outputModal .modal-header h3').innerText = 'Nueva salida';
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
        ipLabel.innerText = 'IP de destino';
        portLabel.innerText = 'Puerto (externo)';
        const mode = document.getElementById('inp_mode').value;
        ipContainer.style.display = (mode === 'listener') ? 'none' : 'block';
    } else if (proto === 'rtmp') {
        modeContainer.style.display = 'none';
        portContainer.style.display = 'block';
        ipContainer.style.display = 'block';
        ipLabel.innerText = 'URL del servidor';
        document.getElementById('inp_ip').placeholder = 'rtmp://servidor.com/live';
        portLabel.innerText = 'Clave de emisión';
        document.getElementById('inp_port').placeholder = 'mi_clave_secreta';
        document.getElementById('inp_port').type = 'text';
    } else if (proto === 'rtmp_local') {
        modeContainer.style.display = 'none';
        portContainer.style.display = 'block';
        ipContainer.style.display = 'none';
        portLabel.innerText = 'Clave de emisión local';
        document.getElementById('inp_port').placeholder = 'canal_1';
        document.getElementById('inp_port').type = 'text';
    } else {
        modeContainer.style.display = 'none';
        portContainer.style.display = 'block';
        ipContainer.style.display = 'block';
        ipLabel.innerText = 'IP de destino';
        portLabel.innerText = 'Puerto (externo)';
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
        ipLabel.innerText = 'URL RTMP (YouTube, Twitch…)';
        document.getElementById('out_ip').placeholder = 'rtmp://a.rtmp.youtube.com/live2';
        portLabel.innerText = 'Clave de emisión';
        document.getElementById('out_port').placeholder = 'xxxx-xxxx-xxxx-xxxx';
        document.getElementById('out_port').type = 'text';
    } else if (proto === 'rtmp_local') {
        modeContainer.style.display = 'none';
        portContainer.style.display = 'block';
        ipContainer.style.display = 'none';
        portLabel.innerText = 'Clave de emisión propia';
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
    document.querySelector('#inputModal .modal-header h3').innerText = 'Editar entrada';
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

/* Conexiones a las salidas RTMP locales (reproductores tirando de rtmp://servidor/out/clave) */
const isLocalRtmpOut = (url) => /^rtmp:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url || '');

function viewersAgo(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    return `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`;
}

// Rellena los contadores que haya en pantalla (dashboard y tabla de Analytics)
function paintRtmpViewers() {
    document.querySelectorAll('[data-viewers]').forEach(el => {
        const v = rtmpViewers[el.dataset.viewers];
        const n = v ? v.count : 0;
        el.classList.toggle('has', n > 0);
        el.innerHTML = `<i class="fa-solid fa-eye"></i> ${n} ${n === 1 ? 'conexión' : 'conexiones'}`;
        el.title = n
            ? v.clients.map(c => `${c.ip} · conectado hace ${viewersAgo(Date.now() - c.since)}`).join('\n')
            : 'Nadie está tirando de esta salida ahora mismo';
    });
}

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
            return toast(err.error || 'No se pudo guardar la latencia');
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
        } catch(e) { toast('No se pudo borrar la grabación'); }
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

    document.querySelector('#outputModal .modal-header h3').innerText = 'Editar salida';
    openModal('outputModal');
}

async function submitInput(e) {
    e.preventDefault();
    const proto = document.getElementById('inp_protocol').value;
    const port = document.getElementById('inp_port').value;
    let outUrl = '';

    if (proto === 'srt') {
        const srtError = srtFormError('inp');
        if (srtError) return toast(srtError);
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
        return toast(err.error || 'No se pudo guardar la entrada');
    }

    closeModal('inputModal');
    toast(isEdit ? 'Entrada actualizada' : 'Entrada creada', 'ok');
    e.target.reset();
    document.getElementById('inp_is_edit').value = 'false';
    document.querySelector('#inputModal .modal-header h3').innerText = 'Nueva entrada';
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
        if (srtError) return toast(srtError);
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
        return toast(err.error || 'No se pudo guardar la salida');
    }

    closeModal('outputModal');
    toast(isEdit ? 'Salida actualizada' : 'Salida creada', 'ok');
    e.target.reset();
    document.getElementById('out_is_edit').value = 'false';
    document.querySelector('#outputModal .modal-header h3').innerText = 'Nueva salida';
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
        toast('Puertos actualizados', 'ok');
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
            toast(`Error al ${isEdit ? 'guardar' : 'crear'} usuario: ${err.error}`);
        }
    } catch(e) { console.error(e); }
}

async function deleteUser(username) {
    if(!confirm(`¿Borrar definitivamente a ${username}?`)) return;
    try {
        const res = await fetch(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            toast('No se pudo borrar: ' + (err.error || res.status));
        }
        fetchSettingsData();
    } catch(e) { console.error(e); }
}

async function toggleInput(channel, fromUndo = false) {
    const inp = inputs.find(i => i.channel == channel);
    const wasEnabled = inp && inp.enabled;
    const res = await fetch(`/api/inputs/${channel}/toggle`, { method: 'POST' });
    fetchData();
    if (!res.ok) return toast('No se pudo cambiar el estado de la entrada');
    if (wasEnabled && !fromUndo) {
        toast(`«${inp.name || 'Entrada ' + channel}» deshabilitada`, 'info', { label: 'Deshacer', fn: () => toggleInput(channel, true) });
    }
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
    toast('No se puede escuchar esta entrada: no tiene audio o no hay señal.', 'warn');
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
    if(confirm('¿Borrar esta entrada y todas sus salidas? No se puede deshacer.')) {
        await fetch(`/api/inputs/${channelId}`, { method: 'DELETE' });
    }
}

async function toggleOutput(id, fromUndo = false) {
    const out = outputs.find(o => o.id == id);
    const wasEnabled = out && out.enabled;
    const res = await fetch(`/api/outputs/${id}/toggle`, { method: 'POST' });
    if (!res.ok) return toast('No se pudo cambiar el estado de la salida');
    if (wasEnabled && !fromUndo) {
        toast(`Salida «${out.location || 'sin nombre'}» deshabilitada`, 'info', { label: 'Deshacer', fn: () => toggleOutput(id, true) });
    }
}

async function deleteOutput(id) {
    if(confirm('¿Borrar esta salida? No se puede deshacer.')) {
        await fetch(`/api/outputs/${id}`, { method: 'DELETE' });
    }
}

/* ===================================
 * HISTORIAL EN EL DASHBOARD (datos de Prometheus, los mismos que Grafana)
 * =================================== */
let historyRange = '1h';
let historyLoading = false;
const historyCharts = {};

function setHistoryRange(range) {
    historyRange = range;
    document.querySelectorAll('.history-ranges button').forEach(b => b.classList.toggle('active', b.dataset.range === range));
    loadHistory();
}

const fmtMbps = (bps) => `${(bps / 1e6).toFixed(2)} Mbps`;
const fmtPct = (r) => `${(r * 100).toFixed(1)} %`;

// Etiqueta de cada línea: nombre de la señal o de la salida
function historyLabel(labels) {
    const base = labels.name || labels.location || (labels.channel ? `Canal ${labels.channel}` : 'Serie');
    return labels.direction ? `${base} ${labels.direction === 'recv' ? '⬇' : '⬆'}` : base;
}

function timeLabel(ts, range) {
    const d = new Date(ts * 1000);
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return range === '24h' ? `${d.toLocaleDateString([], { day: '2-digit', month: '2-digit' })} ${hm}` : hm;
}

// Una gráfica de líneas: todas las series comparten los instantes (mismo step de Prometheus)
function drawHistoryChart(id, seriesList, { scale = 1, unit = '', max } = {}) {
    const ts = [...new Set(seriesList.flatMap(s => s.values.map(v => v[0])))].sort((a, b) => a - b);
    const datasets = seriesList.map((s, i) => {
        const byTs = new Map(s.values.map(([t, v]) => [t, v * scale]));
        const color = s.color || chartColors[i % chartColors.length];
        return {
            label: s.label || historyLabel(s.labels),
            data: ts.map(t => (byTs.has(t) ? byTs.get(t) : null)),
            borderColor: color, backgroundColor: color + '22',
            borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: false
        };
    });
    const labels = ts.map(t => timeLabel(t, historyRange));
    let chart = historyCharts[id];
    if (!chart) {
        chart = historyCharts[id] = new Chart(document.getElementById(id).getContext('2d'), {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: true, labels: { color: 'rgba(255,255,255,0.7)', boxWidth: 12, font: { family: getComputedStyle(document.body).fontFamily, size: 11 } } },
                    tooltip: { backgroundColor: 'rgba(0,0,0,0.85)', callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y === null ? '—' : c.parsed.y.toFixed(2)} ${unit}` } }
                },
                scales: {
                    x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(255,255,255,0.4)', maxTicksLimit: 8, maxRotation: 0 } },
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(255,255,255,0.4)', callback: (v) => `${v} ${unit}` }, min: 0, max }
                }
            }
        });
    } else {
        chart.data.labels = labels;
        chart.data.datasets = datasets;
        chart.update('none');
    }
}

function renderHistorySummary(rows) {
    const body = document.getElementById('history-summary');
    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="5" style="color:var(--text-muted);">Sin datos de señales en este periodo.</td></tr>';
        return;
    }
    rows.sort((a, b) => Number(a.channel) - Number(b.channel));
    body.innerHTML = rows.map(r => {
        const av = r.availability;
        const avClass = av === undefined ? '' : av >= 0.999 ? 'good' : av >= 0.95 ? 'warn' : 'bad';
        const drops = r.drops === undefined ? '—' : Math.round(r.drops);
        const restarts = r.restarts === undefined ? '—' : Math.round(r.restarts);
        return `<tr>
            <td>${escapeHtml(r.name || 'Canal ' + r.channel)}</td>
            <td class="${avClass}">${av === undefined ? '—' : fmtPct(av)}</td>
            <td class="${drops > 0 ? 'bad' : 'good'}">${drops}</td>
            <td class="${restarts > 0 ? 'warn' : ''}">${restarts}</td>
            <td>${r.maxRtt === undefined ? '—' : `${(r.maxRtt * 1000).toFixed(0)} ms`}</td>
        </tr>`;
    }).join('');
}

async function loadHistory() {
    if (historyLoading) return;
    historyLoading = true;
    const msg = document.getElementById('history-msg');
    const body = document.getElementById('history-body');
    try {
        const data = await fetch(`/api/history?range=${historyRange}`).then(r => r.json());
        if (!data.available) {
            body.style.display = 'none';
            msg.style.display = 'block';
            msg.textContent = 'Historial no disponible: instala la monitorización (Prometheus) con el instalador para guardar el historial de las señales.';
            return;
        }
        msg.style.display = 'none';
        body.style.display = 'block';
        renderHistorySummary(data.summary);
        const s = data.series;
        drawHistoryChart('hist_input', s.inputBitrate, { scale: 1e-6, unit: 'Mbps' });
        drawHistoryChart('hist_output', s.outputBitrate, { scale: 1e-6, unit: 'Mbps' });
        drawHistoryChart('hist_rtt', s.srtRtt, { scale: 1000, unit: 'ms' });
        drawHistoryChart('hist_drops', s.srtDropsPerMin, { unit: '/min' });
        drawHistoryChart('hist_host', [
            ...s.cpu.map(x => ({ ...x, label: 'CPU', color: '#60A5FA' })),
            ...s.memory.map(x => ({ ...x, label: 'Memoria', color: '#34d399' }))
        ], { scale: 100, unit: '%', max: 100 });
    } catch (e) {
        msg.style.display = 'block';
        msg.textContent = 'No se pudo cargar el historial.';
    } finally {
        historyLoading = false;
    }
}

// Refresco cada 30 s, sólo con el dashboard a la vista y la pestaña del navegador activa
setInterval(() => {
    const visible = ['systemContainer', 'analyticsContainer'].some(id => document.getElementById(id).style.display !== 'none');
    if (visible && !document.hidden) loadHistory();
}, 30000);

/* =======================================
 *  ENCODERS REMOTOS
 * ======================================= */
let encoderList = [];
let encoderVpnInfo = null;

const isAdmin = () => currentUser && currentUser.role === ROLE_ADMIN;

function agoText(sec) {
    if (sec === null || sec === undefined) return '—';
    if (sec < 60) return `hace ${Math.round(sec)} s`;
    if (sec < 3600) return `hace ${Math.round(sec / 60)} min`;
    if (sec < 86400) return `hace ${Math.round(sec / 3600)} h`;
    return `hace ${Math.round(sec / 86400)} d`;
}

function inputHasSignal(channel) {
    const hist = frontendTelemetryCache[String(channel)];
    return !!(hist && hist.length && hist[hist.length - 1].y > 0);
}

async function fetchEncoders() {
    try {
        const [list, vpn] = await Promise.all([
            fetch('/api/encoders', { cache: 'no-store' }).then(r => r.json()),
            encoderVpnInfo ? Promise.resolve(encoderVpnInfo) : fetch('/api/encoders/vpn').then(r => r.json()).catch(() => null)
        ]);
        encoderList = Array.isArray(list) ? list : [];
        encoderVpnInfo = vpn;
        renderEncoders();
    } catch (e) {
        console.error('Encoders', e);
    }
}

function applyEncoderStatus(list) {
    if (!Array.isArray(list)) return;
    list.forEach(s => {
        const enc = encoderList.find(e => e.id === s.id);
        if (enc) enc.status = s;
    });
    if (document.getElementById('encodersContainer').style.display !== 'none') renderEncoders();
}

function encoderStateHtml(enc) {
    const st = enc.status || {};
    let web;
    if (st.online === undefined) web = '<span class="sig-state off">Comprobando…</span>';
    else if (st.online) web = `<span class="sig-state good">En línea</span> <span class="enc-muted">${st.responseMs !== null ? Math.round(st.responseMs) + ' ms' : ''}</span>`;
    else web = `<span class="sig-state bad">Sin respuesta</span> <span class="enc-muted">${escapeHtml(st.error || '')}${st.lastSeen ? ' · visto ' + agoText((Date.now() - st.lastSeen) / 1000) : ''}</span>`;

    let vpn;
    if (!enc.vpn) vpn = '<span class="sig-state off">Sin túnel</span>';
    else if (!st.vpn) vpn = '<span class="sig-state off">Comprobando…</span>';
    else if (st.vpn.up) vpn = `<span class="sig-state good">Activo</span> <span class="enc-muted">${agoText(st.vpn.handshakeAge)}${st.vpn.endpoint ? ' · ' + escapeHtml(st.vpn.endpoint) : ''}</span>`;
    else vpn = `<span class="sig-state bad">Caído</span> <span class="enc-muted">${st.vpn.handshakeAge !== null ? 'último contacto ' + agoText(st.vpn.handshakeAge) : 'el router aún no se ha conectado'}</span>`;

    let sig = '<span class="sig-state off">Sin vincular</span>';
    if (enc.channel !== null && enc.channel !== undefined) {
        const inp = inputs.find(i => i.channel == enc.channel);
        if (!inp) sig = '<span class="sig-state off">Entrada borrada</span>';
        else if (!inp.enabled) sig = `<span class="sig-state off">${escapeHtml(inp.name)} · apagada</span>`;
        else if (inputHasSignal(inp.channel)) sig = `<span class="sig-state good">${escapeHtml(inp.name)} · recibiendo</span>`;
        else sig = `<span class="sig-state warn">${escapeHtml(inp.name)} · sin señal</span>`;
    }
    return { web, vpn, sig, ok: st.online && (!enc.vpn || (st.vpn && st.vpn.up)) };
}

function renderEncoders() {
    const grid = document.getElementById('encodersGrid');
    const banner = document.getElementById('encoders-vpn-banner');
    if (isAdmin() && encoderVpnInfo && !encoderVpnInfo.available) {
        banner.style.display = '';
        banner.innerHTML = `<i class="fa-solid fa-circle-info"></i> <div><strong>WireGuard no está activo en este servidor.</strong> ${escapeHtml(encoderVpnInfo.reason || '')}<br>
            Puedes añadir encoders a los que el servidor ya llegue por red. Para encoders remotos detrás de un router 4G, activa WireGuard en el instalador (<code>sudo bash instalar_servidor.sh</code>).</div>`;
    } else {
        banner.style.display = 'none';
    }

    if (!encoderList.length) {
        grid.innerHTML = `<div class="enc-empty"><i class="fa-solid fa-tower-broadcast"></i><p>No hay encoders.</p>
            <p class="enc-muted">${isAdmin() ? 'Pulsa <strong>Añadir encoder</strong> para dar de alta el primero.' : 'Pide a un administrador que los dé de alta.'}</p></div>`;
        return;
    }

    grid.innerHTML = encoderList.map(enc => {
        const s = encoderStateHtml(enc);
        const st = enc.status || {};
        const led = st.online === undefined ? 'yellow' : (s.ok ? '' : 'error');
        const proxyUrl = `http://${window.location.hostname}:${enc.proxy_port}/`;
        return `
        <div class="enc-card">
            <div class="enc-head">
                <span class="connection-led active ${led}"></span>
                <div style="min-width:0;">
                    <div class="enc-name">${escapeHtml(enc.name)}</div>
                    <div class="enc-muted">${escapeHtml(enc.model || 'Encoder')} · ${escapeHtml(enc.host)}:${enc.web_port}${enc.https ? ' (HTTPS)' : ''}</div>
                </div>
            </div>
            <dl class="enc-rows">
                <dt>Web</dt><dd>${s.web}</dd>
                <dt>Túnel</dt><dd>${s.vpn}</dd>
                <dt>Señal</dt><dd>${s.sig}</dd>
                ${enc.vpn ? `<dt>VPN</dt><dd class="enc-muted">${escapeHtml(enc.vpn_ip)}${enc.vpn_lan ? ' · LAN ' + escapeHtml(enc.vpn_lan) : ''}</dd>` : ''}
                ${enc.notes ? `<dt>Notas</dt><dd class="enc-muted">${escapeHtml(enc.notes)}</dd>` : ''}
                ${st.proxyError ? `<dt>Proxy</dt><dd><span class="sig-state bad">${escapeHtml(st.proxyError)}</span></dd>` : ''}
            </dl>
            <div class="enc-actions">
                <a class="btn-primary" href="${proxyUrl}" target="_blank" rel="noopener" title="Abre la web del encoder a través del servidor (puerto ${enc.proxy_port})"><i class="fa-solid fa-arrow-up-right-from-square"></i> Abrir web</a>
                ${isAdmin() ? `
                <button class="btn-secondary" onclick="openEncoderVpn(${enc.id})" title="Acceso WireGuard del router"><i class="fa-solid fa-shield-halved"></i> VPN</button>
                <button class="btn-secondary" onclick="openEditEncoderModal(${enc.id})" title="Editar"><i class="fa-solid fa-pen"></i></button>
                <button class="btn-secondary" onclick="deleteEncoder(${enc.id})" title="Borrar"><i class="fa-solid fa-trash"></i></button>` : ''}
            </div>
        </div>`;
    }).join('');
}

function fillEncoderChannels(selected) {
    const sel = document.getElementById('enc_channel');
    sel.innerHTML = '<option value="">— Ninguna —</option>' + inputs.map(i =>
        `<option value="${i.channel}" ${String(i.channel) === String(selected ?? '') ? 'selected' : ''}>${escapeHtml(i.name)} (canal ${i.channel})</option>`).join('');
}

function openAddEncoderModal() {
    document.getElementById('formEncoder').reset();
    document.getElementById('enc_id').value = '';
    document.getElementById('enc_title').innerText = 'Añadir encoder';
    fillEncoderChannels(null);
    openModal('encoderModal');
}

function openEditEncoderModal(id) {
    const enc = encoderList.find(e => e.id === id);
    if (!enc) return;
    document.getElementById('enc_id').value = enc.id;
    document.getElementById('enc_title').innerText = 'Editar encoder';
    document.getElementById('enc_name').value = enc.name;
    document.getElementById('enc_model').value = enc.model || '';
    document.getElementById('enc_host').value = enc.host;
    document.getElementById('enc_port').value = enc.web_port;
    document.getElementById('enc_https').checked = !!enc.https;
    document.getElementById('enc_notes').value = enc.notes || '';
    fillEncoderChannels(enc.channel);
    openModal('encoderModal');
}

async function submitEncoder(e) {
    e.preventDefault();
    const id = document.getElementById('enc_id').value;
    const body = {
        name: document.getElementById('enc_name').value,
        model: document.getElementById('enc_model').value,
        host: document.getElementById('enc_host').value,
        web_port: document.getElementById('enc_port').value,
        https: document.getElementById('enc_https').checked,
        channel: document.getElementById('enc_channel').value,
        notes: document.getElementById('enc_notes').value
    };
    const res = await fetch(id ? `/api/encoders/${id}` : '/api/encoders', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error || 'No se pudo guardar el encoder');
    closeModal('encoderModal');
    fetchEncoders();
}

async function deleteEncoder(id) {
    const enc = encoderList.find(e => e.id === id);
    if (!enc) return;
    const extra = enc.vpn ? '\n\nTambién se borrará su acceso WireGuard: el router dejará de conectar.' : '';
    if (!confirm(`¿Borrar el encoder "${enc.name}"?${extra}`)) return;
    const res = await fetch(`/api/encoders/${id}`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); return toast(d.error || 'No se pudo borrar'); }
    fetchEncoders();
}

async function openEncoderVpn(id) {
    const enc = encoderList.find(e => e.id === id);
    if (!enc) return;
    encoderVpnInfo = await fetch('/api/encoders/vpn?refresh=1').then(r => r.json()).catch(() => encoderVpnInfo);
    const info = encoderVpnInfo || {};
    document.getElementById('vpn_title').innerText = `Acceso WireGuard · ${enc.name}`;
    const body = document.getElementById('vpn_body');

    if (enc.vpn) {
        const endpoint = info.endpoint ? info.endpoint + (/:\d+$/.test(info.endpoint) ? '' : ':' + (info.listenPort || 51820)) : `IP pública del servidor, puerto ${info.listenPort || 51820}`;
        body.innerHTML = `
            <dl class="enc-rows" style="margin-bottom:1rem;">
                <dt>IP del router</dt><dd>${escapeHtml(enc.vpn_ip)}</dd>
                <dt>LAN del sitio</dt><dd>${escapeHtml(enc.vpn_lan || '— (sólo el router)')}</dd>
                <dt>Servidor</dt><dd>${escapeHtml(endpoint)} (UDP)</dd>
            </dl>
            <ol class="enc-steps">
                <li>Descarga el archivo y, en el router, ve a <em>VPN → WireGuard</em> e impórtalo (o copia los campos a mano).</li>
                <li>Conecta el encoder por cable a un puerto LAN del router${enc.vpn_lan ? ` y comprueba que la LAN del router es <strong>${escapeHtml(enc.vpn_lan)}</strong>` : ''}.</li>
                <li>Permite el tráfico del túnel hacia la LAN (en Teltonika: zona del túnel con <em>forward</em> a <em>lan</em>).</li>
                <li>En el encoder: SRT en modo <strong>Caller</strong> hacia el servidor y el puerto de su entrada.</li>
            </ol>
            ${!info.endpoint ? '<p class="enc-warn"><i class="fa-solid fa-triangle-exclamation"></i> No hay WG_ENDPOINT configurado: en el archivo aparece IP_PUBLICA_DEL_SERVIDOR y tendrás que cambiarla.</p>' : ''}
            <div class="modal-actions">
                <button type="button" class="btn-secondary" onclick="removeEncoderVpn(${enc.id})"><i class="fa-solid fa-ban"></i> Quitar acceso</button>
                <a class="btn-primary" href="/api/encoders/${enc.id}/wireguard.conf" download><i class="fa-solid fa-download"></i> Descargar configuración</a>
            </div>`;
    } else if (!info.available) {
        body.innerHTML = `<p class="enc-warn"><i class="fa-solid fa-triangle-exclamation"></i> WireGuard no está disponible: ${escapeHtml(info.reason || 'desconocido')}.</p>
            <p class="enc-muted" style="margin-top:0.75rem;">Actívalo volviendo a ejecutar <code>sudo bash instalar_servidor.sh</code> y respondiendo que sí a WireGuard. En Docker la VPN se gestiona en el propio host.</p>`;
    } else {
        body.innerHTML = `
            <p class="enc-muted" style="margin-bottom:1rem;">Se crea un acceso para el router del sitio: el servidor le asigna una IP en el túnel (${escapeHtml(info.subnet)}) y genera sus claves.</p>
            <form onsubmit="createEncoderVpn(event, ${enc.id})">
                <div class="form-group">
                    <label>Red LAN del router del sitio (opcional)</label>
                    <input type="text" id="vpn_lan" placeholder="192.168.101.0/24" pattern="\\d{1,3}(\\.\\d{1,3}){3}/\\d{1,2}">
                    <small class="enc-muted" style="display:block; margin-top:5px;">Cada sitio necesita una LAN distinta (192.168.101.0/24, 192.168.102.0/24…). Déjala vacía si el router redirige el puerto web del encoder a su IP del túnel.</small>
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn-secondary" onclick="closeModal('encoderVpnModal')">Cancelar</button>
                    <button type="submit" class="btn-primary"><i class="fa-solid fa-key"></i> Crear acceso</button>
                </div>
            </form>`;
    }
    openModal('encoderVpnModal');
}

async function createEncoderVpn(e, id) {
    e.preventDefault();
    const res = await fetch(`/api/encoders/${id}/vpn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lan: document.getElementById('vpn_lan').value })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error || 'No se pudo crear el acceso');
    if (data.warnings && data.warnings.length) toast('Acceso creado, con avisos:\n\n' + data.warnings.join('\n'));
    await fetchEncoders();
    openEncoderVpn(id);
}

async function removeEncoderVpn(id) {
    if (!confirm('¿Quitar el acceso WireGuard? El router dejará de conectar hasta que crees uno nuevo y lo importes.')) return;
    const res = await fetch(`/api/encoders/${id}/vpn`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); return toast(d.error || 'No se pudo quitar'); }
    closeModal('encoderVpnModal');
    fetchEncoders();
}


/* =======================================
 *  MINIGRÁFICOS DE BITRATE (último minuto) Y AVISOS DE SEÑAL
 * ======================================= */
const SPARK_POINTS = 60;
const sparkBuf = {}; // 'canal' | 'out_id' -> [kbps...]

function kbpsOf(str) {
    const v = parseFloat(str) || 0;
    if (/mbit|mbps/i.test(str)) return v * 1000;
    return v;
}
function pushSpark(key, kbps) {
    const b = sparkBuf[key] || (sparkBuf[key] = []);
    b.push(kbps);
    if (b.length > SPARK_POINTS) b.shift();
    const svg = document.querySelector(`svg.spark[data-key="${key}"]`);
    if (svg) drawSpark(svg, b);
}
function redrawSparks(root) {
    root.querySelectorAll('svg.spark').forEach(svg => drawSpark(svg, sparkBuf[svg.dataset.key] || []));
}
function drawSpark(svg, buf) {
    const line = svg.querySelector('.spark-line');
    const area = svg.querySelector('.spark-area');
    if (buf.length < 2) { line.setAttribute('d', ''); area.setAttribute('d', ''); return; }
    const max = Math.max(...buf, 1) * 1.15;
    const step = 120 / (SPARK_POINTS - 1);
    const x0 = 120 - (buf.length - 1) * step; // los datos entran por la derecha
    const pts = buf.map((v, i) => [x0 + i * step, 27 - (v / max) * 25]);
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    line.setAttribute('d', d);
    area.setAttribute('d', `${d} L120 28 L${x0.toFixed(1)} 28 Z`);
}

// Aviso cuando una entrada pierde la señal (3 s seguidos sin datos) o la recupera
const SIGNAL_LOST_MS = 3000;
const signalAlerts = {}; // canal -> { has, lowSince }
function trackSignal(data) {
    const key = String(data.channel);
    if (key.startsWith('out_')) return; // sólo entradas: las salidas dependen de su entrada
    const inp = inputs.find(i => String(i.channel) === key);
    if (!inp || !inp.enabled) { delete signalAlerts[key]; return; }
    const has = data.active && kbpsOf(data.bitrate) > 0;
    const st = signalAlerts[key];
    const name = inp.name || 'Entrada ' + key;
    if (!st) { signalAlerts[key] = { has, lowSince: has ? 0 : Date.now() }; return; } // primer dato: sin aviso
    if (has) {
        if (!st.has) toast(`Señal recuperada · ${name}`, 'ok');
        st.has = true; st.lowSince = 0;
    } else if (st.has) {
        st.lowSince = st.lowSince || Date.now();
        if (Date.now() - st.lowSince >= SIGNAL_LOST_MS) {
            st.has = false;
            toast(`Sin señal · ${name}`, 'warn');
        }
    }
}

/* =======================================
 *  HOJAS INFERIORES EN EL MÓVIL: se arrastran con el dedo y se lanzan para cerrar
 * ======================================= */
const sheetMQ = window.matchMedia('(max-width: 768px)');
const reduceMotionMQ = window.matchMedia('(prefers-reduced-motion: reduce)');

// Muelle críticamente amortiguado (damping 1, sin rebote) que hereda la velocidad del dedo
function springTo(from, to, velocity, onUpdate, onDone, response = 0.32, damping = 1) {
    const k = Math.pow(2 * Math.PI / response, 2);
    const c = 4 * Math.PI * damping / response;
    let x = from, v = velocity, last = performance.now();
    function frame(now) {
        const dt = Math.min(0.032, (now - last) / 1000);
        last = now;
        for (let i = 0; i < 4; i++) { // subpasos: integración estable
            const a = -k * (x - to) - c * v;
            v += a * dt / 4;
            x += v * dt / 4;
        }
        onUpdate(x);
        if (Math.abs(x - to) < 0.5 && Math.abs(v) < 20) { onUpdate(to); onDone && onDone(); return; }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}
// Proyección del gesto (la misma que usa iOS para el desplazamiento por inercia)
const projectFling = (v, rate = 0.998) => (v / 1000) * rate / (1 - rate);
// Resistencia progresiva al tirar hacia arriba
const rubberband = (o, dim, c = 0.55) => (o * dim * c) / (dim + c * Math.abs(o));

function initSheets() {
    document.querySelectorAll('.modal-overlay').forEach(ov => {
        const sheet = ov.querySelector('.modal');
        if (!sheet || sheet.querySelector('.sheet-grabber')) return;
        const grabber = document.createElement('div');
        grabber.className = 'sheet-grabber';
        grabber.setAttribute('aria-hidden', 'true');
        sheet.prepend(grabber);
        const handles = [grabber, sheet.querySelector('.modal-header')].filter(Boolean);
        handles.forEach(h => h.addEventListener('pointerdown', e => startSheetDrag(e, ov, sheet)));
    });
}

function startSheetDrag(e, ov, sheet) {
    if (!sheetMQ.matches || e.button > 0 || e.target.closest('button, a, input, select')) return;
    const h = sheet.getBoundingClientRect().height;
    const startY = e.clientY;
    const samples = [{ y: 0, t: performance.now() }];
    let y = 0;
    sheet.setPointerCapture(e.pointerId);
    sheet.style.animation = 'none';
    sheet.style.transition = 'none';
    const apply = (val) => {
        y = val;
        sheet.style.transform = `translateY(${val}px)`;
        const p = Math.max(0, Math.min(1, 1 - val / h));
        ov.style.backgroundColor = `rgba(0,0,0,${(0.6 * p).toFixed(3)})`;
    };
    const move = (ev) => {
        const dy = ev.clientY - startY;
        apply(dy >= 0 ? dy : rubberband(dy, h));
        samples.push({ y: dy, t: performance.now() });
        if (samples.length > 6) samples.shift();
    };
    const up = () => {
        sheet.removeEventListener('pointermove', move);
        sheet.removeEventListener('pointerup', up);
        sheet.removeEventListener('pointercancel', up);
        const a = samples[0], b = samples[samples.length - 1];
        const v = b.t > a.t ? (b.y - a.y) / ((b.t - a.t) / 1000) : 0; // px/s al soltar
        const projected = y + projectFling(v);
        const close = projected > h * 0.5 && v > -200;
        const reset = () => { sheet.style.transform = ''; sheet.style.animation = ''; sheet.style.transition = ''; ov.style.backgroundColor = ''; };
        if (close) {
            springTo(y, h + 20, v, apply, () => {
                ov._instantClose = true;
                closeModalById(ov.id);
                reset();
            }, 0.3);
        } else {
            springTo(y, 0, v, apply, reset, 0.35);
        }
    };
    sheet.addEventListener('pointermove', move);
    sheet.addEventListener('pointerup', up);
    sheet.addEventListener('pointercancel', up);
}
document.addEventListener('DOMContentLoaded', initSheets);
if (document.readyState !== 'loading') initSheets();

/* =======================================
 *  VISTA DE SEÑALES: LISTA O MOSAICO (se recuerda en este navegador)
 * ======================================= */
function setStreamsView(mode) {
    if (mode !== 'grid') mode = 'list';
    document.getElementById('streamsContainer').classList.toggle('view-grid', mode === 'grid');
    document.querySelectorAll('#view-toggle button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === mode)));
    try { localStorage.setItem('streamsView', mode); } catch (e) {}
}
document.addEventListener('DOMContentLoaded', () => {
    let mode = 'list';
    try { mode = localStorage.getItem('streamsView') || 'list'; } catch (e) {}
    setStreamsView(mode);
});
