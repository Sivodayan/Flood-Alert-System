/* =========================================================
   CORE STATE & CONFIGURATION
   ========================================================= */
const appState = {
  nodeHost: 'localhost:3000',
  mlHost: 'localhost:8001',
  sensorId: 'sensor_01',

  waterLevelCm: 0,
  maxScaleCm: 70.0,            // Gauge scale maximum (cm)
  alertThresholdCm: 35.0,      // Warning mark
  dangerThresholdCm: 50.0,     // Danger mark matches ML service hardcoded limit

  riseRateCmMin: 0.0,
  buzzerActive: false,
  buzzerManualOverride: false,
  audioMuted: false,

  packetCount: 0,
  ws: null,
  chart: null,
  mlPollTimer: null
};

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const ICON_SOUND = '<svg viewBox="0 0 18 16" width="18" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6h2.8L9.5 2.8v10.4L5.3 10H2.5z"/><path d="M12 5.5a3.6 3.6 0 0 1 0 5"/><path d="M14 3.6a6.3 6.3 0 0 1 0 8.8"/></svg>';
const ICON_MUTE  = '<svg viewBox="0 0 18 16" width="18" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6h2.8L9.5 2.8v10.4L5.3 10H2.5z"/><path d="M12.5 5.5l4 5M16.5 5.5l-4 5"/></svg>';

/* =========================================================
   AUDIO SYNTHESIZER (SIREN)
   ========================================================= */
let audioCtx = null;
let sirenOsc = null;
let sirenGain = null;
let sirenTimer = null;

function initAudio() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function toggleAudioMute() {
  appState.audioMuted = !appState.audioMuted;
  const text = document.getElementById('audio-text');
  const icon = document.getElementById('audio-icon');

  if (appState.audioMuted) {
    text.innerText = 'Audio muted';
    icon.innerHTML = ICON_MUTE;
    stopSirenTone();
  } else {
    text.innerText = 'Audio armed';
    icon.innerHTML = ICON_SOUND;
    initAudio();
    if (appState.buzzerActive) {
      startSirenTone();
    }
  }
}

function startSirenTone() {
  if (appState.audioMuted) return;
  initAudio();
  stopSirenTone();

  sirenOsc = audioCtx.createOscillator();
  sirenGain = audioCtx.createGain();

  sirenOsc.type = 'sawtooth';
  sirenOsc.frequency.setValueAtTime(800, audioCtx.currentTime);
  sirenGain.gain.setValueAtTime(0.2, audioCtx.currentTime);

  sirenOsc.connect(sirenGain);
  sirenGain.connect(audioCtx.destination);
  sirenOsc.start();

  let toggle = false;
  sirenTimer = setInterval(() => {
    if (!sirenOsc || !sirenGain) return;
    toggle = !toggle;
    sirenOsc.frequency.setValueAtTime(toggle ? 1150 : 700, audioCtx.currentTime);
  }, 400);
}

function stopSirenTone() {
  if (sirenTimer) {
    clearInterval(sirenTimer);
    sirenTimer = null;
  }
  if (sirenOsc) {
    try {
      sirenOsc.stop();
      sirenOsc.disconnect();
    } catch(e) {}
    sirenOsc = null;
  }
}

/* =========================================================
   STAFF GAUGE RENDERING
   ========================================================= */
function buildRuler() {
  const max = appState.maxScaleCm;
  const H = Math.round(max);
  const svg = document.getElementById('ruler-svg');
  svg.setAttribute('viewBox', `0 0 84 ${H}`);

  let lines = '';
  for (let i = 0; i <= max; i += 2) {
    const y = (H - i).toFixed(1);
    let len = 8, cls = '';
    if (i % 10 === 0) { len = 30; cls = ' class="major"'; }
    else if (i % 5 === 0) { len = 18; }
    lines += `<line${cls} x1="0" x2="${len}" y1="${y}" y2="${y}"/>`;
  }
  svg.innerHTML = lines;

  const ruler = document.getElementById('ruler');
  ruler.querySelectorAll('.tick-label').forEach(el => el.remove());

  for (let v = 0; v <= max; v += 10) {
    const label = document.createElement('div');
    label.className = 'tick-label' + (v === 0 ? ' base' : '');
    label.style.bottom = (v / max * 100) + '%';
    label.innerHTML = `${v}<small>cm</small>`;
    ruler.appendChild(label);
  }
}

