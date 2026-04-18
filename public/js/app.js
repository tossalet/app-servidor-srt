const socket = io();

// State
let inputs = [];
let outputs = [];
let telemetryChart = null;
let selectedAnalyticsChannels = new Set();
let frontendTelemetryCache = {};
let serverIp = window.location.hostname;
const chartColors = ['#60A5FA', '#34d399', '#f87171', '#fbbf24', '#c084fc', '#f472b6', '#38bdf8', '#a3e635'];

// SPA Navigation
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
    fetchData();
    initChart();

    // Socket listeners
    socket.on('db_update', (data) => {
        console.log("DB Update:", data.event);
        fetchData();
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
        if (data.codec) {
            const codecElem = document.getElementById(`codec-${data.channel}`);
            if (codecElem && data.codec.length > 0) codecElem.innerText = data.codec;
        }

        // Backend pushes historical telemetry for each update
        if (data.history) {
            frontendTelemetryCache[data.channel.toString()] = data.history;
            if (selectedAnalyticsChannels.has(data.channel.toString())) {
                updateTelemetryChart();
            }
        }
    });



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
                            <span style="font-size:0.70rem; color:var(--accent-blue); font-family:monospace; font-weight:normal; user-select:all;">${input.url.replace(/127\.0\.0\.1|0\.0\.0\.0/g, serverIp)}</span>
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
                        <div style="position:relative; width:160px; height:90px; border-radius:6px; overflow:hidden; border:1px solid rgba(255,255,255,0.1); box-shadow: 0 4px 10px rgba(0,0,0,0.5);">
                            <img class="${input.preview_enabled && input.enabled ? 'preview-active' : ''}" data-src="/thumbs/thumb_${input.channel}.jpg" src="${input.enabled ? '/thumbs/thumb_' + input.channel + '.jpg' + (input.preview_enabled ? '?t=' + Date.now() : '') : '/images/bars.svg'}" onerror="this.onerror=null; this.src='/images/bars.svg';" style="width:100%; height:100%; object-fit:cover; filter: ${input.preview_enabled && input.enabled ? 'none' : 'grayscale(100%) opacity(40%) blur(1px)'}; transition: filter 0.3s;" />
                            <button onclick="togglePreview(${input.channel})" class="action-btn" style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); background:rgba(0,0,0,0.6); padding:8px 12px; border:none; color:${input.preview_enabled ? 'var(--color-green)' : '#fff'}; border-radius:4px; font-size:1.2rem; cursor:pointer; opacity: 0.8; transition:0.2s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.8" title="${input.preview_enabled ? 'Desactivar Previsualización (Ahorro CPU)' : 'Activar Previsualización'}">
                                <i class="fa-solid ${input.preview_enabled ? 'fa-eye' : 'fa-eye-slash'}"></i>
                            </button>
                        </div>
                        <div style="font-size:0.85rem; color:var(--text-muted); line-height: 1.4; display:flex; flex-direction:column; gap:5px;">
                            <p><strong>Parámetros de Recepción:</strong></p>
                            <div style="display:flex; align-items:center; gap: 10px;">
                                <span class="badge-protocol ${protocolBadge === 'srt' ? 'udp' : 'rtmp'}">${protocolBadge === 'srt' ? 'Buffer SRT' : 'Buffer N/A'}</span>
                                <span style="color:#fff; font-weight:600;">${latencyText}</span>
                                ${protocolBadge === 'srt' ? `<button onclick="editLatency(${input.channel}, '${input.url}')" style="background:transparent; border:none; color:var(--accent-blue); cursor:pointer; font-size:0.9rem;" title="Editar Latencia del Stream"><i class="fa-solid fa-pen"></i></button>` : ''}
                            </div>
                            <p style="font-size: 0.75rem; margin-top: 2px; opacity:0.7;">Optimiza este valor según el retardo de la red (${protocolBadge === 'srt' ? '120ms recomendado' : 'Sólo configurable en SRT'}).</p>
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
                                    ${out.location || out.url}
                                    <span style="font-size:0.70rem; color:var(--text-muted); font-family:monospace; font-weight:normal; user-select:all;">${out.url.replace(/127\.0\.0\.1|0\.0\.0\.0/g, serverIp)}</span>
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
}

