const express = require('express');
const { insertReading, getLatest, getHistory } = require('./db');
const { broadcastReading } = require('./websocket');
const { sendSMS } = require('./sms');

const router = express.Router();

const ALERT_PHONE = process.env.ALERT_PHONE || '+94xxx';
if (ALERT_PHONE === '+94xxx') {
  console.warn('[SMS] ALERT_PHONE is not set - using placeholder "+94xxx", real SMS will not be delivered.');
}

const ALERT_MARK  = 8.0;  // cm -> Warning
const DANGER_MARK = 10.0; // cm -> DANGER
const FAST_RISE   = 3.0;  // cm/min -> Early_warning

// How long a manual button alert overrides sensor readings (60 seconds)
const MANUAL_OVERRIDE_TTL_MS = 60 * 1000;

const TANK_MAP   = { sensor_01: 'A', sensor_02: 'B', sensor_03: 'C' };
const LEVEL_RANK = { safe: 0, Early_warning: 1, Warning: 2, DANGER: 3 };

const autoLevels      = { A: 'safe', B: 'safe', C: 'safe' };
const manualLevels    = { A: 'safe', B: 'safe', C: 'safe' };
const manualExpiresAt = { A: 0,      B: 0,      C: 0      };

function toSensorKey(id) {
  const n = parseInt(String(id).replace(/\D/g, ''), 10);
  const key = Number.isNaN(n) ? null : `sensor_0${n}`;
  return key && key in TANK_MAP ? key : null;
}

function levelFromReading(waterLevel, riseRate) {
  if (waterLevel >= DANGER_MARK) return 'DANGER';
  if (waterLevel >= ALERT_MARK)  return 'Warning';
  if (riseRate > FAST_RISE)      return 'Early_warning';
  return 'safe';
}

// Returns the active level for a tank (expires manual overrides automatically)
function effectiveLevel(tank) {
  if (manualLevels[tank] !== 'safe' && Date.now() > manualExpiresAt[tank]) {
    console.log(`[ALERT] Manual override for Tank ${tank} expired. Reverting to sensor level (${autoLevels[tank]}).`);
    manualLevels[tank] = 'safe';
  }
  return LEVEL_RANK[manualLevels[tank]] > LEVEL_RANK[autoLevels[tank]]
    ? manualLevels[tank]
    : autoLevels[tank];
}

function buildAlarmPayload() {
  const tanks = {};
  const triggered = [];
  let overall = 'safe';

  for (const [sensor_id, tank] of Object.entries(TANK_MAP)) {
    const level = effectiveLevel(tank);
    const isTriggered = level !== 'safe';
    tanks[sensor_id] = { tank, level, triggered: isTriggered };
    if (isTriggered) triggered.push(sensor_id);
    if (LEVEL_RANK[level] > LEVEL_RANK[overall]) overall = level;
  }
  return { alert: overall, triggered, tanks };
}

router.post('/api/readings', (req, res) => {
  const { sensor_id, water_level, water_rising_speed } = req.body;
  const recorded_at = new Date().toISOString();

  if (!sensor_id || typeof water_level !== 'number') {
    return res.status(400).json({ error: 'sensor_id and numeric water_level required' });
  }

  const sensorKey = toSensorKey(sensor_id);
  const tank = TANK_MAP[sensorKey];
  if (!tank) {
    return res.status(400).json({ error: `Unknown sensor_id. Must be one of: ${Object.keys(TANK_MAP).join(', ')}` });
  }

  const riseRate = typeof water_rising_speed === 'number' ? water_rising_speed : 0;
  const level = levelFromReading(water_level, riseRate);
  autoLevels[tank] = level;

  const currentEffective = effectiveLevel(tank);

  broadcastReading({
    type: 'reading',
    sensor_id: sensorKey,
    tank,
    level: currentEffective,
    water_level,
    recorded_at,
    water_rising_speed: riseRate
  });

  console.log(`[SENSOR] ${sensorKey} (Tank ${tank}): ${water_level} cm (${riseRate} cm/min) -> Sensor: ${level} | Effective: ${currentEffective}`);
  insertReading.run(sensorKey, water_level, recorded_at);

  res.json({ status: 'ok', tank, level: currentEffective });
});

const VALID_ALERT_STATUSES = ['DANGER', 'Warning', 'Early_warning', 'safe'];

router.get('/api/alarm', (req, res) => {
  res.json(buildAlarmPayload());
});

router.post('/api/alert', async (req, res) => {
  const { alert, ETA, location } = req.body;
  if (typeof alert !== 'string' || !VALID_ALERT_STATUSES.includes(alert)) {
    return res.status(400).json({
      error: `Invalid or missing "alert". Must be one of: ${VALID_ALERT_STATUSES.join(', ')}`,
    });
  }

  const tank = TANK_MAP[toSensorKey(location)];
  if (!tank) {
    return res.status(400).json({
      error: `Invalid or missing "location". Must be one of: ${Object.keys(TANK_MAP).join(', ')}`,
    });
  }

  const needsETA = alert === 'Early_warning' || alert === 'Warning';
  if (needsETA && (ETA === undefined || ETA === null || String(ETA).trim() === '')) {
    return res.status(400).json({ error: `"ETA" is required when alert is ${alert}` });
  }

  // Set manual override and expiration timer
  manualLevels[tank] = alert;
  manualExpiresAt[tank] = alert === 'safe' ? 0 : Date.now() + MANUAL_OVERRIDE_TTL_MS;

  let message;
  if (alert === 'DANGER') {
    message = `DANGER: Please evacuate immediately. Location: ${location}`;
  } else if (alert === 'Warning') {
    message = `WARNING: Water level is high at ${location}. Estimated floodwater arrival: ${ETA}`;
  } else if (alert === 'Early_warning') {
    message = `EARLY WARNING: Water is rising quickly at ${location}. Estimated floodwater arrival: ${ETA}`;
  } else {
    message = `SAFE: Water level at ${location} is back to normal`;
  }

  try {
    console.log(`[SMS] Sending "${message}"`);
    const smsResult = await sendSMS(ALERT_PHONE, message);
    console.log('[SMS] Provider result:', smsResult);
  } catch (error) {
    console.error('Failed to send alert SMS:', error);
    return res.status(502).json({ error: 'Failed to send SMS alert' });
  }

  const response = { status: 'sent', alert_type: alert, location, tank, level: effectiveLevel(tank) };
  if (needsETA) response.ETA = ETA;
  res.json(response);
});
router.get('/api/history', (req, res) => {
  const { sensor_id, limit = 30 } = req.query;
  const sensorKey = toSensorKey(sensor_id) || String(sensor_id);
  const rows = getHistory.all(sensorKey, Number(limit));
  res.json(rows);
});

module.exports = router;