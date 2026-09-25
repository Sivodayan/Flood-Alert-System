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
  surgeThresholdCmMin: 2.0,    // Configurable rise rate alert threshold (cm/min)
  lastSurgeSmsTime: 0,         // Cooldown timestamp for surge SMS
  surgeSmsCooldownMs: 300000,  // 5-minute cooldown between surge alerts

  buzzerActive: false,
  buzzerManualOverride: false,
  audioMuted: false,

  packetCount: 0,
  ws: null,
  wsReconnectTimer: null,
  wsReconnectDelay: 2000,
  chart: null,
  mlPollTimer: null,
  latestMlEta: null            // Cached ML estimate if available
};

// Safe helper for CSS custom properties with fallback
const cssVar = (name, fallback = '') => {
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
};

// Safe helper for updating DOM innerText without throwing if element is absent
const setElemText = (id, text) => {
  const el = document.getElementById(id);
  if (el) el.innerText = text;
};

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
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

// Ensure audio context is ready on first explicit user gesture
window.addEventListener('click', () => initAudio(), { once: true });
window.addEventListener('keydown', () => initAudio(), { once: true });

function toggleAudioMute() {
  appState.audioMuted = !appState.audioMuted;
  const text = document.getElementById('audio-text');
  const icon = document.getElementById('audio-icon');

  if (appState.audioMuted) {
    if (text) text.innerText = 'Audio muted';
    if (icon) icon.innerHTML = ICON_MUTE;
    stopSirenTone();
  } else {
    if (text) text.innerText = 'Audio armed';
    if (icon) icon.innerHTML = ICON_SOUND;
    initAudio();
    if (appState.buzzerActive) {
      startSirenTone();
    }
  }
}

function startSirenTone() {
  if (appState.audioMuted) return;
  initAudio();
  if (!audioCtx) return;

  stopSirenTone();

  try {
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
      if (!sirenOsc || !sirenGain || !audioCtx) return;
      toggle = !toggle;
      sirenOsc.frequency.setValueAtTime(toggle ? 1150 : 700, audioCtx.currentTime);
    }, 400);
  } catch (err) {
    console.warn('Audio tone could not be started:', err);
  }
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
  if (sirenGain) {
    try {
      sirenGain.disconnect();
    } catch(e) {}
    sirenGain = null;
  }
}

/* =========================================================
   STAFF GAUGE RENDERING
   ========================================================= */
function buildRuler() {
  const max = appState.maxScaleCm;
  const H = Math.round(max);
  const svg = document.getElementById('ruler-svg');
  if (svg) {
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
  }

  const ruler = document.getElementById('ruler');
  if (ruler) {
    ruler.querySelectorAll('.tick-label').forEach(el => el.remove());
    for (let v = 0; v <= max; v += 10) {
      const label = document.createElement('div');
      label.className = 'tick-label' + (v === 0 ? ' base' : '');
      label.style.bottom = (v / max * 100) + '%';
      label.innerHTML = `${v}<small>cm</small>`;
      ruler.appendChild(label);
    }
  }
}

function positionThresholdMarkers() {
  const max = appState.maxScaleCm;
  const alertPct = Math.min(100, Math.max(0, (appState.alertThresholdCm / max) * 100));
  const critPct  = Math.min(100, Math.max(0, (appState.dangerThresholdCm / max) * 100));

  const a = document.getElementById('marker-alert');
  const c = document.getElementById('marker-crit');
  if (a) {
    a.style.bottom = alertPct + '%';
    const tag = a.querySelector('span');
    if (tag) tag.textContent = `Alert (${appState.alertThresholdCm.toFixed(1)} cm)`;
  }
  if (c) {
    c.style.bottom = critPct + '%';
    const tag = c.querySelector('span');
    if (tag) tag.textContent = `Danger (${appState.dangerThresholdCm.toFixed(1)} cm)`;
  }

  const strip = document.getElementById('zone-strip');
  if (strip) {
    const okColor = cssVar('--ok', '#10b981');
    const warnColor = cssVar('--warn', '#f59e0b');
    const critColor = cssVar('--crit', '#ef4444');
    strip.style.background =
      `linear-gradient(to top,
        ${okColor} 0%, ${okColor} ${alertPct}%,
        ${warnColor} ${alertPct}%, ${warnColor} ${critPct}%,
        ${critColor} ${critPct}%, ${critColor} 100%)`;
  }
}

