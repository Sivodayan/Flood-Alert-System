// db.js
// SQLite connection, schema, and prepared statements for flood sensor readings.

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'flood_data.db');
console.log('[DB] Using SQLite database at:', dbPath);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    reading_id INTEGER PRIMARY KEY AUTOINCREMENT,
    sensor_id TEXT NOT NULL,
    water_level REAL NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_readings_sensor_time
    ON readings (sensor_id, recorded_at);
`);

const insertReading = db.prepare(`
  INSERT INTO readings (sensor_id, water_level, recorded_at)
  VALUES (?, ?, ?)
`);

const getLatest = db.prepare(`
  SELECT sensor_id, water_level, recorded_at FROM readings
  WHERE sensor_id = ? ORDER BY recorded_at DESC LIMIT 1
`);

const getHistory = db.prepare(`
  SELECT sensor_id, water_level, recorded_at FROM (
    SELECT sensor_id, water_level, recorded_at FROM readings
    WHERE sensor_id = ? ORDER BY recorded_at DESC LIMIT ?
  ) ORDER BY recorded_at ASC
`);

module.exports = {
  db,
  insertReading,
  getLatest,
  getHistory,
};
