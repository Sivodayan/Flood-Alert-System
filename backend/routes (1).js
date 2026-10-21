const express = require('express');
const { insertReading, getLatest, getHistory } = require('./db');
const { broadcastReading } = require('./websocket')
const {sendSMS}=require('./sms')
const router = express.Router()

// ---------------------------------------------------------------
// DANGER LEVEL STATE (polled by the ESP32 in final.cpp)
// ---------------------------------------------------------------
const ALERT_MARK = 35.0;      // cm  -> Warning
const DANGER_MARK = 50.0;     // cm  -> DANGER
const FAST_RISE = 2.0;        // cm/min -> Early_warning

const LEVEL_RANK = { safe: 0, Early_warning: 1, Warning: 2, DANGER: 3 };

const sensorLevels = {};      // latest auto-computed level per sensor_id
let manualLevel = 'safe';     // set by POST /api/alert (dashboard button)

function levelFromReading(waterLevel, riseRate) {
  if (waterLevel >= DANGER_MARK) return 'DANGER';
  if (waterLevel >= ALERT_MARK) return 'Warning';
  if (riseRate > FAST_RISE) return 'Early_warning';
  return 'safe';
}

// Highest level across all sensors and the manual override wins.
function getOverallLevel() {
  let worst = manualLevel;
  for (const lvl of Object.values(sensorLevels)) {
    if (LEVEL_RANK[lvl] > LEVEL_RANK[worst]) worst = lvl;
  }
  return worst;
}

router.post('/api/readings', (req, res) => {// from ultra sonic sensors
  console.log(req.body)
  const { sensor_id, water_level, water_rising_speed} = req.body;//water rising speed is no need to store in db for now
  const recorded_at = new Date().toISOString()

  sensorLevels[sensor_id] = levelFromReading(Number(water_level), Number(water_rising_speed) || 0);

  broadcastReading({
    sensor_id,
    water_level,
    recorded_at,
    water_rising_level: water_rising_speed, // was an undefined variable before
    danger_level: getOverallLevel(),
  });
  console.log(`Received from ${sensor_id}: ${water_level} cm -> ${sensorLevels[sensor_id]}`)
  insertReading.run(sensor_id, water_level, recorded_at);

  res.json({ status: 'ok' })
});

// ESP32 polls this. Plain text so the ESP32 needs no JSON library.
// Returns one of: DANGER | Warning | Early_warning | safe
router.get('/api/danger-level', (req, res) => {
  res.type('text/plain').send(getOverallLevel());
});

const VALID_ALERT_STATUSES = ['DANGER', 'Warning', 'Early_warning', 'safe'];

router.post('/api/alert', async (req,res)=>{
  // create alert buttons for this in frontenb.so it can be triggered automatically or manually.
  //location is mapped to the sensor_id
  //during devlpoment no need for the the real phone numbers.
  //do not change this.
  const {alert,ETA,location}= req.body
  if (typeof alert !== 'string' || !VALID_ALERT_STATUSES.includes(alert)) { // was checking undefined "status"
    return res.status(400).json({
      error: `Invalid or missing "alert". Must be one of: ${VALID_ALERT_STATUSES.join(', ')}`,
    });
  }

  manualLevel = alert; // ESP32 will pick this up on its next poll ("safe" clears it)

  try{
  if (alert=="DANGER"){
    sendSMS("+94xxx","Please evcuate immedietly .. location " +location)
  }else if(alert=="Warning"){
    sendSMS("+94xxx",`Floodwater is expected to arrive in approximately ${ETA}`)
  }else if(alert=="Early_warning"){
    sendSMS("+94","")
  }else if(alert=="safe")
  {
    sendSMS("+94","")
  }
}catch(error){
  console.error('Failed to send alert SMS:', error);
  return res.status(502).json({ error: 'Failed to send SMS alert' }); // return, so we don't send two responses
}
  res.json({status:"sent"})
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


  const rows = getHistory.all(sensor_id, Number(limit));
  res.json(rows);
});

module.exports = router;