function positionThresholdMarkers() {
  const max = appState.maxScaleCm;
  const alertPct = Math.min(100, (appState.alertThresholdCm / max) * 100);
  const critPct  = Math.min(100, (appState.dangerThresholdCm / max) * 100);

  const a = document.getElementById('marker-alert');
  const c = document.getElementById('marker-crit');
  a.style.bottom = alertPct + '%';
  c.style.bottom = critPct + '%';
  a.querySelector('span').textContent = `Alert (${appState.alertThresholdCm.toFixed(1)} cm)`;
  c.querySelector('span').textContent = `Danger (${appState.dangerThresholdCm.toFixed(1)} cm)`;

  document.getElementById('zone-strip').style.background =
    `linear-gradient(to top,
      ${cssVar('--ok')} 0, ${cssVar('--ok')} ${alertPct}%,
      ${cssVar('--warn')} ${alertPct}%, ${cssVar('--warn')} ${critPct}%,
      ${cssVar('--crit')} ${critPct}%, ${cssVar('--crit')} 100%)`;
}

/* =========================================================
   UI UPDATER & ALERT LOGIC
   ========================================================= */
function updateTelemetry(reading) {
  const level = parseFloat(reading.water_level);
  if (isNaN(level)) return;

  appState.waterLevelCm = level;
  appState.packetCount++;

  if (reading.water_rising_level !== undefined && reading.water_rising_level !== null) {
    appState.riseRateCmMin = parseFloat(reading.water_rising_level);
  }

  // Automatic Audible Siren Trip at Danger Level
  if (!appState.buzzerManualOverride) {
    if (appState.waterLevelCm >= appState.dangerThresholdCm && !appState.buzzerActive) {
      setBuzzerState(true, `Level (${appState.waterLevelCm} cm) >= ${appState.dangerThresholdCm} cm Danger Mark`);
    } else if (appState.waterLevelCm < appState.dangerThresholdCm && appState.buzzerActive) {
      setBuzzerState(false, `Level (${appState.waterLevelCm} cm) normalized`);
    }
  }

  renderUI();
  appendChartPoint(appState.waterLevelCm, reading.recorded_at);
}

function renderUI() {
  // 1. Digital Water Level Readout
  document.getElementById('disp-water-level').innerText = appState.waterLevelCm.toFixed(1);
  document.getElementById('gauge-level-tag').innerText = appState.waterLevelCm.toFixed(1);

  const freeboard = Math.max(0, appState.dangerThresholdCm - appState.waterLevelCm).toFixed(1);
  document.getElementById('disp-freeboard-val').innerText = `${freeboard} cm to danger`;

  // 2. Animated Tank Level Height
  const percent = Math.min(100, Math.max(3, (appState.waterLevelCm / appState.maxScaleCm) * 100));
  document.getElementById('tank-water-body').style.height = `${percent.toFixed(1)}%`;

  // 3. Status Level Categorization
  const headText = document.getElementById('status-header-text');
  const headSub = document.getElementById('status-header-sub');
  const badge = document.getElementById('card-level-badge');

  if (appState.waterLevelCm >= appState.dangerThresholdCm) {
    document.body.dataset.level = 'critical';
    headText.innerText = 'CRITICAL DANGER : FLOOD LEVEL EXCEEDED';
    headSub.innerText = 'Water level has breached the 50cm threshold. Evacuate immediately.';
    badge.innerText = 'Danger';
  } else if (appState.waterLevelCm >= appState.alertThresholdCm) {
    document.body.dataset.level = 'alert';
    headText.innerText = 'WARNING ALERT : WATER STAGE ELEVATED';
    headSub.innerText = 'Water approaching embankment crest. Prepare precautionary procedures.';
    badge.innerText = 'Alert';
  } else {
    document.body.dataset.level = 'safe';
    headText.innerText = 'NORMAL CONDITIONS : WATER LEVEL NOMINAL';
    headSub.innerText = 'Sensor telemetry steady. Embankment and drainage channels free.';
    badge.innerText = 'Safe';
  }

  // 4. Rate of Rise Readout
  const rateCell = document.getElementById('cell-rate');
  const rateEl = document.getElementById('disp-rise-rate');
  const arrowEl = document.getElementById('disp-rise-arrow');
  const sign = appState.riseRateCmMin >= 0 ? '+' : '';
  rateEl.innerText = `${sign}${appState.riseRateCmMin.toFixed(1)}`;

  if (appState.riseRateCmMin >= 2.0) {
    rateCell.dataset.rate = 'surge';
    arrowEl.innerHTML = '<span>▲▲</span> Surge';
  } else if (appState.riseRateCmMin >= 0.5) {
    rateCell.dataset.rate = 'rising';
    arrowEl.innerHTML = '<span>▲</span> Rising';
  } else if (appState.riseRateCmMin <= -0.3) {
    rateCell.dataset.rate = 'receding';
    arrowEl.innerHTML = '<span>▼</span> Receding';
  } else {
    rateCell.dataset.rate = 'steady';
    arrowEl.innerHTML = '<span>•</span> Steady';
  }

  // 5. Packet Counter
  document.getElementById('terminal-packet-counter').innerText = `Packets Received: ${appState.packetCount}`;
}