/* =========================================================
   UI UPDATER & ALERT LOGIC
   ========================================================= */
function updateTelemetry(reading) {
  if (!reading) return;
  const level = parseFloat(reading.water_level);
  if (isNaN(level)) return;

  appState.waterLevelCm = level;
  appState.packetCount++;

  if (reading.water_rising_level !== undefined && reading.water_rising_level !== null) {
    appState.riseRateCmMin = parseFloat(reading.water_rising_level);
  }

  // 1. Check Surge Rate & Dispatch SMS if threshold exceeded
  checkSurgeRateAndDispatch();

  // 2. Automatic Audible Siren Trip: Trigger on Danger Level OR Rapid Surge
  if (!appState.buzzerManualOverride) {
    const isLevelDanger = appState.waterLevelCm >= appState.dangerThresholdCm;
    const isSurgeDanger = appState.riseRateCmMin >= appState.surgeThresholdCmMin;

    if ((isLevelDanger || isSurgeDanger) && !appState.buzzerActive) {
      const reason = isLevelDanger
        ? `Level (${appState.waterLevelCm.toFixed(1)} cm) >= ${appState.dangerThresholdCm.toFixed(1)} cm Danger Mark`
        : `Surge Alert: Rise Rate (${appState.riseRateCmMin.toFixed(1)} cm/min) >= ${appState.surgeThresholdCmMin.toFixed(1)} cm/min`;
      setBuzzerState(true, reason);
    } else if (!isLevelDanger && !isSurgeDanger && appState.buzzerActive) {
      setBuzzerState(false, 'Conditions normalized below danger & surge marks');
    }
  }

  renderUI();
  appendChartPoint(appState.waterLevelCm, reading.recorded_at);
}

// Surge evaluation & Automated Warning SMS dispatch
async function checkSurgeRateAndDispatch() {
  if (appState.riseRateCmMin >= appState.surgeThresholdCmMin) {
    const now = Date.now();
    // Cooldown prevents spamming SMS on every 1-second WebSocket update
    if (now - appState.lastSurgeSmsTime < appState.surgeSmsCooldownMs) {
      return;
    }

    appState.lastSurgeSmsTime = now;

    // Calculate ETA to flood crest (danger mark)
    let minutesRemaining = appState.latestMlEta;
    if (!minutesRemaining || minutesRemaining <= 0) {
      const remainingCm = Math.max(0, appState.dangerThresholdCm - appState.waterLevelCm);
      minutesRemaining = appState.riseRateCmMin > 0 ? (remainingCm / appState.riseRateCmMin) : 0;
    }

    const etaText = `${minutesRemaining.toFixed(1)} minutes (Surge rate: +${appState.riseRateCmMin.toFixed(1)} cm/min)`;
    const locationName = document.getElementById('sms-payload-location')?.innerText.trim() || 'Your City / Riverside Area';

    appendTerminalLog(`[SURGE TRIGGER] Rate ${appState.riseRateCmMin.toFixed(1)} cm/min >= ${appState.surgeThresholdCmMin.toFixed(1)} cm/min. Dispatching Warning SMS...`, 'log-crit log-strong');

    // Trigger Warning SMS via POST /api/alert
    await dispatchSmsAlert({
      alert: 'Warning',
      ETA: etaText,
      location: locationName
    });
  }
}

