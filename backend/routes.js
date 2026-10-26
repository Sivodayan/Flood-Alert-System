const express = require('express');
const { insertReading, getLatest, getHistory } = require('./db');
const { broadcastReading } = require('./websocket')
const {sendSMS}=require('./sms')
const router = express.Router()
// Destination for alert SMS. Set ALERT_PHONE in the environment (e.g. ALERT_PHONE=+94771234567).
const ALERT_PHONE = process.env.ALERT_PHONE || '+94xxx';
if (ALERT_PHONE === '+94xxx') {
  console.warn('[SMS] ALERT_PHONE is not set - using placeholder "+94xxx", real SMS will not be delivered.');
}

const ALERT_MARK = 35.0;      // cm  -> Warning
const DANGER_MARK = 50.0;     // cm  -> DANGER
const FAST_RISE = 2.0; 
const TANK_MAP = { sensor_01: 'A', sensor_02: 'B', sensor_03: 'C' };
const TANKS = ['A', 'B', 'C'];
 
const LEVEL_RANK = { safe: 0, Early_warning: 1, Warning: 2, DANGER: 3 };
 
const autoLevels   = { A: 'safe', B: 'safe', C: 'safe' };  // from sensor readings
const manualLevels = { A: 'safe', B: 'safe', C: 'safe' };  // from POST /api/alert

// Accepts 'sensor_01', 'sensor_1', 1 or '1' and returns the key used in TANK_MAP (or null)
function toSensorKey(id) {
  const n = parseInt(String(id).replace(/\D/g, ''), 10);
  const key = Number.isNaN(n) ? null : `sensor_0${n}`;
  return key && key in TANK_MAP ? key : null;
}

function levelFromReading(waterLevel, riseRate) {
  if (waterLevel >= DANGER_MARK) return 'DANGER';
  if (waterLevel >= ALERT_MARK) return 'Warning';
  if (riseRate > FAST_RISE) return 'Early_warning';
  return 'safe';
}

// The higher of the automatic (sensor) level and the manual (button) level wins.
function effectiveLevel(tank) {
  return LEVEL_RANK[manualLevels[tank]] > LEVEL_RANK[autoLevels[tank]]
    ? manualLevels[tank]
    : autoLevels[tank];
}

// Build the payload the second ESP32 reads.
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

router.post('/api/readings', (req, res) => {// from ultra sonic sensors
  
  const { sensor_id, water_level, water_rising_speed} = req.body;//water risng level is no need to store in db for now

  const recorded_at = new Date().toISOString()
  console.log(sensor_id, water_level, water_rising_speed)
  if (!sensor_id || typeof water_level !== 'number') {
    return res.status(400).json({ error: 'sensor_id and numeric water_level required' });
  }

  const tank = TANK_MAP[toSensorKey(sensor_id)];
  if (!tank) {
    return res.status(400).json({ error: `Unknown sensor_id. Must be one of: ${Object.keys(TANK_MAP).join(', ')}` });
  }

  const riseRate = typeof water_rising_speed === 'number' ? water_rising_speed : 0;

  // update the automatic alert level for this sensor's tank
  const level = levelFromReading(water_level, riseRate);
  autoLevels[tank] = level;

  broadcastReading({type: 'reading', sensor_id, tank, level, water_level, recorded_at ,water_rising_speed});
  console.log(`Received from ${sensor_id} (tank ${tank}): ${water_level} cm -> ${level}`)
  insertReading.run(sensor_id, water_level, recorded_at);

  res.json({ status: 'ok', tank, level })
});

const VALID_ALERT_STATUSES = ['DANGER', 'Warning', 'Early_warning', 'safe'];

// Polled by the second ESP32.
// Example response:
// {
//   "alert": "Warning",                      // highest level across all tanks
//   "triggered": ["sensor_01"],              // sensors whose level is not "safe"
//   "tanks": {
//     "sensor_01": { "tank": "A", "level": "Warning", "triggered": true },
//     "sensor_02": { "tank": "B", "level": "safe",    "triggered": false },
//     "sensor_03": { "tank": "C", "level": "safe",    "triggered": false }
//   }
// }
router.get('/api/alarm', (req, res) => {
  res.json(buildAlarmPayload())
})

router.post('/api/alert', async (req,res)=>{
  // create alert buttons for this in frontenb.so it can be triggered automatically or manually.
  //location is mapped to the sensor_id
  //during devlpoment no need for the the real phone numbers.
  //do not change this.
  const {alert,ETA,location}= req.body
  if (typeof alert !== 'string' || !VALID_ALERT_STATUSES.includes(alert)) {
    return res.status(400).json({
      error: `Invalid or missing "alert". Must be one of: ${VALID_ALERT_STATUSES.join(', ')}`,
    });
  }

  // location = sensor_id -> tank
  const tank = TANK_MAP[toSensorKey(location)];
  if (!tank) {
    return res.status(400).json({
      error: `Invalid or missing "location". Must be one of: ${Object.keys(TANK_MAP).join(', ')}`,
    });
  }

  // ETA (from the frontend, per location) is required for Early_warning and Warning
  const needsETA = alert === 'Early_warning' || alert === 'Warning';
  if (needsETA && (ETA === undefined || ETA === null || String(ETA).trim() === '')) {
    return res.status(400).json({ error: `"ETA" is required when alert is ${alert}` });
  }

  // remember the manual level so the ESP32 sees it on /api/alarm
  manualLevels[tank] = alert;

  // SMS text depends on the alert type
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
    const smsResult = await sendSMS(ALERT_PHONE, message)
    console.log('[SMS] Provider result:', smsResult);
  } catch (error) {
    console.error('Failed to send alert SMS:', error);
    return res.status(502).json({ error: 'Failed to send SMS alert' });
  }

  const response = { status: 'sent', alert_type: alert, location, tank, level: effectiveLevel(tank) };
  if (needsETA) response.ETA = ETA;   // only returned for Early_warning and Warning
  res.json(response)
})
  
//this is fo rthe test
/*router.get('/api/latest', (req, res) => {
  const { sensor_id } = req.query;
  const row = getLatest.get(sensor_id);
  if (!row) 
  return res.status(404).json({ error: 'No readings yet for this sensor' });
  res.json(row);
});*/

router.get('/api/history', (req, res) => {
  //limit is used for the how many data poitns display ins int the frontend
  const { sensor_id, limit = 30 } = req.query;
  console.log("bbb",sensor_id)

  const rows = getHistory.all(sensor_id, Number(limit));
  res.json(rows);
});

module.exports = router;