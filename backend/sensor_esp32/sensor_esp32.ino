/*
 * Flood sensor node (ESP32 #1)  -  also the Wi-Fi access point for the whole system
 *
 *   [ultrasonic x3] -> this ESP32 (AP 192.168.4.1) <--Wi-Fi--> PC running the Node server
 *                                                  <--Wi-Fi--> alarm ESP32 (polls the server)
 *
 * Every PUSH_INTERVAL it measures the 3 tanks and sends ONE request per tank to the
 * server, matching routes.js:
 *
 *   POST /api/readings
 *   { "sensor_id": 1, "water_level": 23.4, "water_rising_speed": 0.85 }
 *
 *   sensor_id           1, 2, 3  (server maps these to tanks A, B, C)
 *   water_level         cm, must be a number
 *   water_rising_speed  cm per MINUTE (negative = falling). The dashboard and the
 *                       server thresholds both use cm/min.
 *
 * Library needed: ArduinoJson v7
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <algorithm>

// --- Wi-Fi network created by this ESP32 ---
const char* ssid     = "Flood_Sensor_Network";
const char* password = "adminpassword";          // must be at least 8 characters

// --- Server (the PC joins this Wi-Fi) ---
// Give the PC a STATIC IP on this network (see notes): IP 192.168.4.100,
// mask 255.255.255.0, gateway 192.168.4.1. A fixed address is needed because the
// ESP32's DHCP hands out .2, .3, ... in the order devices connect, so "the PC is .2"
// is only true if it happens to join first.
const char* SERVER_IP     = "192.168.4.100";
const int   SERVER_PORT   = 8080;
const char* READINGS_PATH = "/api/readings";

// --- Tank data ---
struct Tank {
    int   trigPin;
    int   echoPin;
    float height;       // usable tank height (cm)
    float offset;       // sensor-to-top offset (cm)
    float distance;     // last measured distance (cm)
    float waterLevel;   // cm
    float speed;        // smoothed rise speed, cm per SECOND (converted to cm/min when sent)
    float prevLevel;
    bool  valid;        // true once at least one good measurement exists
};

Tank tanks[3] = {
    {5,  18, 100.0, 0.0, 0, 0, 0, -1.0, false},
    {19, 21, 100.0, 0.0, 0, 0, 0, -1.0, false},
    {22, 23, 100.0, 0.0, 0, 0, 0, -1.0, false}
};

unsigned long lastPushTime = 0;
const unsigned long PUSH_INTERVAL = 3000;   // measure + push every 3 seconds
const float ALPHA = 0.2;                    // speed smoothing

// --- Median filter (ignores single glitches) ---
float getFilteredDistance(int trig, int echo) {
    float readings[3];
    for (int i = 0; i < 3; i++) {
        digitalWrite(trig, LOW);  delayMicroseconds(2);
        digitalWrite(trig, HIGH); delayMicroseconds(10);
        digitalWrite(trig, LOW);
        readings[i] = pulseIn(echo, HIGH, 30000) * 0.0343 / 2.0;
        delay(15);
    }
    if (readings[0] > readings[1]) std::swap(readings[0], readings[1]);
    if (readings[1] > readings[2]) std::swap(readings[1], readings[2]);
    if (readings[0] > readings[1]) std::swap(readings[0], readings[1]);
    return readings[1];
}

// --- Measurement ---
void measureTank(Tank &t, float timeDelta) {
    float dist = getFilteredDistance(t.trigPin, t.echoPin);
    if (dist > 0.0) {                       // 0 = echo timeout / sensor not responding
        t.distance   = dist;
        t.waterLevel = (t.height + t.offset) - t.distance;

        if (t.waterLevel < 0) t.waterLevel = 0;
        if (t.waterLevel > t.height) t.waterLevel = t.height;

        if (t.prevLevel >= 0 && timeDelta > 0) {
            float rawSpeed = (t.waterLevel - t.prevLevel) / timeDelta;   // cm/s
            if (fabs(rawSpeed) < 15.0) {
                t.speed = (ALPHA * rawSpeed) + ((1.0 - ALPHA) * t.speed);
            }
        }
        t.prevLevel = t.waterLevel;
        t.valid = true;
    }
}

// --- Send one request per tank, in the format routes.js expects ---
void pushReadingsToServer() {
    String url = String("http://") + SERVER_IP + ":" + SERVER_PORT + READINGS_PATH;

    HTTPClient http;
    http.setConnectTimeout(1500);   // don't block the loop for long if the server is down
    http.setTimeout(2000);
    http.setReuse(true);            // reuse one connection for the 3 posts
    if (!http.begin(url)) {
        Serial.println("HTTP begin() failed");
        return;
    }
    http.addHeader("Content-Type", "application/json");

    for (int i = 0; i < 3; i++) {
        if (!tanks[i].valid) {
            Serial.printf("Tank %d: no valid reading yet (check sensor wiring), skipped\n", i + 1);
            continue;
        }

        JsonDocument doc;
        doc["sensor_id"]          = i + 1;
        doc["water_level"]        = round(tanks[i].waterLevel * 10.0) / 10.0;
        doc["water_rising_speed"] = round(tanks[i].speed * 60.0 * 100.0) / 100.0;   // cm/s -> cm/min

        String payload;
        serializeJson(doc, payload);

        int code = http.POST(payload);
        Serial.printf("POST %s %s -> %d", url.c_str(), payload.c_str(), code);

        if (code > 0) {
            Serial.printf("  %s\n", http.getString().c_str());   // e.g. {"status":"ok","tank":"A","level":"safe"}
        } else {
            Serial.printf("  (%s)\n", HTTPClient::errorToString(code).c_str());
            break;   // server unreachable: no point trying the other tanks this round
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

    // Create the Wi-Fi network (the ESP32 is the router: 192.168.4.1)
    Serial.println("Starting Wi-Fi Access Point...");
    WiFi.mode(WIFI_AP);
    WiFi.softAPConfig(IPAddress(192, 168, 4, 1), IPAddress(192, 168, 4, 1), IPAddress(255, 255, 255, 0));
    WiFi.softAP(ssid, password, 1, 0, 4);   // channel 1, visible, up to 4 devices

    Serial.print("Network created: ");
    Serial.println(ssid);
    Serial.print("AP IP: ");
    Serial.println(WiFi.softAPIP());
    Serial.printf("Server expected at http://%s:%d\n", SERVER_IP, SERVER_PORT);
}

void loop() {
    unsigned long currentTime = millis();

    if (currentTime - lastPushTime >= PUSH_INTERVAL) {
        float timeDelta = (currentTime - lastPushTime) / 1000.0;
        lastPushTime = currentTime;

        for (int i = 0; i < 3; i++) {
            measureTank(tanks[i], timeDelta);
            delay(40);   // let the echo of one sensor die out before the next
        }

        // Needs the PC and the alarm ESP32 connected to this network
        if (WiFi.softAPgetStationNum() > 0) {
            pushReadingsToServer();
        } else {
            Serial.println("Waiting for the server PC / alarm ESP32 to join the Wi-Fi...");
        }
    }
}