function renderUI() {
  // 1. Digital Water Level Readout
  setElemText('disp-water-level', appState.waterLevelCm.toFixed(1));
  setElemText('gauge-level-tag', appState.waterLevelCm.toFixed(1));

  const freeboard = Math.max(0, appState.dangerThresholdCm - appState.waterLevelCm).toFixed(1);
  setElemText('disp-freeboard-val', `${freeboard} cm to danger`);

  // 2. Animated Tank Level Height
  const tank = document.getElementById('tank-water-body');
  if (tank) {
    const percent = Math.min(100, Math.max(3, (appState.waterLevelCm / appState.maxScaleCm) * 100));
    tank.style.height = `${percent.toFixed(1)}%`;
  }

  // 3. Status Level Categorization
  const headText = document.getElementById('status-header-text');
  const headSub = document.getElementById('status-header-sub');
  const badge = document.getElementById('card-level-badge');

  const isSurging = appState.riseRateCmMin >= appState.surgeThresholdCmMin;

  if (appState.waterLevelCm >= appState.dangerThresholdCm) {
    document.body.dataset.level = 'critical';
    if (headText) headText.innerText = 'CRITICAL DANGER : FLOOD LEVEL EXCEEDED';
    if (headSub) headSub.innerText = `Water level has breached the ${appState.dangerThresholdCm}cm threshold. Evacuate immediately.`;
    if (badge) badge.innerText = 'Danger';
  } else if (isSurging) {
    document.body.dataset.level = 'critical';
    if (headText) headText.innerText = 'RAPID SURGE WARNING : HIGH INFLOW DETECTED';
    if (headSub) headSub.innerText = `Rising at ${appState.riseRateCmMin.toFixed(1)} cm/min (Limit: ${appState.surgeThresholdCmMin.toFixed(1)} cm/min). Immediate flood risk.`;
    if (badge) badge.innerText = 'Flash Flood Risk';
  } else if (appState.waterLevelCm >= appState.alertThresholdCm) {
    document.body.dataset.level = 'alert';
    if (headText) headText.innerText = 'WARNING ALERT : WATER STAGE ELEVATED';
    if (headSub) headSub.innerText = 'Water approaching critical crest. Prepare precautionary procedures.';
    if (badge) badge.innerText = 'Alert';
  } else {
    document.body.dataset.level = 'safe';
    if (headText) headText.innerText = 'NORMAL CONDITIONS : WATER LEVEL NOMINAL';
    if (headSub) headSub.innerText = 'Sensor telemetry steady. Embankment and drainage channels free.';
    if (badge) badge.innerText = 'Safe';
  }

  // 4. Rate of Rise Readout
  const rateCell = document.getElementById('cell-rate');
  const rateEl = document.getElementById('disp-rise-rate');
  const arrowEl = document.getElementById('disp-rise-arrow');
  const sign = appState.riseRateCmMin >= 0 ? '+' : '';
  if (rateEl) rateEl.innerText = `${sign}${appState.riseRateCmMin.toFixed(1)}`;

  if (rateCell && arrowEl) {
    if (appState.riseRateCmMin >= appState.surgeThresholdCmMin) {
      rateCell.dataset.rate = 'surge';
      arrowEl.innerHTML = `<span>▲▲</span> Surge (&ge;${appState.surgeThresholdCmMin}cm/m)`;
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
  }

  // 5. Packet Counter
  setElemText('terminal-packet-counter', `Packets Received: ${appState.packetCount}`);
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

  if (cell) cell.dataset.on = active ? 'true' : 'false';

  if (active) {
    if (text) text.innerText = 'Siren Active';
    if (relay) relay.innerText = 'SIREN: ON';
    if (btn) {
      btn.innerText = 'Silence Siren';
      btn.classList.add('is-on');
    }
    startSirenTone();
    appendTerminalLog(`[ALARM] Siren Triggered: ${reason}`, 'log-crit log-strong');
  } else {
    if (text) text.innerText = 'Standby';
    if (relay) relay.innerText = 'SIREN: OFF';
    if (btn) {
      btn.innerText = 'Test Siren';
      btn.classList.remove('is-on');
    }
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
async function fetchHistory(sensorId = appState.sensorId, limit = 30) {
  try {
    const url = `http://${appState.nodeHost}/api/history?sensor_id=${encodeURIComponent(sensorId)}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const readings = await res.json();

    if (Array.isArray(readings) && readings.length > 0) {
      appendTerminalLog(`[REST] Loaded ${readings.length} historical readings for ${sensorId}`, 'log-ok');
      
      const labels = readings.map(r => {
        const d = r.recorded_at ? new Date(r.recorded_at) : new Date();
        return isNaN(d) ? '--:--:--' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      });
      const levels = readings.map(r => r.water_level);
      const alertLine = new Array(readings.length).fill(appState.alertThresholdCm);
      const dangerLine = new Array(readings.length).fill(appState.dangerThresholdCm);

      if (appState.chart) {
        appState.chart.data.labels = labels;
        appState.chart.data.datasets[0].data = levels;
        appState.chart.data.datasets[1].data = alertLine;
        appState.chart.data.datasets[2].data = dangerLine;
        appState.chart.update();
      }

      // Workaround for commented-out /api/latest: use last chronological item
      const latestReading = readings[readings.length - 1];
      updateTelemetry(latestReading);
    } else {
      appendTerminalLog(`[REST] No history returned for ${sensorId}`, 'log-warn');
    }
  } catch (err) {
    appendTerminalLog(`[REST ERROR] History fetch failed: ${err.message}`, 'log-crit');
  }
}

function initWebSocket() {
  if (appState.wsReconnectTimer) {
    clearTimeout(appState.wsReconnectTimer);
    appState.wsReconnectTimer = null;
  }

  if (appState.ws) {
    try {
      appState.ws.onopen = null;
      appState.ws.onmessage = null;
      appState.ws.onerror = null;
      appState.ws.onclose = null;
      appState.ws.close();
    } catch(e) {}
    appState.ws = null;
  }

  const statusEl = document.getElementById('hdr-connection-status');
  const wsUrl = `ws://${appState.nodeHost}`;
  appendTerminalLog(`[WS] Connecting to ${wsUrl}...`, 'log-sim');

  try {
    appState.ws = new WebSocket(wsUrl);

    appState.ws.onopen = () => {
      appState.wsReconnectDelay = 2000;
      if (statusEl) statusEl.innerHTML = '<i class="dot live"></i> Online (WebSocket)';
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
      if (statusEl) statusEl.innerHTML = '<i class="dot" style="background:var(--crit)"></i> Offline (Reconnecting...)';
      appendTerminalLog(`[WS] Connection closed. Retrying in ${Math.round(appState.wsReconnectDelay / 1000)}s...`, 'log-warn');
      
      appState.wsReconnectTimer = setTimeout(() => {
        initWebSocket();
      }, appState.wsReconnectDelay);
      
      appState.wsReconnectDelay = Math.min(10000, appState.wsReconnectDelay * 1.5);
    };

    appState.ws.onerror = (err) => {
      console.warn('WebSocket error encountered', err);
      try { appState.ws.close(); } catch(e) {}
    };
  } catch (err) {
    console.error('WebSocket creation error', err);
    if (statusEl) statusEl.innerHTML = '<i class="dot" style="background:var(--crit)"></i> Connection Error';
  }
}

async function fetchPredictions(sensorId = appState.sensorId) {
  const etaDisplay = document.getElementById('stat-crest-eta');
  const fitDisplay = document.getElementById('stat-ml-fit');

  try {
    const res = await fetch(`http://${appState.mlHost}/predict?sensor_id=${encodeURIComponent(sensorId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    switch (data.status) {
      case 'ok':
        appState.latestMlEta = data.eta_minutes;
        if (etaDisplay) etaDisplay.innerText = `${data.eta_minutes.toFixed(1)} mins`;
        if (fitDisplay) {
          fitDisplay.innerText = `${Math.round(data.r_squared * 100)}%`;
          fitDisplay.className = data.r_squared > 0.7 ? 'v ok' : 'v warn';
        }
        setElemText('sms-payload-eta', `${data.eta_minutes.toFixed(1)} minutes`);
        break;
      case 'not_rising':
        appState.latestMlEta = null;
        if (etaDisplay) etaDisplay.innerText = 'Stable (Not rising)';
        if (fitDisplay) {
          fitDisplay.innerText = data.r_squared !== undefined ? `${Math.round(data.r_squared * 100)}%` : '--';
          fitDisplay.className = 'v';
        }
        break;
      case 'already_danger':
        appState.latestMlEta = 0;
        if (etaDisplay) etaDisplay.innerText = 'DANGER REACHED';
        if (fitDisplay) {
          fitDisplay.innerText = '100%';
          fitDisplay.className = 'v log-crit';
        }
        break;
      case 'not_enough_data':
        appState.latestMlEta = null;
        if (etaDisplay) etaDisplay.innerText = 'Gathering points...';
        if (fitDisplay) {
          fitDisplay.innerText = '--';
          fitDisplay.className = 'v';
        }
        break;
      default:
        appState.latestMlEta = null;
        if (etaDisplay) etaDisplay.innerText = 'Unavailable';
        if (fitDisplay) {
          fitDisplay.innerText = '--';
          fitDisplay.className = 'v';
        }
    }
  } catch (err) {
    appState.latestMlEta = null;
    if (etaDisplay) etaDisplay.innerText = 'Service down';
    if (fitDisplay) {
      fitDisplay.innerText = '--';
      fitDisplay.className = 'v';
    }
  }
}

// Unified Core SMS Dispatch function
async function dispatchSmsAlert(payload) {
  const badge = document.getElementById('sms-badge-status');
  if (badge) {
    badge.dataset.tone = 'sending';
    badge.innerText = 'Sending...';
  }

  appendTerminalLog(`[REST] Dispatching POST /api/alert: ${JSON.stringify(payload)}`, 'log-warn log-strong');

  try {
    const res = await fetch(`http://${appState.nodeHost}/api/alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const result = await res.json();

    if (badge) {
      badge.dataset.tone = 'done';
      badge.innerText = `Sent (${result.status || 'sent'})`;
    }
    appendTerminalLog(`[REST] Alert dispatched successfully: ${result.status || 'sent'}`, 'log-ok log-strong');
    return true;
  } catch (err) {
    if (badge) {
      badge.dataset.tone = 'ready';
      badge.innerText = 'Failed';
    }
    appendTerminalLog(`[REST ERROR] /api/alert call failed: ${err.message}`, 'log-crit log-strong');
    return false;
  }
}

// Manual SMS trigger from UI button
async function triggerManualSmsBroadcast() {
  const etaElem = document.getElementById('sms-payload-eta');
  const locElem = document.getElementById('sms-payload-location');

  const alertPayload = {
    alert: 'DANGER',
    ETA: etaElem ? etaElem.innerText.trim() : '15 minutes',
    location: locElem ? locElem.innerText.trim() : 'Riverside Colony'
  };

  await dispatchSmsAlert(alertPayload);
}

// Simulation endpoint
async function simulatePostReading(deltaCm) {
  const newLevel = Math.max(0, appState.waterLevelCm + deltaCm);
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
  const canvas = document.getElementById('liveHydroChart');
  if (!canvas || typeof Chart === 'undefined') return;

  const ctx = canvas.getContext('2d');
  const cLevel = cssVar('--link', '#38bdf8');
  const cWarn = cssVar('--warn', '#f59e0b');
  const cCrit = cssVar('--crit', '#ef4444');
  const cInk3 = cssVar('--ink-3', '#64748b');
  const cRule = cssVar('--rule', '#233152');
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
          backgroundColor: cLevel.startsWith('#') ? cLevel + '1f' : 'rgba(56, 189, 248, 0.12)',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 2,
          pointHoverRadius: 4,
          pointBackgroundColor: cLevel
        },
        {
          label: `Alert Threshold (${appState.alertThresholdCm} cm)`,
          data: [],
          borderColor: cWarn,
          borderWidth: 1.25,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false
        },
        {
          label: `Critical Danger (${appState.dangerThresholdCm} cm)`,
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
          backgroundColor: cssVar('--panel-hi', '#1c2742'),
          borderColor: cssVar('--rule-hi', '#344874'),
          borderWidth: 1,
          cornerRadius: 4,
          titleColor: cssVar('--ink', '#f1f5f9'),
          bodyColor: cssVar('--ink-2', '#94a3b8'),
          titleFont: { family: bodyFont, size: 13, weight: '600' },
          bodyFont: { family: bodyFont, size: 13 }
        }
      }
    }
  });
}

