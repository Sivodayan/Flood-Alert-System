"""
Fake flood sensor (Python version of fake_sensor.ino)
Sends simulated water level readings to POST /api/readings
Payload: {"sensor_id":"1","water_level":23.4,"water_rising_speed":1.2}

Install dependency:  pip install requests
Run:                 python fake_sensor.py
"""

import random
import time

import requests

# ---------- CONFIG ----------
SERVER_URL = "http://192.168.8.103:8080/api/readings"  # Node server IP:port
SENSOR_ID = "1"                                        # must match dashboard

SEND_INTERVAL_S = 2.0

# Simulated time runs this many times faster than real time so the demo
# reaches the alert/danger marks in a few minutes. Set to 1.0 for real-time.
SIM_SPEEDUP = 10.0

# ---------- SCENARIO ----------
# (name, rise rate in cm per simulated minute, real-time duration in seconds)
PHASES = [
    ("steady",     0.0, 20),
    ("slow rise",  1.0, 60),
    ("surge",      3.0, 40),
    ("recede",    -2.0, 60),
]
START_LEVEL_CM = 20.0


def send_reading(phase_name, water_level, rising_speed):
    body = {
        "sensor_id": SENSOR_ID,
        "water_level": round(water_level, 1),
        "water_rising_speed": round(rising_speed, 1),
    }
    try:
        r = requests.post(SERVER_URL, json=body, timeout=3)
        print(f"[{phase_name}] {body} -> HTTP {r.status_code}")
    except requests.RequestException as e:
        print(f"[{phase_name}] {body} -> ERROR: {e}")


def main():
    level = START_LEVEL_CM
    phase_index = 0
    phase_start = time.monotonic()
    last_send = None

    print(f"Sending to {SERVER_URL} (Ctrl+C to stop)")
    print(f"--- Phase: {PHASES[phase_index][0]} ---")

    try:
        while True:
            now = time.monotonic()

            # Simulated minutes elapsed since the last send
            elapsed = SEND_INTERVAL_S if last_send is None else now - last_send
            dt_min = (elapsed / 60.0) * SIM_SPEEDUP
            last_send = now

            # Move to next phase when the current one is done (loops forever)
            name, rate, duration = PHASES[phase_index]
            if now - phase_start >= duration:
                phase_index = (phase_index + 1) % len(PHASES)
                phase_start = now
                if phase_index == 0:
                    level = START_LEVEL_CM  # reset the cycle
                name, rate, duration = PHASES[phase_index]
                print(f"--- Phase: {name} ---")

            level = max(0.0, level + rate * dt_min)

            # Small sensor noise (+/- 0.1 on level, +/- 0.1 on rate)
            noisy_level = max(0.0, level + random.randint(-10, 10) / 100.0)
            noisy_rate = rate + random.randint(-10, 10) / 100.0

            send_reading(name, noisy_level, noisy_rate)
            time.sleep(SEND_INTERVAL_S)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()