import math
import os
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta, timezone

import numpy as np
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

DB_PATH = os.environ.get("FLOOD_DB_PATH", "flood_data.db")
DANGER_LEVEL = 50.0          # cm
MIN_POINTS = 5               # minimum readings needed to fit a model
WINDOW = 30                  # how many recent readings to fit
MAX_DEGREE = 2               # 1 = linear, 2 = quadratic (higher degrees extrapolate badly)
MAX_HORIZON_MIN = 24 * 60    # ignore predictions further away than 24 hours
STALE_AFTER_MIN = 15         # latest reading older than this -> data considered stale

app = FastAPI(title="Flood ETA Prediction Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------
# Data access
# --------------------------------------------------------------------------
def sensor_candidates(sensor_id: str):
    """The dashboard sends 'sensor_01' but the ESP32 may store 1 / '1' / 'sensor_01'.
    Try every form so the lookup works whichever one is in the database."""
    candidates = [sensor_id]
    digits = re.sub(r"\D", "", sensor_id)
    if digits:
        n = int(digits)
        candidates += [n, str(n), f"sensor_{n:02d}"]
    return list(dict.fromkeys(candidates))


def parse_time(value) -> datetime:
    dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if dt.tzinfo is None:                       # treat naive timestamps as UTC
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def get_readings(sensor_id: str, limit: int):
    """Latest `limit` readings for the sensor, oldest first, as (datetime, level)."""
    candidates = sensor_candidates(sensor_id)
    placeholders = ",".join("?" for _ in candidates)
    with closing(sqlite3.connect(DB_PATH)) as conn:
        rows = conn.execute(
            f"""
            SELECT water_level, recorded_at FROM readings
            WHERE sensor_id IN ({placeholders})
              AND water_level IS NOT NULL
              AND recorded_at IS NOT NULL
            ORDER BY recorded_at DESC
            LIMIT ?
            """,
            (*candidates, limit),
        ).fetchall()

    readings = []
    for level, recorded_at in reversed(rows):
        try:
            readings.append((parse_time(recorded_at), float(level)))
        except (ValueError, TypeError):
            continue                            # skip malformed rows
    return readings


# --------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------
def fit_best_polynomial(x: np.ndarray, y: np.ndarray):
    """Fit polynomials of degree 1..MAX_DEGREE and keep the best one.

    Selection uses BIC, which penalises extra terms, and a higher degree is only
    chosen when it is clearly better. This stops the curve from over-fitting
    sensor noise and then extrapolating wildly.
    """
    n = len(x)
    tss = float(np.sum((y - y.mean()) ** 2))
    best = None

    for degree in range(1, MAX_DEGREE + 1):
        if n < degree + 3:                      # keep spare points so the fit is meaningful
            break
        coeffs = np.polyfit(x, y, degree)
        rss = float(np.sum((y - np.polyval(coeffs, x)) ** 2))
        bic = n * math.log(max(rss / n, 1e-9)) + (degree + 1) * math.log(n)
        r2 = 1.0 - rss / tss if tss > 1e-12 else 1.0

        if best is None or bic < best["bic"] - 2.0:
            best = {"degree": degree, "coeffs": coeffs, "bic": bic, "r2": r2}

    return best


def compute_prediction(sensor_id: str) -> dict:
    try:
        readings = get_readings(sensor_id, WINDOW)
    except sqlite3.Error as exc:
        return {"status": "error", "message": f"Database error: {exc}"}

    n = len(readings)
    if n < MIN_POINTS:
        return {
            "status": "not_enough_data",
            "message": f"Need at least {MIN_POINTS} readings, have {n}",
        }

    times = [t for t, _ in readings]
    t0 = times[0]
    x = np.array([(t - t0).total_seconds() / 60.0 for t in times])   # minutes since first reading
    y = np.array([lvl for _, lvl in readings])

    if x[-1] - x[0] < 1e-6:
        return {"status": "not_enough_data", "message": "All readings share the same timestamp"}

    now = datetime.now(timezone.utc)
    age_min = (now - times[-1]).total_seconds() / 60.0
    level_now = float(y[-1])

    if age_min > STALE_AFTER_MIN:
        return {
            "status": "stale_data",
            "current_level": round(level_now, 2),
            "message": f"Latest reading is {age_min:.0f} min old",
        }

    # Check danger FIRST (the old code checked "not rising" first, so a level above
    # the danger mark that had stopped rising was reported as just "not_rising").
    if level_now >= DANGER_LEVEL:
        return {"status": "already_danger", "current_level": round(level_now, 2)}

    fit = fit_best_polynomial(x, y)
    coeffs = fit["coeffs"]
    t_last = float(x[-1])
    slope = float(np.polyval(np.polyder(coeffs), t_last))   # cm/min at the latest reading

    base = {
        "current_level": round(level_now, 2),
        "danger_level": DANGER_LEVEL,
        "rate_cm_per_min": round(slope, 3),
        "r_squared": round(float(fit["r2"]), 3),
        "model": "polynomial",
        "degree": fit["degree"],
    }

    if slope <= 0:
        return {"status": "not_rising", **base}

    # Solve  p(t) = DANGER_LEVEL  and take the first crossing after the latest reading
    target = coeffs.copy()
    target[-1] -= DANGER_LEVEL
    crossings = [
        float(r.real)
        for r in np.roots(target)
        if abs(r.imag) < 1e-7 and t_last - 1e-9 <= r.real <= t_last + MAX_HORIZON_MIN
    ]
    if not crossings:
        return {
            "status": "not_rising",
            "message": "Trend is not projected to reach the danger level",
            **base,
        }

    t_cross = min(crossings)
    now_min = (now - t0).total_seconds() / 60.0
    eta_min = max(0.0, t_cross - now_min)          # minutes from NOW (not from the last reading)
    eta_ts = now + timedelta(minutes=eta_min)

    return {
        "status": "ok",
        **base,
        "eta_minutes": round(eta_min, 1),
        "eta_timestamp": eta_ts.isoformat(),
    }


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
@app.get("/predict")
def predict(sensor_id: str = Query(...)):
    result = compute_prediction(sensor_id)
    result["sensor_id"] = sensor_id

    print(
        f"[PREDICT] sensor_id={sensor_id} "
        f"status={result['status']} "
        f"eta_min={result.get('eta_minutes', '-')} "
        f"level={result.get('current_level', '-')}cm "
        f"rate={result.get('rate_cm_per_min', '-')}cm/min "
        f"degree={result.get('degree', '-')} "
        f"r2={result.get('r_squared', '-')}",
        flush=True,
    )
    return result