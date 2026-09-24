import sqlite3
from datetime import datetime, timedelta
import numpy as np
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from sklearn.linear_model import LinearRegression
//donot change any of this
DB_PATH = "flood_data.db"
DANGER_LEVEL = 50.0   
MIN_POINTS = 5        
WINDOW = 15            

app = FastAPI(title="Prediction")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)
def get_readings(sensor_id, limit):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT water_level, recorded_at FROM readings
        WHERE sensor_id = ?
        ORDER BY recorded_at DESC
        LIMIT ?
        """,
        (sensor_id, limit),
    ).fetchall()
    conn.close()
    rows.reverse()  
    return rows

@app.get("/predict")
def predict(sensor_id: str = Query(...)):
    rows = get_readings(sensor_id, WINDOW)

    if len(rows) < MIN_POINTS:
        return {
            "status": "not_enough_data",
            "message": f"Need at least {MIN_POINTS} readings, have {len(rows)}",
        }

    
    times = [datetime.fromisoformat(r["recorded_at"].replace("Z", "+00:00")) for r in rows]
    t0 = times[0]
    X = [(t - t0).total_seconds() for t in times]
    X = np.array(X).reshape(-1, 1)
    y = np.array([r["water_level"] for r in rows])

    model = LinearRegression()
    model.fit(X, y)

    slope = model.coef_[0]        
    r2 = model.score(X, y)
    level_now = y[-1]
    time_now = times[-1]

    if slope <= 0:
        return {
            "status": "not_rising",
            "current_level": round(float(level_now), 2),
            "rate_cm_per_min": round(float(slope * 60), 3),
            "r_squared": round(float(r2), 3),
        }
    if level_now >= DANGER_LEVEL:
        return {
            "status": "already_danger",
            "current_level": round(float(level_now), 2),
        }
    secs_left = (DANGER_LEVEL - level_now) / slope
    eta = time_now + timedelta(seconds=secs_left)
    return {
        "status": "ok",
        "current_level": round(float(level_now), 2),
        "danger_level": DANGER_LEVEL,
        "rate_cm_per_min": round(float(slope * 60), 3),
        "eta_minutes": round(secs_left / 60, 1),
        "eta_timestamp": eta.isoformat(),
        "r_squared": round(float(r2), 3),
    }