/* =========================================================
   BUZZER & SIREN CONTROL
   ========================================================= */
function setBuzzerState(active, reason = '') {
  appState.buzzerActive = active;
  const cell = document.getElementById('cell-buzzer');
  const text = document.getElementById('buzzer-status-text');
  const relay = document.getElementById('buzzer-relay-state');
  const btn = document.getElementById('btn-buzzer-override');

  cell.dataset.on = active ? 'true' : 'false';

  if (active) {
    text.innerText = 'Siren Active';
    relay.innerText = 'SIREN: ON';
    btn.innerText = 'Silence Siren';
    btn.classList.add('is-on');

    startSirenTone();
    appendTerminalLog(`[ALARM] Siren Triggered: ${reason}`, 'log-crit log-strong');
  } else {
    text.innerText = 'Standby';
    relay.innerText = 'SIREN: OFF';
    btn.innerText = 'Test Siren';
    btn.classList.remove('is-on');

    stopSirenTone();
    appendTerminalLog(`[ALARM] Siren Disarmed: ${reason}`, 'log-muted');
  }
}

function toggleBuzzerManual() {
  appState.buzzerManualOverride = true;
  setBuzzerState(!appState.buzzerActive, 'Manual Operator Click');
}

/* =========================================================
   NODE BACKEND REST & WEBSOCKET INTEGRATION
   ========================================================= */
// 1. Fetch History on startup / sensor switch
async function fetchHistory(sensorId = appState.sensorId, limit = 30) {
  try {
    const url = `http://${appState.nodeHost}/api/history?sensor_id=${sensorId}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const readings = await res.json();

    if (Array.isArray(readings) && readings.length > 0) {
      appendTerminalLog(`[REST] Loaded ${readings.length} historical readings for ${sensorId}`, 'log-ok');
      
      const labels = readings.map(r => new Date(r.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      const levels = readings.map(r => r.water_level);
      const alertLine = new Array(readings.length).fill(appState.alertThresholdCm);
      const dangerLine = new Array(readings.length).fill(appState.dangerThresholdCm);

      appState.chart.data.labels = labels;
      appState.chart.data.datasets[0].data = levels;
      appState.chart.data.datasets[1].data = alertLine;
      appState.chart.data.datasets[2].data = dangerLine;
      appState.chart.update();

      // Workaround for commented-out /api/latest endpoint: Pick last array item
      const latestReading = readings[readings.length - 1];
      updateTelemetry(latestReading);
    } else {
      appendTerminalLog(`[REST] No history returned for ${sensorId}`, 'log-warn');
    }
  } catch (err) {
    appendTerminalLog(`[REST ERROR] History fetch failed: ${err.message}`, 'log-crit');
  }
}

// 2. Connect Live WebSocket Broadcast Feed
function initWebSocket() {
  const statusEl = document.getElementById('hdr-connection-status');
  if (appState.ws) {
    try { appState.ws.close(); } catch(e) {}
  }

  const wsUrl = `ws://${appState.nodeHost}`;
  appendTerminalLog(`[WS] Connecting to ${wsUrl}...`, 'log-sim');

  appState.ws = new WebSocket(wsUrl);

  appState.ws.onopen = () => {
    statusEl.innerHTML = '<i class="dot live"></i> Online (WebSocket)';
    appendTerminalLog(`[WS] Connected to live event stream`, 'log-ok log-strong');
  };

  appState.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'reading') {
        if (msg.sensor_id === appState.sensorId) {
          updateTelemetry(msg);
          appendTerminalLog(`[WS RX] ${msg.sensor_id} -> ${msg.water_level} cm (dY: ${msg.water_rising_level ?? 0} cm/min)`, 'log-info');
        }
      }
    } catch (e) {
      console.error('WS Parse Error', e);
    }
  };

  appState.ws.onclose = () => {
    statusEl.innerHTML = '<i class="dot" style="background:var(--crit)"></i> Offline (Reconnecting...)';
    appendTerminalLog(`[WS] Connection closed. Retrying in 3s...`, 'log-warn');
    setTimeout(() => {
      if (!appState.ws || appState.ws.readyState === WebSocket.CLOSED) {
        initWebSocket();
      }
    }, 3000);
  };

  appState.ws.onerror = (err) => {
    console.error('WebSocket Error', err);
    try { appState.ws.close(); } catch(e) {}
  };
}