function appendChartPoint(level, recordedAt = null) {
  if (!appState.chart) return;
  const d = recordedAt ? new Date(recordedAt) : new Date();
  const timeStr = isNaN(d) 
    ? new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

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
  if (customClass) line.className = customClass;
  line.innerHTML = `<span class="ts">[${time}]</span> ${msg}`;
  term.appendChild(line);
  term.scrollTop = term.scrollHeight;
}

function clearConsoleLog() {
  const term = document.getElementById('telemetry-terminal');
  if (term) term.innerHTML = '<div class="log-muted">-- LOG FLUSHED --</div>';
}

/* =========================================================
   SENSOR SWITCHING & MODAL CONFIGURATION
   ========================================================= */
function switchSensor(sensorId) {
  appState.sensorId = sensorId;
  setElemText('hdr-station-name', sensorId);
  appendTerminalLog(`[UI] Switched active sensor to ${sensorId}`, 'log-sim log-strong');

  fetchHistory(sensorId);
  fetchPredictions(sensorId);
}

function ensureSurgeInputFieldExists() {
  // Dynamically inserts the Surge Threshold input if not present in the HTML modal
  let sEl = document.getElementById('cfg-thresh-surge');
  if (!sEl) {
    const modalContent = document.querySelector('#config-modal .modal-card') || document.querySelector('#config-modal form') || document.getElementById('config-modal');
    if (modalContent) {
      const actions = modalContent.querySelector('.modal-actions') || modalContent.lastElementChild;
      const group = document.createElement('div');
      group.className = 'form-group';
      group.innerHTML = `
        <label>Surge Alert Rate Threshold (cm/min)</label>
        <input type="number" id="cfg-thresh-surge" step="0.1" min="0.1" style="background:#090e17;border:1px solid #233152;padding:8px 10px;border-radius:4px;color:#f1f5f9;width:100%;font-family:monospace;">
      `;
      modalContent.insertBefore(group, actions);
    }
  }
}

