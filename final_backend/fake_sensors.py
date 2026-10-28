#!/usr/bin/env python3
"""
Fake flood-sensor node: behaves like the sensor ESP32 (sensor_espoo32.ino) but
generates simulated water levels, so you can test the Node server, the ML service,
the dashboard and the alarm ESP32 without any hardware.

Every --interval seconds (default 3, same as PUSH_INTERVAL on the ESP32) it
"measures" the 3 tanks and sends ONE request per tank:

    POST http://<host>/api/readings
    { "sensor_id": 1, "water_level": 5.4, "water_rising_speed": 0.85 }

Like the firmware it:
  * fires 5 noisy pings per tank, drops invalid ones, takes median + inlier average
  * converts distance -> level with tank height 21 cm and sensor offset 3 cm
  * computes the rising speed (cm/min) as a least-squares slope over the last 60 s
  * reports speed 0 inside a +-0.15 cm/min dead-band
  * skips a tank when fewer than 3 pings were valid (nothing is sent for it)

Needs only the Python standard library (no pip install).

Examples
    python fake_sensors.py                              # sensors 1-3, localhost:8080
    python fake_sensors.py --host 192.168.4.2:8080      # server on another machine
    python fake_sensors.py --s1 calm --s2 rising --s3 flood
    python fake_sensors.py --speedup 10                 # run the scenarios 10x faster
    python fake_sensors.py --count 20                   # stop after 20 cycles
    python fake_sensors.py --faults                     # randomly drop sensor readings

Scenarios (each repeats forever):
    calm     stays around 3 cm                       -> "safe"
    rising   2 -> 11 cm in 4 min, then recedes       -> Early_warning, Warning, DANGER
    flood    sudden surge to ~16 cm, slow recession  -> fast rise, then DANGER
    random   bounded random walk between 1 and 14 cm
Thresholds in the server: Warning >= 8 cm, DANGER >= 10 cm, fast rise > 2 cm/min.
Stop with Ctrl+C.
"""

import argparse
import json
import math
import random
import statistics
import time
import urllib.error
import urllib.request

# --- Same constants as the Arduino sketch -----------------------------------
TANK_HEIGHT = 21.0          # usable tank height (cm)
SENSOR_OFFSET = 3.0         # sensor-to-top offset (cm)
NUM_SAMPLES = 5             # pings per tank per cycle
MIN_VALID_SAMPLES = 3       # need at least this many good pings
INLIER_BAND_CM = 1.0        # pings further than this from the median are dropped
SPEED_WINDOW_S = 60.0       # least-squares window
MIN_SPEED_SAMPLES = 6
MIN_SPEED_SPAN_S = 15.0
SPEED_DEADBAND = 0.15       # cm/min

PING_NOISE_CM = 0.15        # std-dev of a single ping
PING_LOSS_RATE = 0.04       # chance that one ping returns nothing

# --- Scenarios: (seconds, level cm) key-points, repeated every `period` -----
SCENARIOS = {
    "calm": {
        "period": 240,
        "points": [(0, 3.0), (60, 3.4), (120, 3.0), (180, 2.7), (240, 3.0)],
    },
    "rising": {
        "period": 720,
        "points": [(0, 2.0), (60, 2.0), (300, 11.0), (360, 11.0), (660, 2.0), (720, 2.0)],
    },
    "flood": {
        "period": 900,
        "points": [(0, 3.0), (120, 3.0), (240, 16.0), (300, 16.0), (600, 3.0), (900, 3.0)],
    },
}


def piecewise(points, period, t):
    """Linear interpolation through key-points, repeating every `period` seconds."""
    t = t % period
    for (t0, v0), (t1, v1) in zip(points, points[1:]):
        if t0 <= t <= t1:
            return v0 if t1 == t0 else v0 + (v1 - v0) * (t - t0) / (t1 - t0)
    return points[-1][1]