// 3. FastAPI Machine Learning Predict Service
async function fetchPredictions(sensorId = appState.sensorId) {
  const etaDisplay = document.getElementById('stat-crest-eta');
  const fitDisplay = document.getElementById('stat-ml-fit');

  try {
    const res = await fetch(`http://${appState.mlHost}/predict?sensor_id=${sensorId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    switch (data.status) {
      case 'ok':
        etaDisplay.innerText = `${data.eta_minutes.toFixed(1)} mins`;
        fitDisplay.innerText = `${Math.round(data.r_squared * 100)}%`;
        fitDisplay.className = data.r_squared > 0.7 ? 'v ok' : 'v warn';
        document.getElementById('sms-payload-eta').innerText = `${data.eta_minutes.toFixed(1)} minutes`;
        break;
      case 'not_rising':
        etaDisplay.innerText = 'Stable (Not rising)';
        fitDisplay.innerText = data.r_squared !== undefined ? `${Math.round(data.r_squared * 100)}%` : '--';
        fitDisplay.className = 'v';
        break;
      case 'already_danger':
        etaDisplay.innerText = 'DANGER REACHED';
        fitDisplay.innerText = '100%';
        fitDisplay.className = 'v log-crit';
        break;
      case 'not_enough_data':
        etaDisplay.innerText = 'Gathering points...';
        fitDisplay.innerText = '--';
        fitDisplay.className = 'v';
        break;
      default:
        etaDisplay.innerText = 'Unavailable';
        fitDisplay.innerText = '--';
    }
  } catch (err) {
    etaDisplay.innerText = 'Service down';
    fitDisplay.innerText = '--';
  }
}

// 4. SMS Dispatch Integration (POST /api/alert)
async function triggerManualSmsBroadcast() {
  const badge = document.getElementById('sms-badge-status');
  badge.dataset.tone = 'sending';
  badge.innerText = 'Sending...';

  const alertPayload = {
    alert: 'DANGER',
    ETA: document.getElementById('sms-payload-eta').innerText || '15 minutes',
    location: document.getElementById('sms-payload-location').innerText || 'Riverside Colony'
  };

  appendTerminalLog(`[REST] Dispatching POST /api/alert: ${JSON.stringify(alertPayload)}`, 'log-warn log-strong');

  try {
    const res = await fetch(`http://${appState.nodeHost}/api/alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alertPayload)
    });
    const result = await res.json();

    badge.dataset.tone = 'done';
    badge.innerText = `Sent (${result.status})`;
    appendTerminalLog(`[REST] Alert response status: ${result.status}`, 'log-ok log-strong');
  } catch (err) {
    badge.dataset.tone = 'ready';
    badge.innerText = 'Failed';
    appendTerminalLog(`[REST ERROR] /api/alert call failed: ${err.message}`, 'log-crit log-strong');
  }
}

