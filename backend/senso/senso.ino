/*
 * Flood sensor node (ESP32 #1) - Wi-Fi Access Point & Ultrasonic Reader
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <algorithm>

// --- Wi-Fi network created by this ESP32 ---
const char* ssid     = "Flood_Sensor_Network";
const char* password = "adminpassword";

// --- Server IP (PC connected to this ESP32's Wi-Fi) ---
const char* SERVER_IP     = "192.168.4.2";
const int   SERVER_PORT   = 8080;
const char* READINGS_PATH = "/api/readings";

// --- Tank Calibration ---
// Make sure (height + offset) equals the exact distance in cm from the sensor face
// to the bottom of an EMPTY tank.
struct Tank {
    int   trigPin;
    int   echoPin;
    float height;       // usable water height (cm)
    float offset;       // gap from sensor to max water line (cm)
    float distance;     // last measured distance (cm)
    float waterLevel;   // calculated water height (cm)
    float speed;        // smoothed rise speed (cm/s)
    float prevLevel;
    bool  valid;
};

Tank tanks[3] = {
    {14, 27, 21.0, 3.0, 0, 0, 0, -1.0, false}, // Tank A (Total empty depth = 24 cm)
    {5,  18, 21.0, 3.0, 0, 0, 0, -1.0, false}, // Tank B
    {26, 25, 21.0, 3.0, 0, 0, 0, -1.0, false}  // Tank C
};

unsigned long lastPushTime = 0;
const unsigned long PUSH_INTERVAL = 3000;
const float ALPHA = 0.2;

// --- Median filter of 3 valid pings ---
float getFilteredDistance(int trig, int echo) {
    float readings[3];
    for (int i = 0; i < 3; i++) {
        digitalWrite(trig, LOW);  delayMicroseconds(2);
        digitalWrite(trig, HIGH); delayMicroseconds(10);
        digitalWrite(trig, LOW);
        long duration = pulseIn(echo, HIGH, 30000); // 30ms timeout (~5m max)
        readings[i] = (duration > 0) ? (duration * 0.0343 / 2.0) : 0.0;
        delay(20);
    }
    if (readings[0] > readings[1]) std::swap(readings[0], readings[1]);
    if (readings[1] > readings[2]) std::swap(readings[1], readings[2]);
    if (readings[0] > readings[1]) std::swap(readings[0], readings[1]);
    return readings[1];
}

// --- Measurement & Sanity Check ---
void measureTank(int index, Tank &t, float timeDelta) {
    float dist = getFilteredDistance(t.trigPin, t.echoPin);
    float totalDepth = t.height + t.offset; // 24.0 cm

    // 1. Timeout or unplugged sensor (0.0 cm) -> Default to SAFE (0 cm water)
    // 2. Dead-zone glitch (< 2.0 cm) -> Ignore noise
    // 3. Open-air / pointing at ceiling (> totalDepth + 5 cm) -> Clamp to empty tank (0 cm water)
    if (dist <= 0.0) {
        Serial.printf("[Tank %d] Sensor timeout/unplugged (0 cm). Reporting 0 cm water (safe).\n", index + 1);
        t.distance   = totalDepth;
        t.waterLevel = 0.0;
        t.speed      = 0.0;
        t.valid      = true;
        return;
    }

    if (dist < 2.0) {
        Serial.printf("[Tank %d] Glitch ignored (distance %.1f cm is inside sensor dead-zone < 2cm).\n", index + 1, dist);
        return; // Keep previous valid state
    }

    t.distance   = dist;
    t.waterLevel = totalDepth - dist;

    // Clamp water level between 0 and tank height
    if (t.waterLevel < 0.0) t.waterLevel = 0.0;
    if (t.waterLevel > t.height) t.waterLevel = t.height;

    if (t.prevLevel >= 0.0 && timeDelta > 0.0) {
        float rawSpeed = (t.waterLevel - t.prevLevel) / timeDelta; // cm/s
        if (fabs(rawSpeed) < 15.0) {
            t.speed = (ALPHA * rawSpeed) + ((1.0 - ALPHA) * t.speed);
        }
    }
    t.prevLevel = t.waterLevel;
    t.valid = true;

    Serial.printf("[Tank %d] Raw Dist: %.1f cm -> Water Level: %.1f cm (Speed: %.2f cm/min)\n",
                  index + 1, t.distance, t.waterLevel, t.speed * 60.0);
}

void pushReadingsToServer() {
    String url = String("http://") + SERVER_IP + ":" + SERVER_PORT + READINGS_PATH;

    HTTPClient http;
    http.setConnectTimeout(1500);
    http.setTimeout(2000);
    http.setReuse(true);
    if (!http.begin(url)) {
        Serial.println("[HTTP] begin() failed");
        return;
    }
    http.addHeader("Content-Type", "application/json");

    for (int i = 0; i < 3; i++) {
        if (!tanks[i].valid) continue;

        JsonDocument doc;
        doc["sensor_id"]          = i + 1;
        doc["water_level"]        = round(tanks[i].waterLevel * 10.0) / 10.0;
        doc["water_rising_speed"] = round(tanks[i].speed * 60.0 * 100.0) / 100.0; // cm/min

        String payload;
        serializeJson(doc, payload);

        int code = http.POST(payload);
        Serial.printf("POST Tank %d %s -> HTTP %d", i + 1, payload.c_str(), code);

        if (code > 0) {
            Serial.printf(" %s\n", http.getString().c_str());
        } else {
            Serial.printf(" (%s)\n", HTTPClient::errorToString(code).c_str());
            break;
        }
    }
    http.end();
}

void setup() {
    Serial.begin(115200);

    for (int i = 0; i < 3; i++) {
        pinMode(tanks[i].trigPin, OUTPUT);
        pinMode(tanks[i].echoPin, INPUT);
        digitalWrite(tanks[i].trigPin, LOW);
    }

    Serial.println("\nStarting Wi-Fi Access Point...");
    WiFi.mode(WIFI_AP);
    WiFi.softAPConfig(IPAddress(192, 168, 4, 1), IPAddress(192, 168, 4, 1), IPAddress(255, 255, 255, 0));
    WiFi.softAP(ssid, password, 1, 0, 4);

    Serial.printf("AP Created: %s (IP: %s)\n", ssid, WiFi.softAPIP().toString().c_str());
    Serial.printf("Expecting Node Server at http://%s:%d\n", SERVER_IP, SERVER_PORT);
}

void loop() {
    unsigned long currentTime = millis();

    if (currentTime - lastPushTime >= PUSH_INTERVAL) {
        float timeDelta = (currentTime - lastPushTime) / 1000.0;
        lastPushTime = currentTime;

        for (int i = 0; i < 3; i++) {
            measureTank(i, tanks[i], timeDelta);
            delay(40);
        }

        if (WiFi.softAPgetStationNum() > 0) {
            pushReadingsToServer();
        } else {
            Serial.println("Waiting for PC / Alarm ESP32 to join Wi-Fi...");
        }
    }
}