class FakeTank:
    def __init__(self, sensor_id, scenario):
        self.sensor_id = sensor_id
        self.scenario = scenario
        self.history = []                 # [(sim_time_s, level)]
        self.walk = random.uniform(3, 6)  # state for the "random" scenario
        self.fault_cycles = 0             # >0 while a simulated fault is active

    # ----- the "real" water level in the tank --------------------------------
    def true_level(self, t):
        if self.scenario == "random":
            self.walk += random.uniform(-0.4, 0.4)
            self.walk = min(14.0, max(1.0, self.walk))
            return self.walk
        sc = SCENARIOS[self.scenario]
        return piecewise(sc["points"], sc["period"], t)

    # ----- one ultrasonic ping -----------------------------------------------
    def ping(self, true_level):
        if random.random() < PING_LOSS_RATE:
            return None                                   # no echo
        distance = (TANK_HEIGHT + SENSOR_OFFSET) - true_level
        return distance + random.gauss(0, PING_NOISE_CM)

    # ----- one measurement cycle (mirrors processTank) -----------------------
    def measure(self, t):
        true_level = self.true_level(t)
        if self.fault_cycles > 0:
            self.fault_cycles -= 1
            return None, "sensor fault (simulated)"

        samples = [d for d in (self.ping(true_level) for _ in range(NUM_SAMPLES)) if d is not None]
        if len(samples) < MIN_VALID_SAMPLES:
            return None, f"only {len(samples)}/{NUM_SAMPLES} valid pings"

        median = statistics.median(samples)
        inliers = [d for d in samples if abs(d - median) <= INLIER_BAND_CM]
        distance = sum(inliers) / len(inliers)

        level = (TANK_HEIGHT + SENSOR_OFFSET) - distance
        level = min(TANK_HEIGHT, max(0.0, level))

        self.add_history(t, level)
        return (level, self.speed()), None

    # ----- least-squares rising speed (mirrors historyAdd/computeSpeed) ------
    def add_history(self, t, level):
        self.history = [(ts, lv) for ts, lv in self.history if t - ts <= SPEED_WINDOW_S]
        self.history.append((t, level))

    def speed(self):
        if len(self.history) < MIN_SPEED_SAMPLES:
            return 0.0
        if self.history[-1][0] - self.history[0][0] < MIN_SPEED_SPAN_S:
            return 0.0
        t0 = self.history[0][0]
        xs = [(ts - t0) / 60.0 for ts, _ in self.history]      # minutes
        ys = [lv for _, lv in self.history]
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        sxx = sum((x - mx) ** 2 for x in xs)
        if sxx <= 0:
            return 0.0
        slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx   # cm/min
        return 0.0 if abs(slope) < SPEED_DEADBAND else slope


def post_reading(url, sensor_id, level, speed, timeout=3.0):
    payload = {
        "sensor_id": sensor_id,
        "water_level": round(level, 1),
        "water_rising_speed": round(speed, 2),
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return payload, resp.status, resp.read().decode()


def main():
    ap = argparse.ArgumentParser(description="Fake 3-sensor flood node (sends to /api/readings)")
    ap.add_argument("--host", default="localhost:8080", help="Node server host:port (default localhost:8080)")
    ap.add_argument("--interval", type=float, default=3.0, help="seconds between cycles (default 3)")
    ap.add_argument("--speedup", type=float, default=1.0,
                    help="run the scenarios N times faster than real time (default 1)")
    ap.add_argument("--count", type=int, default=0, help="stop after N cycles (default: run forever)")
    ap.add_argument("--faults", action="store_true", help="randomly simulate sensor dropouts")
    ap.add_argument("--seed", type=int, default=None, help="random seed for repeatable runs")
    choices = list(SCENARIOS) + ["random"]
    ap.add_argument("--s1", choices=choices, default="calm", help="scenario for sensor 1 (default calm)")
    ap.add_argument("--s2", choices=choices, default="rising", help="scenario for sensor 2 (default rising)")
    ap.add_argument("--s3", choices=choices, default="flood", help="scenario for sensor 3 (default flood)")
    args = ap.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    url = f"http://{args.host}/api/readings"
    tanks = [FakeTank(1, args.s1), FakeTank(2, args.s2), FakeTank(3, args.s3)]

    print(f"Fake sensor node -> {url}")
    for tk in tanks:
        print(f"  sensor_id {tk.sensor_id}: {tk.scenario}")
    print(f"Every {args.interval:g}s, scenarios x{args.speedup:g}. Ctrl+C to stop.\n")

    start = time.monotonic()
    cycle = 0
    try:
        while True:
            cycle += 1
            t = (time.monotonic() - start) * args.speedup          # simulated seconds
            print(f"--- cycle {cycle} (sim time {t:6.0f}s) ---")

            for tk in tanks:
                # optional random sensor dropout (3 cycles, like FAULT_AFTER_CYCLES)
                if args.faults and tk.fault_cycles == 0 and random.random() < 0.01:
                    tk.fault_cycles = 3

                result, problem = tk.measure(t)
                if result is None:
                    print(f"[WARN] Tank {tk.sensor_id}: {problem}, NOT sent")
                    continue

                level, speed = result
                if not (math.isfinite(level) and math.isfinite(speed)):
                    print(f"[ERROR] Tank {tk.sensor_id}: level/speed is not a number, NOT sent")
                    continue

                try:
                    payload, code, body = post_reading(url, tk.sensor_id, level, speed)
                    print(f"POST {json.dumps(payload)} -> {code} {body}")
                except urllib.error.HTTPError as e:
                    print(f"[ERROR] Tank {tk.sensor_id}: server answered HTTP {e.code}: {e.read().decode()}")
                except (urllib.error.URLError, OSError) as e:
                    print(f"[ERROR] Server http://{args.host} unreachable ({e}) - is the Node server running?")
                    break          # same as the firmware: skip the other tanks this round

            if args.count and cycle >= args.count:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()