// Modal Logic
function openModal(id) {
    document.getElementById(id).style.display = 'flex';
}
function closeModal(id) {
    document.getElementById(id).style.display = 'none';
}
function openOutputModal(channel) {
    document.getElementById('out_channel').value = channel;
    document.getElementById('out_is_edit').value = 'false';
    document.querySelector('#outputModal .modal-header h3').innerText = 'Add Output';
    document.getElementById('formOutput').reset();
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
    document.getElementById('inp_name').value = input.name;
    // Watchdog config fields removed
    
    // Parse url broadly
    if (input.url.startsWith('srt')) {
        document.getElementById('inp_protocol').value = 'srt';
        const isListener = input.url.includes('mode=listener');
        document.getElementById('inp_mode').value = isListener ? 'listener' : 'caller';
        const portMatch = input.url.match(/:(\d+)/);
        if(portMatch) document.getElementById('inp_port').value = portMatch[1];
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

function editLatency(channelId, currentUrl) {
    let currentLatency = '';
    const match = currentUrl.match(/latency=(\d+)/);
    if (match) currentLatency = match[1];

    document.getElementById('lat_channel').value = channelId;
    document.getElementById('lat_current_url').value = currentUrl;
    document.getElementById('lat_value').value = currentLatency;
    
    openModal('latencyModal');
}

async function submitLatency(e) {
    e.preventDefault();
    const channelId = parseInt(document.getElementById('lat_channel').value);
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

    const inputData = inputs.find(i => i.channel === channelId);
    if (!inputData) return;

    try {
        await fetch(`/api/inputs/${channelId}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                url: newUrl,
                name: inputData.name
            })
        });
        closeModal('latencyModal');
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
const oldCloseModal = closeModal;
closeModal = function(id) {
    if (id === 'previewModal') {
        const video = document.getElementById('previewVideo');
        video.pause();
        video.src = "";
    }
    oldCloseModal(id);
};


function openEditOutput(id) {
    const out = outputs.find(o => o.id === id);
    if (!out) return;
    
    document.getElementById('out_is_edit').value = 'true';
    document.getElementById('out_edit_id').value = id;
    document.getElementById('out_location').value = out.location;
    document.getElementById('out_vcodec').value = out.vcodec || 'copy';
    
    // Parse url broadly
    if (out.url.startsWith('srt')) {
        document.getElementById('out_protocol').value = 'srt';
        const isListener = out.url.includes('mode=listener');
        document.getElementById('out_mode').value = isListener ? 'listener' : 'caller';
        const portMatch = out.url.match(/:(\d+)/);
        if(portMatch) document.getElementById('out_port').value = portMatch[1];
        if(!isListener) {
            const ipMatch = out.url.match(/\/\/([^:]+)/);
            if(ipMatch) document.getElementById('out_ip').value = ipMatch[1];
        }
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
        const mode = document.getElementById('inp_mode').value;
        const ip = (mode === 'listener') ? '0.0.0.0' : document.getElementById('inp_ip').value;
        outUrl = `srt://${ip}:${port}?mode=${mode}`;
    } else if (proto === 'udp') {
        const ip = document.getElementById('inp_ip').value || '0.0.0.0';
        outUrl = `udp://${ip}:${port}`;
    } else if (proto === 'rtmp') {
        const ip = document.getElementById('inp_ip').value; // e.g. rtmp://x.com/live
        const key = document.getElementById('inp_port').value; // e.g. xyz
        outUrl = ip.endsWith('/') ? `${ip}${key}` : `${ip}/${key}`;
    } else if (proto === 'rtmp_local') {
        const key = document.getElementById('inp_port').value || 'canal_1';
        outUrl = `rtmp://127.0.0.1:1935/live/${key}`;
    } else {
        outUrl = document.getElementById('inp_ip').value || '';
    }

    const data = {
        name: document.getElementById('inp_name').value,
        url: outUrl
    };
    
    const isEdit = document.getElementById('inp_is_edit').value === 'true';
    if(isEdit) {
        const cId = document.getElementById('inp_edit_channel').value;
        await fetch(`/api/inputs/${cId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
        });
    } else {
        await fetch('/api/inputs', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
        });
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
        outUrl = `rtmp://127.0.0.1:1935/out/${key}`;
    } else if (proto === 'srt') {
        const mode = document.getElementById('out_mode').value;
        const ip = (mode === 'listener') ? '0.0.0.0' : document.getElementById('out_ip').value;
        outUrl = `srt://${ip}:${port}?mode=${mode}`;
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
    if(isEdit) {
        const oId = document.getElementById('out_edit_id').value;
        await fetch(`/api/outputs/${oId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
        });
    } else {
        await fetch('/api/outputs', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
        });
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
        }

        // Render Users
        const container = document.getElementById('usersListContainer');
        container.innerHTML = '';
        users.forEach(u => {
            const roleBadge = u.role === 4 ? '<span style="color:var(--color-red); font-weight:bold;">Admin</span>' : '<span style="color:var(--text-muted);">User</span>';
            container.innerHTML += `
                <div style="display:flex; justify-content:space-between; align-items:center; padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <div>
                        <strong style="color:var(--text-main); font-size:1.05rem;">${u.username}</strong>
                        <div style="font-size:0.8rem; margin-top:2px;">Role: ${roleBadge} | ${u.email || 'No email'}</div>
                    </div>
                    <button class="action-btn terminate" onclick="deleteUser('${u.username}')" title="Borrar Cuenta" ${u.username==='admin'?'disabled':''}>
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            `;
        });
    } catch(e) { console.error("Error fetching settings:", e); }
}

async function savePorts(e) {
    e.preventDefault();
    const payload = {
        chanMin: parseInt(document.getElementById('cfg_chanMin').value),
        chanMax: parseInt(document.getElementById('cfg_chanMax').value),
        udpMin: parseInt(document.getElementById('cfg_udpMin').value),
        udpMax: parseInt(document.getElementById('cfg_udpMax').value)
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
    const payload = {
        username: document.getElementById('usr_username').value,
        password: document.getElementById('usr_password').value,
        role: parseInt(document.getElementById('usr_role').value),
        email: document.getElementById('usr_email').value
    };
    try {
        const res = await fetch('/api/users', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        if(res.ok) {
            closeModal('userModal');
            fetchSettingsData();
        } else {
            const err = await res.json();
            alert('Error al crear usuario: ' + err.error);
        }
    } catch(e) { console.error(e); }
}

async function deleteUser(username) {
    if(!confirm(`¿Borrar definitivamente a ${username}?`)) return;
    try {
        await fetch(`/api/users/${username}`, { method: 'DELETE' });
        fetchSettingsData();
    } catch(e) { console.error(e); }
}

async function toggleInput(channel) {
    await fetch(`/api/inputs/${channel}/toggle`, { method: 'POST' });
    fetchData();
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
