/*
 * Flood alarm receiver (ESP32 #2)
 *
 * Polls GET /api/alarm on the Node server and drives a set of indicator LEDs
 * (one set per tank) plus a shared buzzer.
 *
 * Server response format:
 * {
 *   "alert": "Warning",
 *   "triggered": ["sensor_01"],
 *   "tanks": {
 *     "sensor_01": { "tank": "A", "level": "Warning", "triggered": true },
 *     "sensor_02": { "tank": "B", "level": "safe",    "triggered": false },
 *     "sensor_03": { "tank": "C", "level": "safe",    "triggered": false }
 *   }
 * }
 *
 * Behaviour per tank:
 *   safe          -> green LED on
 *   Early_warning -> yellow LED blinking slowly
 *   Warning       -> yellow LED solid, buzzer beeps every 3 s
 *   DANGER        -> red LED blinking fast, buzzer sounds a pulsing siren
 * The buzzer follows the highest level across all tanks.
 *
 * Library needed: ArduinoJson v7 (Library Manager -> "ArduinoJson" by Benoit Blanchon)
 * Board: any ESP32 (Arduino-ESP32 core 2.x or 3.x)
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ---------------------------- CONFIGURATION ----------------------------
// This ESP32 joins the network created by the SENSOR ESP32 (it acts as the router)
const char* WIFI_SSID = "Flood_Sensor_Network";
const char* WIFI_PASS = "adminpassword";

// Static IP of the PC running the Node server on that network (NOT "localhost").
// Must match SERVER_IP in the sensor sketch.
const char* ALARM_URL = "http://192.168.4.2:8080/api/alarm";

const unsigned long POLL_INTERVAL_MS  = 2000;    // how often to ask the server
const unsigned long COMMS_TIMEOUT_MS  = 30000;   // no good reply for this long = comms lost
const unsigned long WIFI_RETRY_MS     = 10000;
const int           HTTP_TIMEOUT_MS   = 4000;

// Pins (change to match your wiring). Use a 220 ohm resistor in series with each LED.
const uint8_t BUZZER_PIN     = 23;   // active buzzer (use a transistor if it draws > 20 mA)
const uint8_t STATUS_LED_PIN = 2;    // on-board LED: solid = server OK, fast blink = comms lost
// ------------------------------------------------------------------------

enum Level { LEVEL_SAFE = 0, LEVEL_EARLY_WARNING = 1, LEVEL_WARNING = 2, LEVEL_DANGER = 3 };

struct Tank {
  const char* sensorId;   // key used by the server in /api/alarm
  const char* name;       // tank letter (for logging)
  uint8_t greenPin;
  uint8_t yellowPin;
  uint8_t redPin;
  Level   level;          // last level received from the server
};

Tank tanks[] = {
  // sensorId     name  green yellow red
  { "sensor_01",  "A",  25,   26,    27,  LEVEL_SAFE },
  { "sensor_02",  "B",  32,   33,    14,  LEVEL_SAFE },
  { "sensor_03",  "C",  16,   17,    18,  LEVEL_SAFE },
};
const int NUM_TANKS = sizeof(tanks) / sizeof(tanks[0]);

unsigned long lastPoll       = 0;
unsigned long lastSuccess    = 0;
unsigned long lastWifiRetry  = 0;

// ---------------------------- HELPERS ----------------------------------
const char* levelName(Level l) {
  switch (l) {
    case LEVEL_EARLY_WARNING: return "Early_warning";
    case LEVEL_WARNING:       return "Warning";
    case LEVEL_DANGER:        return "DANGER";
    default:                  return "safe";
  }
}

// Unknown text keeps the previous level instead of silently going back to "safe"
Level parseLevel(const char* s, Level fallback) {
  if (!s) return fallback;
  if (strcmp(s, "safe") == 0)          return LEVEL_SAFE;
  if (strcmp(s, "Early_warning") == 0) return LEVEL_EARLY_WARNING;
  if (strcmp(s, "Warning") == 0)       return LEVEL_WARNING;
  if (strcmp(s, "DANGER") == 0)        return LEVEL_DANGER;
  return fallback;
}

// Called once whenever a tank's level changes. Put tank-specific actions here
// (open a valve, start a pump, drive a relay, ...).
void onTankLevelChange(Tank& tank, Level oldLevel, Level newLevel) {
  Serial.printf("[TANK %s] %s -> %s\n", tank.name, levelName(oldLevel), levelName(newLevel));

  // Example:
  // if (tank.sensorId == "sensor_01" && newLevel == LEVEL_DANGER) { digitalWrite(RELAY_A_PIN, HIGH); }
}

// ---------------------------- WIFI -------------------------------------
void connectWiFi() {
  Serial.printf("Connecting to WiFi '%s'", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(300);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nConnected. IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nWiFi not connected yet, will keep retrying in the background.");
  }
}

void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiRetry < WIFI_RETRY_MS) return;
  lastWifiRetry = millis();
  Serial.println("WiFi lost, reconnecting...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

// ---------------------------- SERVER POLL ------------------------------
bool fetchAlarm() {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (!http.begin(ALARM_URL)) {
    Serial.println("[HTTP] begin() failed");
    return false;
  }

  int code = http.GET();
  if (code != HTTP_CODE_OK) {
    Serial.printf("[HTTP] GET %s failed, code: %d (%s)\n",
                  ALARM_URL, code, code < 0 ? HTTPClient::errorToString(code).c_str() : "server replied with an error");
    Serial.printf("[NET] ESP32 IP: %s  gateway: %s  RSSI: %d dBm\n",
                  WiFi.localIP().toString().c_str(),
                  WiFi.gatewayIP().toString().c_str(),
                  WiFi.RSSI());
    http.end();
    return false;
  }

  String body = http.getString();
  http.end();

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, body);
  if (err) {
    Serial.printf("[JSON] parse error: %s\n", err.c_str());
    return false;
  }

  JsonObject tanksObj = doc["tanks"];
  if (tanksObj.isNull()) {
    Serial.println("[JSON] 'tanks' missing in response");
    return false;
  }

  for (int i = 0; i < NUM_TANKS; i++) {
    JsonObject t = tanksObj[tanks[i].sensorId];
    if (t.isNull()) continue;                       // keep previous level for this tank

    Level newLevel = parseLevel(t["level"], tanks[i].level);
    if (newLevel != tanks[i].level) {
      Level oldLevel = tanks[i].level;
      tanks[i].level = newLevel;
      onTankLevelChange(tanks[i], oldLevel, newLevel);
    }
  }

  Serial.printf("[POLL] overall=%s\n", doc["alert"] | "?");
  return true;
}

// ---------------------------- OUTPUTS ----------------------------------
// Non-blocking: everything is derived from millis(), so polling never stalls the LEDs.
void updateOutputs() {
  unsigned long now = millis();
  bool slowBlink = (now / 500) % 2;     // 1 Hz
  bool fastBlink = (now / 150) % 2;     // ~3 Hz

  Level highest = LEVEL_SAFE;

  for (int i = 0; i < NUM_TANKS; i++) {
    bool g = false, y = false, r = false;
    switch (tanks[i].level) {
      case LEVEL_SAFE:           g = true;       break;
      case LEVEL_EARLY_WARNING:  y = slowBlink;  break;
      case LEVEL_WARNING:        y = true;       break;
      case LEVEL_DANGER:         r = fastBlink;  break;
    }
    digitalWrite(tanks[i].greenPin,  g);
    digitalWrite(tanks[i].yellowPin, y);
    digitalWrite(tanks[i].redPin,    r);

    if (tanks[i].level > highest) highest = tanks[i].level;
  }

  // Buzzer follows the highest level of any tank
  bool buzz = false;
  switch (highest) {
    case LEVEL_DANGER:  buzz = (now / 300) % 2;   break;   // pulsing siren
    case LEVEL_WARNING: buzz = (now % 3000) < 250; break;  // short beep every 3 s
    default:            buzz = false;             break;
  }
  digitalWrite(BUZZER_PIN, buzz);

  // Status LED: solid = server reachable, fast blink = comms lost
  bool commsLost = (now - lastSuccess > COMMS_TIMEOUT_MS);
  digitalWrite(STATUS_LED_PIN, commsLost ? fastBlink : HIGH);
}

// ---------------------------- ARDUINO ----------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(STATUS_LED_PIN, OUTPUT);
  for (int i = 0; i < NUM_TANKS; i++) {
    pinMode(tanks[i].greenPin,  OUTPUT);
    pinMode(tanks[i].yellowPin, OUTPUT);
    pinMode(tanks[i].redPin,    OUTPUT);
  }

  // Power-on self test: light everything and beep briefly
  for (int i = 0; i < NUM_TANKS; i++) {
    digitalWrite(tanks[i].greenPin,  HIGH);
    digitalWrite(tanks[i].yellowPin, HIGH);
    digitalWrite(tanks[i].redPin,    HIGH);
  }
  digitalWrite(BUZZER_PIN, HIGH);
  delay(300);
  digitalWrite(BUZZER_PIN, LOW);
  delay(700);

  connectWiFi();
  lastSuccess = millis();       // give the server a full timeout window before flagging comms lost
}

void loop() {
  maintainWiFi();

  if (millis() - lastPoll >= POLL_INTERVAL_MS) {
    lastPoll = millis();
    if (fetchAlarm()) lastSuccess = millis();
  }

  updateOutputs();
}
