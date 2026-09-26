

const express = require('express');
const { insertReading, getLatest, getHistory } = require('./db');
const { broadcastReading } = require('./websocket')
const {sendSMS}=require('./sms')
const router = express.Router()

router.post('/api/readings', (req, res) => {// from ultra sonic sensors
  const { sensor_id, water_level, water_rising_speed} = req.body;//water risng speed is no need to store in db for now
  const recorded_at = new Date().toISOString()

  broadcastReading({ sensor_id, water_level, recorded_at ,water_rising_speed});
  console.log(`Received from ${sensor_id}: ${water_level} cm`)
  insertReading.run(sensor_id, water_level, recorded_at);

  res.json({ status: 'ok' })
});
const VALID_ALERT_STATUSES = ['DANGER', 'Warning', 'Early_warning', 'safe'];

router.post('/api/alert', async (req,res)=>{
  // create alert buttons for this in frontenb.so it can be triggered automatically or manually.
  //location is mapped to the sensor_id
  //during devlpoment no need for the the real phone numbers.
  //do not change this.
  const {alert,ETA,location}= req.body
  if (typeof alert !== 'string' || !VALID_ALERT_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `Invalid or missing "status". Must be one of: ${VALID_ALERT_STATUSES.join(', ')}`,
    });
  }
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
  res.status(502).json({ error: 'Failed to send SMS alert' });
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