function openConfigModal() {
  ensureSurgeInputFieldExists();

  const nodeEl = document.getElementById('cfg-node-host');
  const mlEl = document.getElementById('cfg-ml-host');
  const aEl = document.getElementById('cfg-thresh-alert');
  const cEl = document.getElementById('cfg-thresh-crit');
  const sEl = document.getElementById('cfg-thresh-surge');
  const modal = document.getElementById('config-modal');

  if (nodeEl) nodeEl.value = appState.nodeHost;
  if (mlEl) mlEl.value = appState.mlHost;
  if (aEl) aEl.value = appState.alertThresholdCm;
  if (cEl) cEl.value = appState.dangerThresholdCm;
  if (sEl) sEl.value = appState.surgeThresholdCmMin;
  if (modal) modal.classList.add('open');
}

function closeConfigModal() {
  const modal = document.getElementById('config-modal');
  if (modal) modal.classList.remove('open');
}

function applyConfiguration() {
  const nodeEl = document.getElementById('cfg-node-host');
  const mlEl = document.getElementById('cfg-ml-host');
  const aEl = document.getElementById('cfg-thresh-alert');
  const cEl = document.getElementById('cfg-thresh-crit');
  const sEl = document.getElementById('cfg-thresh-surge');

  if (nodeEl && nodeEl.value) appState.nodeHost = nodeEl.value.trim();
  if (mlEl && mlEl.value) appState.mlHost = mlEl.value.trim();
  if (aEl) appState.alertThresholdCm = parseFloat(aEl.value) || 35.0;
  if (cEl) appState.dangerThresholdCm = parseFloat(cEl.value) || 50.0;
  if (sEl) appState.surgeThresholdCmMin = parseFloat(sEl.value) || 2.0;

  positionThresholdMarkers();
  closeConfigModal();

  appendTerminalLog(`[CONFIG] Updated. Node -> ${appState.nodeHost} | Surge Limit -> ${appState.surgeThresholdCmMin} cm/min`, 'log-sim log-strong');
  initWebSocket();
  fetchHistory();
  fetchPredictions();
}

/* =========================================================
   LIFECYCLE INITIALIZATION
   ========================================================= */
window.addEventListener('DOMContentLoaded', () => {
  const audioIcon = document.getElementById('audio-icon');
  if (audioIcon) audioIcon.innerHTML = ICON_SOUND;

  buildRuler();
  positionThresholdMarkers();
  initChart();
  renderUI();

  // 1. Initial history fetch from Node server
  fetchHistory();

  // 2. Connect WebSocket
  initWebSocket();

  // 3. Connect ML service & poll periodically (every 15s)
  fetchPredictions();
  if (appState.mlPollTimer) clearInterval(appState.mlPollTimer);
  appState.mlPollTimer = setInterval(() => fetchPredictions(), 15000);
});
