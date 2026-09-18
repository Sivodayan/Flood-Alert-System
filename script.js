/* =========================================================
   CORE STATE & CONFIGURATION
   ========================================================= */
const appState = {
  waterLevel: 1.85,
  maxScaleMeters: 6.20,
  alertThreshold: 3.50,
  dangerThreshold: 5.00,
  riseRateCmMin: 0.40,
  lastLevel: 1.85,
  lastTime: Date.now(),
  buzzerActive: false,
  buzzerManualOverride: false,
  audioMuted: false,
  smsStatus: 'READY',
  smsRecipients: 1840,
  scenario: 'MONSOON_RISE',
  packetCount: 28,
  mqttClient: null,
  mqttConnected: false,
  chart: null,
};

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const ICON_SOUND = '<svg viewBox="0 0 18 16" width="18" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6h2.8L9.5 2.8v10.4L5.3 10H2.5z"/><path d="M12 5.5a3.6 3.6 0 0 1 0 5"/><path d="M14 3.6a6.3 6.3 0 0 1 0 8.8"/></svg>';
const ICON_MUTE  = '<svg viewBox="0 0 18 16" width="18" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6h2.8L9.5 2.8v10.4L5.3 10H2.5z"/><path d="M12.5 5.5l4 5M16.5 5.5l-4 5"/></svg>';

// Web Audio Synthesizer for Buzzer Siren
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
   STAFF GAUGE (ruler board, zone strip, threshold markers)
   ========================================================= */
function buildRuler() {
  const max = appState.maxScaleMeters;
  const H = Math.round(max * 100);
  const svg = document.getElementById('ruler-svg');
  svg.setAttribute('viewBox', `0 0 84 ${H}`);

  let lines = '';
  for (let i = 0; i <= Math.floor(max * 10); i++) {
    const y = (H - i * 10).toFixed(1);
    let len = 8, cls = '';
    if (i % 10 === 0) { len = 30; cls = ' class="major"'; }
    else if (i % 5 === 0) { len = 19; }
    lines += `<line${cls} x1="0" x2="${len}" y1="${y}" y2="${y}"/>`;
  }
  svg.innerHTML = lines;

  const ruler = document.getElementById('ruler');
  for (let v = 0; v <= Math.floor(max); v++) {
    const label = document.createElement('div');
    label.className = 'tick-label' + (v === 0 ? ' base' : '');
    label.style.bottom = (v / max * 100) + '%';
    label.innerHTML = `${v}<small>m</small>`;
    ruler.appendChild(label);
  }
}

function positionThresholdMarkers() {
  const max = appState.maxScaleMeters;
  const alertPct = Math.min(100, appState.alertThreshold / max * 100);
  const critPct  = Math.min(100, appState.dangerThreshold / max * 100);

  const a = document.getElementById('marker-alert');
  const c = document.getElementById('marker-crit');
  a.style.bottom = alertPct + '%';
  c.style.bottom = critPct + '%';
  a.querySelector('span').textContent = `Alert level (${appState.alertThreshold.toFixed(1)}m)`;
  c.querySelector('span').textContent = `Critical evacuation (${appState.dangerThreshold.toFixed(1)}m)`;

  document.getElementById('zone-strip').style.background =
    `linear-gradient(to top,
      ${cssVar('--ok')} 0, ${cssVar('--ok')} ${alertPct}%,
      ${cssVar('--warn')} ${alertPct}%, ${cssVar('--warn')} ${critPct}%,
      ${cssVar('--crit')} ${critPct}%, ${cssVar('--crit')} 100%)`;
}

/* =========================================================
   TELEMETRY UPDATER & CALCULATIONS
   ========================================================= */
function updateTelemetry(newLevel) {
  const now = Date.now();
  const elapsedMinutes = (now - appState.lastTime) / 60000;

  if (elapsedMinutes >= 0.02) {
    const deltaCm = (newLevel - appState.lastLevel) * 100;
    const instantRate = deltaCm / elapsedMinutes;

    // Exponential moving average filter
    appState.riseRateCmMin = +(0.7 * appState.riseRateCmMin + 0.3 * instantRate).toFixed(2);
    appState.lastLevel = newLevel;
    appState.lastTime = now;
  }

  appState.waterLevel = +Math.max(0.1, Math.min(appState.maxScaleMeters, newLevel)).toFixed(2);
  appState.packetCount++;

  // Auto Siren Safety Trip
  if (!appState.buzzerManualOverride) {
    if (appState.waterLevel >= appState.dangerThreshold && !appState.buzzerActive) {
      setBuzzerState(true, 'AUTOMATIC TRIP: Level >= 5.0m Danger Threshold');
    } else if (appState.waterLevel < appState.dangerThreshold && appState.buzzerActive) {
      setBuzzerState(false, 'NORMALIZED: Level < 5.0m');
    }
  }

  renderUI();
  appendChartPoint(appState.waterLevel);
}