// 5. Test Reading Poster (POST /api/readings)
async function simulatePostReading(deltaCm) {
  const newLevel = Math.max(2, appState.waterLevelCm + deltaCm);
  const payload = {
    sensor_id: appState.sensorId,
    water_level: +newLevel.toFixed(1),
    water_rising_level: +(deltaCm * 0.4).toFixed(1)
  };

  appendTerminalLog(`[REST] Simulating sensor POST /api/readings -> ${payload.water_level} cm`, 'log-sim');

  try {
    const res = await fetch(`http://${appState.nodeHost}/api/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    appendTerminalLog(`[REST ERROR] Sensor simulation POST failed: ${err.message}`, 'log-crit');
  }
}

/* =========================================================
   HYDROGRAPH CHART (Chart.js)
   ========================================================= */
function initChart() {
  const ctx = document.getElementById('liveHydroChart').getContext('2d');

  const cLevel = cssVar('--link');
  const cWarn = cssVar('--warn');
  const cCrit = cssVar('--crit');
  const cInk3 = cssVar('--ink-3');
  const cRule = cssVar('--rule');
  const bodyFont = "'Source Sans 3', system-ui, sans-serif";

  appState.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Water Stage (cm)',
          data: [],
          borderColor: cLevel,
          backgroundColor: cLevel + '1f',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 2,
          pointHoverRadius: 4,
          pointBackgroundColor: cLevel
        },
        {
          label: 'Alert Threshold (35 cm)',
          data: [],
          borderColor: cWarn,
          borderWidth: 1.25,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'Critical Danger (50 cm)',
          data: [],
          borderColor: cCrit,
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        y: {
          min: 0,
          max: appState.maxScaleCm,
          grid: { color: cRule },
          border: { display: false },
          ticks: {
            color: cInk3,
            font: { family: bodyFont, size: 12 },
            callback: (v) => `${v}cm`
          }
        },
        x: {
          grid: { display: false },
          border: { color: cRule },
          ticks: {
            color: cInk3,
            font: { family: bodyFont, size: 12 },
            maxTicksLimit: 7
          }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cssVar('--panel-hi'),
          borderColor: cssVar('--rule-hi'),
          borderWidth: 1,
          cornerRadius: 4,
          titleColor: cssVar('--ink'),
          bodyColor: cssVar('--ink-2'),
          titleFont: { family: bodyFont, size: 13, weight: '600' },
          bodyFont: { family: bodyFont, size: 13 }
        }
      }
    }
  });
}

function appendChartPoint(level, recordedAt = null) {
  if (!appState.chart) return;
  const timeStr = recordedAt
    ? new Date(recordedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  appState.chart.data.labels.push(timeStr);
  appState.chart.data.datasets[0].data.push(level);
  appState.chart.data.datasets[1].data.push(appState.alertThresholdCm);
  appState.chart.data.datasets[2].data.push(appState.dangerThresholdCm);

  if (appState.chart.data.labels.length > 30) {
    appState.chart.data.labels.shift();
    appState.chart.data.datasets[0].data.shift();
    appState.chart.data.datasets[1].data.shift();
    appState.chart.data.datasets[2].data.shift();
  }

  appState.chart.update();
}

/* =========================================================
   TERMINAL & LOGGING
   ========================================================= */
function appendTerminalLog(msg, customClass = '') {
  const term = document.getElementById('telemetry-terminal');
  if (!term) return;
  const time = new Date().toTimeString().split(' ')[0];
  const line = document.createElement('div');
  line.className = customClass;
  line.innerHTML = `<span class="ts">[${time}]</span> ${msg}`;
  term.appendChild(line);
  term.scrollTop = term.scrollHeight;
}

function clearConsoleLog() {
  document.getElementById('telemetry-terminal').innerHTML = '<div class="log-muted">-- LOG FLUSHED --</div>';
}

/* =========================================================
   SENSOR SWITCHING & MODAL
   ========================================================= */
function switchSensor(sensorId) {
  appState.sensorId = sensorId;
  document.getElementById('hdr-station-name').innerText = sensorId;
  appendTerminalLog(`[UI] Switched active sensor to ${sensorId}`, 'log-sim log-strong');

  fetchHistory(sensorId);
  fetchPredictions(sensorId);
}

function openConfigModal() {
  document.getElementById('cfg-node-host').value = appState.nodeHost;
  document.getElementById('cfg-ml-host').value = appState.mlHost;
  document.getElementById('cfg-thresh-alert').value = appState.alertThresholdCm;
  document.getElementById('cfg-thresh-crit').value = appState.dangerThresholdCm;
  document.getElementById('config-modal').classList.add('open');
}

function closeConfigModal() {
  document.getElementById('config-modal').classList.remove('open');
}

function applyConfiguration() {
  appState.nodeHost = document.getElementById('cfg-node-host').value.trim();
  appState.mlHost = document.getElementById('cfg-ml-host').value.trim();
  appState.alertThresholdCm = parseFloat(document.getElementById('cfg-thresh-alert').value) || 35.0;
  appState.dangerThresholdCm = parseFloat(document.getElementById('cfg-thresh-crit').value) || 50.0;

  positionThresholdMarkers();
  closeConfigModal();

  appendTerminalLog(`[CONFIG] Reconnecting: Node -> ${appState.nodeHost} | ML -> ${appState.mlHost}`, 'log-sim log-strong');
  initWebSocket();
  fetchHistory();
  fetchPredictions();
}

/* =========================================================
   LIFECYCLE INITIALIZATION
   ========================================================= */
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('audio-icon').innerHTML = ICON_SOUND;
  buildRuler();
  positionThresholdMarkers();
  initChart();
  renderUI();

  // 1. Initial backend history load
  fetchHistory();

  // 2. Connect WebSocket
  initWebSocket();

  // 3. Connect ML service & poll periodically (every 15s)
  fetchPredictions();
  if (appState.mlPollTimer) clearInterval(appState.mlPollTimer);
  appState.mlPollTimer = setInterval(() => fetchPredictions(), 15000);
});