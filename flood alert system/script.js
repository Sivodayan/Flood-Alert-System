/* =========================================================
   CONFIG — edit these to match your backend and thresholds
   ========================================================= */
const API_BASE = "http://172.20.10.5:3000"; // your Express server
const WS_URL = API_BASE.replace(/^http/, "ws"); // same host, ws:// instead of http://
const SENSOR_ID = "sensor_01";

const WARNING_LEVEL = 35;   // cm — matches your SENSORS.warning_threshold
const DANGER_LEVEL = 50;    // cm — matches your SENSORS.danger_threshold
const MAX_SCALE = 65;       // cm — top of the visual tank/chart, above danger

const HISTORY_LIMIT = 30;          // how many points to keep on the chart
const RECONNECT_DELAY_MS = 3000;   // wait before retrying a dropped WebSocket

const ML_API_BASE = "http://172.20.10.5:8001"; // Python ml_service.py

document.getElementById("station-name").textContent = "Sensor: " + SENSOR_ID;

let chart = null;
let historyData = []; // local rolling window of { water_level, recorded_at }

/* =========================================================
   ONE-TIME LOAD: backfill the chart with existing history
   (the WebSocket only pushes NEW readings from here on)
   ========================================================= */
async function loadInitialHistory() {
  try {
    const res = await fetch(`${API_BASE}/api/history?sensor_id=${SENSOR_ID}&limit=${HISTORY_LIMIT}`);
    if (!res.ok) throw new Error("Bad response from /api/history");
    historyData = await res.json();
    renderAll();
  } catch (err) {
    console.error("Failed to load initial history:", err);
  }
}

/* =========================================================
   WEBSOCKET — receives each new reading the instant it's posted
   ========================================================= */
function connectWebSocket() {
  const ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("WebSocket connected");
    setConnectionStatus(true);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type !== "reading" || msg.sensor_id !== SENSOR_ID) return;

    historyData.push({ water_level: msg.water_level, recorded_at: msg.recorded_at });
    if (historyData.length > HISTORY_LIMIT) historyData.shift();

    renderAll();
  };

  ws.onclose = () => {
    console.log("WebSocket disconnected, retrying in", RECONNECT_DELAY_MS, "ms");
    setConnectionStatus(false);
    setTimeout(connectWebSocket, RECONNECT_DELAY_MS);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    ws.close(); // triggers onclose -> reconnect
  };
}

/* ---------- Status logic ---------- */

function getStatus(level) {
  if (level >= DANGER_LEVEL) return "danger";
  if (level >= WARNING_LEVEL) return "warning";
  return "safe";
}

function statusLabel(status) {
  return { safe: "Safe", warning: "Warning", danger: "Danger" }[status];
}

/* ---------- UI updates ---------- */

function setConnectionStatus(online) {
  const el = document.getElementById("connection-status");
  el.textContent = online ? "Online" : "Offline";
  el.className = "status-pill " + (online ? "online" : "offline");
}

function updateStatCards(level, recordedAt, rateCmPerMin) {
  const status = getStatus(level);

  document.getElementById("level-value").textContent = level.toFixed(1);

  const badge = document.getElementById("level-badge");
  badge.textContent = statusLabel(status);
  badge.className = "badge " + status;

  document.getElementById("rate-value").textContent =
    (rateCmPerMin >= 0 ? "+" : "") + rateCmPerMin.toFixed(2);

  document.getElementById("last-updated").textContent = recordedAt.toLocaleTimeString();
  document.getElementById("last-updated-ago").textContent = "Just now";
}

function updateTank(level) {
  const pct = Math.min(100, Math.max(0, (level / MAX_SCALE) * 100));
  document.getElementById("tank-fill").style.height = pct + "%";

  const warnPct = 100 - (WARNING_LEVEL / MAX_SCALE) * 100;
  const dangerPct = 100 - (DANGER_LEVEL / MAX_SCALE) * 100;
  document.querySelector(".warning-line").style.top = warnPct + "%";
  document.querySelector(".danger-line").style.top = dangerPct + "%";
}

function updateLog(history) {
  const list = document.getElementById("readings-log");
  list.innerHTML = "";

  const recent = history.slice(-5).reverse();
  recent.forEach((point) => {
    const li = document.createElement("li");
    const time = new Date(point.recorded_at).toLocaleTimeString();
    li.innerHTML = `<span>${time}</span><span>${point.water_level.toFixed(1)} cm</span>`;
    list.appendChild(li);
  });
}

/* ---------- ETA prediction (Python ML service) ---------- */

async function updateEtaPrediction() {
  try {
    const res = await fetch(`${ML_API_BASE}/predict?sensor_id=${SENSOR_ID}`);
    const data = await res.json();

    const valueEl = document.getElementById("eta-value");
    const detailEl = document.getElementById("eta-detail");

    if (data.status === "ok") {
      valueEl.textContent = `~${data.eta_minutes} min`;
      detailEl.textContent = `Rising at ${data.rate_cm_per_min} cm/min · fit quality ${(data.r_squared * 100).toFixed(0)}%`;
    } else if (data.status === "not_rising") {
      valueEl.textContent = "Not rising";
      detailEl.textContent = "Water level is steady or falling";
    } else if (data.status === "already_danger") {
      valueEl.textContent = "Already critical";
      detailEl.textContent = "Water level has reached the danger threshold";
    } else {
      valueEl.textContent = "--";
      detailEl.textContent = data.message || "Not enough data yet";
    }
  } catch (err) {
    console.error("Failed to fetch ETA prediction:", err);
    document.getElementById("eta-detail").textContent = "Prediction service unavailable";
  }
}

/* ---------- Chart ---------- */

function initChart() {
  const ctx = document.getElementById("history-chart").getContext("2d");
  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Water level (cm)",
          data: [],
          borderColor: "#22d3ee",
          backgroundColor: "rgba(34, 211, 238, 0.15)",
          fill: true,
          tension: 0.3,
        },
        {
          label: "Warning",
          data: [],
          borderColor: "#f59e0b",
          borderDash: [6, 4],
          pointRadius: 0,
        },
        {
          label: "Danger",
          data: [],
          borderColor: "#ef4444",
          borderDash: [6, 4],
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false, // instant updates look better without easing on live data
      scales: {
        y: { min: 0, max: MAX_SCALE },
      },
    },
  });
}

function updateChart(history) {
  chart.data.labels = history.map((p) =>
    new Date(p.recorded_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
  chart.data.datasets[0].data = history.map((p) => p.water_level);
  chart.data.datasets[1].data = history.map(() => WARNING_LEVEL);
  chart.data.datasets[2].data = history.map(() => DANGER_LEVEL);
  chart.update();
}

/* ---------- Render everything from current historyData ---------- */

function renderAll() {
  if (historyData.length === 0) return;

  const latest = historyData[historyData.length - 1];
  const recordedAt = new Date(latest.recorded_at);

  let rate = 0;
  if (historyData.length >= 2) {
    const a = historyData[historyData.length - 2];
    const b = latest;
    const minutes = (new Date(b.recorded_at) - new Date(a.recorded_at)) / 60000;
    if (minutes > 0) rate = (b.water_level - a.water_level) / minutes;
  }

  updateStatCards(latest.water_level, recordedAt, rate);
  updateTank(latest.water_level);
  updateChart(historyData);
  updateLog(historyData);
  updateEtaPrediction();
}

/* ---------- Start ---------- */

window.addEventListener("DOMContentLoaded", async () => {
  initChart();
  await loadInitialHistory(); // draw existing history first
  connectWebSocket();         // then start receiving live updates
});