function renderUI() {
  // 1. Digital Water Level Readouts
  document.getElementById('disp-water-level').innerText = appState.waterLevel.toFixed(2);
  document.getElementById('gauge-level-tag').innerText = appState.waterLevel.toFixed(2);
  const freeboard = Math.max(0, appState.maxScaleMeters - appState.waterLevel).toFixed(2);
  document.getElementById('disp-freeboard-val').innerText = `${freeboard} m remaining`;

  // 2. Animated Tank Column Height
  const percent = Math.min(100, Math.max(5, (appState.waterLevel / appState.maxScaleMeters) * 100));
  document.getElementById('tank-water-body').style.height = `${percent.toFixed(1)}%`;

  // 3. Status Level Categorization (styling is driven by body[data-level])
  const headText = document.getElementById('status-header-text');
  const headSub = document.getElementById('status-header-sub');
  const badge = document.getElementById('card-level-badge');

  if (appState.waterLevel >= appState.dangerThreshold) {
    document.body.dataset.level = 'critical';
    headText.innerText = 'CRITICAL DANGER : FLOOD SPILLWAY BREACH IMMINENT';
    headSub.innerText = 'High decibel evacuations active. Mobile relief and rescue personnel dispatched.';
    badge.innerText = 'Critical';
  } else if (appState.waterLevel >= appState.alertThreshold) {
    document.body.dataset.level = 'alert';
    headText.innerText = 'WARNING ALERT : RIVER STAGE EXCEEDING SAFE EMBANKMENT';
    headSub.innerText = 'Low lying flood plain areas placed on standby alert. Sluice discharge monitored.';
    badge.innerText = 'Alert';
  } else {
    document.body.dataset.level = 'safe';
    headText.innerText = 'NORMAL CONDITIONS : WATER LEVEL NOMINAL';
    headSub.innerText = 'No evacuation risk. Embankments and sluice gates operating within standard parameters.';
    badge.innerText = 'Safe';
  }

  // 4. Rate of Rise
  const rateCell = document.getElementById('cell-rate');
  const rateEl = document.getElementById('disp-rise-rate');
  const arrowEl = document.getElementById('disp-rise-arrow');
  const sign = appState.riseRateCmMin >= 0 ? '+' : '';
  rateEl.innerText = `${sign}${appState.riseRateCmMin.toFixed(1)}`;

  if (appState.riseRateCmMin >= 2.5) {
    rateCell.dataset.rate = 'surge';
    arrowEl.innerHTML = '<span>▲▲</span> Surge';
  } else if (appState.riseRateCmMin >= 0.8) {
    rateCell.dataset.rate = 'rising';
    arrowEl.innerHTML = '<span>▲</span> Rising';
  } else if (appState.riseRateCmMin <= -0.4) {
    rateCell.dataset.rate = 'receding';
    arrowEl.innerHTML = '<span>▼</span> Receding';
  } else {
    rateCell.dataset.rate = 'steady';
    arrowEl.innerHTML = '<span>•</span> Steady';
  }

  // 5. Estimated Time to Spillway Crest
  if (appState.waterLevel >= appState.dangerThreshold) {
    document.getElementById('stat-crest-eta').innerText = 'BREACH REACHED';
  } else if (appState.riseRateCmMin > 0.2) {
    const remainingCm = (appState.dangerThreshold - appState.waterLevel) * 100;
    const minutes = Math.round(remainingCm / appState.riseRateCmMin);
    if (minutes < 60) {
      document.getElementById('stat-crest-eta').innerText = `${minutes} mins`;
    } else {
      document.getElementById('stat-crest-eta').innerText = `${(minutes / 60).toFixed(1)} hrs`;
    }
  } else {
    document.getElementById('stat-crest-eta').innerText = '> 14 hrs';
  }

  // 6. Packet Counter
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
    text.innerText = 'Siren active';
    relay.innerText = 'RELAY: ON';
    btn.innerText = 'Silence siren';
    btn.classList.add('is-on');

    startSirenTone();
    appendTerminalLog(`[GPIO 26] Buzzer Relay TRIGGERED: ${reason}`, 'log-crit log-strong');
  } else {
    text.innerText = 'Standby';
    relay.innerText = 'RELAY: OFF';
    btn.innerText = 'Test siren';
    btn.classList.remove('is-on');

    stopSirenTone();
    appendTerminalLog(`[GPIO 26] Buzzer Relay DISARMED: ${reason}`, 'log-muted');
  }

  // MQTT Publish if connected
  if (appState.mqttClient && appState.mqttConnected) {
    const topic = document.getElementById('cfg-pub-topic').value;
    appState.mqttClient.publish(topic, JSON.stringify({
      command: 'SET_BUZZER',
      relay: 26,
      state: active ? 1 : 0
    }));
  }
}

function toggleBuzzerManual() {
  appState.buzzerManualOverride = true;
  setBuzzerState(!appState.buzzerActive, 'Manual Operator Override Click');
}

/* =========================================================
   SMS DISPATCH SIMULATOR
   ========================================================= */
function triggerManualSmsBroadcast() {
  const badge = document.getElementById('sms-badge-status');
  const queue = document.getElementById('stat-queue-count');

  badge.dataset.tone = 'sending';
  badge.innerText = 'Broadcasting';
  queue.innerText = '1,840 queued';
  queue.dataset.tone = 'busy';

  appendTerminalLog(`[GSM SIM800L] Initiating AT+CMGS broadcast to 1,840 subscribers...`, 'log-warn log-strong');

  setTimeout(() => {
    badge.dataset.tone = 'done';
    badge.innerText = 'Delivered (100%)';
    queue.innerText = '0 pending';
    queue.dataset.tone = 'idle';
    appendTerminalLog(`[GSM SIM800L] Broadcast ACK: 1840/1840 messages delivered to cell carriers.`, 'log-ok log-strong');
  }, 2500);
}

/* =========================================================
   HYDROGRAPH CHART (Chart.js)
   ========================================================= */
function initChart() {
  const ctx = document.getElementById('liveHydroChart').getContext('2d');
  const initialLabels = [];
  const initialData = [];
  const alertLine = [];
  const dangerLine = [];
  const now = Date.now();

  const cLevel = cssVar('--link');
  const cWarn = cssVar('--warn');
  const cCrit = cssVar('--crit');
  const cInk3 = cssVar('--ink-3');
  const cRule = cssVar('--rule');
  const bodyFont = "'Source Sans 3', system-ui, sans-serif";

  for (let i = 24; i >= 0; i--) {
    const time = new Date(now - i * 10000);
    initialLabels.push(time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    initialData.push(+(1.75 + Math.sin(i * 0.25) * 0.2).toFixed(2));
    alertLine.push(appState.alertThreshold);
    dangerLine.push(appState.dangerThreshold);
  }

  appState.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: initialLabels,
      datasets: [
        {
          label: 'Water Stage (m)',
          data: initialData,
          borderColor: cLevel,
          backgroundColor: cLevel + '1f',
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointBackgroundColor: cLevel
        },
        {
          label: 'Alert Threshold (3.5m)',
          data: alertLine,
          borderColor: cWarn,
          borderWidth: 1.25,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false
        },
        {
          label: 'Critical Threshold (5.0m)',
          data: dangerLine,
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
          max: 6.2,
          grid: { color: cRule },
          border: { display: false },
          ticks: {
            color: cInk3,
            font: { family: bodyFont, size: 12 },
            callback: (v) => `${v.toFixed(1)}m`
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

function appendChartPoint(level) {
  if (!appState.chart) return;
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  appState.chart.data.labels.push(timeStr);
  appState.chart.data.datasets[0].data.push(level);
  appState.chart.data.datasets[1].data.push(appState.alertThreshold);
  appState.chart.data.datasets[2].data.push(appState.dangerThreshold);

  if (appState.chart.data.labels.length > 30) {
    appState.chart.data.labels.shift();
    appState.chart.data.datasets[0].data.shift();
    appState.chart.data.datasets[1].data.shift();
    appState.chart.data.datasets[2].data.shift();
  }

  appState.chart.update();
}

/* =========================================================
   TERMINAL LOGGING
   ========================================================= */
function appendTerminalLog(msg, customClass = '') {
  const term = document.getElementById('telemetry-terminal');
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
   SIMULATION & QUICK ADJUSTMENTS
   ========================================================= */
function adjustSimulatedWaterLevel(delta) {
  updateTelemetry(appState.waterLevel + delta);
  appendTerminalLog(`[SIMULATOR] Manual delta ${delta > 0 ? '+' : ''}${delta}m applied.`, 'log-sim log-strong');
}

function switchSimulationScenario(val) {
  appState.scenario = val;
  appendTerminalLog(`[SIMULATOR] Swapped active meteorological scenario to: ${val}`, 'log-warn log-strong');
}

function simulationStep() {
  let stepDelta = 0;
  switch (appState.scenario) {
    case 'MONSOON_RISE':
      stepDelta = 0.02 + (Math.random() * 0.015);
      break;
    case 'FLASH_FLOOD':
      stepDelta = 0.065 + (Math.random() * 0.035);
      break;
    case 'RECEDING':
      stepDelta = -0.04 - (Math.random() * 0.02);
      break;
    case 'STABLE_NORMAL':
    default:
      stepDelta = (Math.random() - 0.5) * 0.012;
      break;
  }

  updateTelemetry(appState.waterLevel + stepDelta);
}

/* =========================================================
   MODAL & MQTT BROKER CONFIGURATION
   ========================================================= */
function openConfigModal() {
  document.getElementById('config-modal').classList.add('open');
}

function closeConfigModal() {
  document.getElementById('config-modal').classList.remove('open');
}

function applyConfiguration() {
  const brokerUrl = document.getElementById('cfg-broker-url').value;
  const subTopic = document.getElementById('cfg-sub-topic').value;
  appState.alertThreshold = parseFloat(document.getElementById('cfg-thresh-alert').value) || 3.5;
  appState.dangerThreshold = parseFloat(document.getElementById('cfg-thresh-crit').value) || 5.0;
  positionThresholdMarkers();

  closeConfigModal();
  appendTerminalLog(`[MQTT] Connecting to WebSocket broker: ${brokerUrl}...`, 'log-sim log-strong');

  try {
    if (appState.mqttClient) {
      appState.mqttClient.end();
    }

    appState.mqttClient = mqtt.connect(brokerUrl, {
      clientId: 'FloodGuard_Client_' + Math.random().toString(16).substr(2, 6),
      clean: true,
      connectTimeout: 4000
    });

    appState.mqttClient.on('connect', () => {
      appState.mqttConnected = true;
      document.getElementById('hdr-connection-status').innerHTML =
        '<i class="dot live"></i> Connected (Live MQTT)';
      appendTerminalLog(`[MQTT] Subscribed to topic: ${subTopic}`, 'log-ok log-strong');
      appState.mqttClient.subscribe(subTopic);
    });

    appState.mqttClient.on('message', (topic, message) => {
      try {
        const data = JSON.parse(message.toString());
        if (data.water_level_m !== undefined) {
          updateTelemetry(parseFloat(data.water_level_m));
        }
        if (data.buzzer !== undefined) {
          setBuzzerState(Boolean(data.buzzer), 'ESP32 Telemetry Status');
        }
        appendTerminalLog(`[ESP32 RX] Level: ${data.water_level_m}m | Rate: ${data.rise_rate_cm_min}cm/m`, 'log-info');
      } catch(err) {
        console.error('JSON Parse error', err);
      }
    });

    appState.mqttClient.on('error', (err) => {
      appendTerminalLog(`[MQTT ERROR] ${err.message}`, 'log-crit log-strong');
    });

  } catch(e) {
    appendTerminalLog(`[MQTT FAILED] ${e.message}`, 'log-crit');
  }
}

/* =========================================================
   INITIALIZATION HOOK
   ========================================================= */
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('audio-icon').innerHTML = ICON_SOUND;
  buildRuler();
  positionThresholdMarkers();
  initChart();
  renderUI();

  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { if (appState.chart) appState.chart.update(); });
  }

  setInterval(() => {
    if (!appState.mqttConnected) {
      simulationStep();
    }
  }, 1500);
});