/*
 * Flood alarm receiver (ESP32 #2)
 * Uses a static IP (192.168.4.50) so it never steals 192.168.4.2 from the PC server.
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <ctype.h>

// ---------------------------- CONFIGURATION ----------------------------
const char* WIFI_SSID = "Flood_Sensor_Network";
const char* WIFI_PASS = "adminpassword";

// Static IP for THIS Alarm ESP32 so it never takes 192.168.4.2
IPAddress local_IP(192, 168, 4, 50);
IPAddress gateway(192, 168, 4, 1);
IPAddress subnet(255, 255, 255, 0);

// PC running the Node server
const char* ALARM_URL = "http://192.168.4.2:8080/api/alarm";

const unsigned long POLL_INTERVAL_MS = 2000;
const unsigned long COMMS_TIMEOUT_MS = 30000;
const unsigned long WIFI_RETRY_MS    = 10000;
const int           HTTP_TIMEOUT_MS  = 4000;

const uint8_t BUZZER_PIN     = 23;
const uint8_t STATUS_LED_PIN = 2;

// Set to false if your buzzer stays on continuously when safe
const bool BUZZER_ACTIVE_LOW = true;
// ------------------------------------------------------------------------

enum Level { LEVEL_SAFE = 0, LEVEL_EARLY_WARNING = 1, LEVEL_WARNING = 2, LEVEL_DANGER = 3 };

struct Tank {
  const char* sensorId;
  const char* name;
  uint8_t greenPin;
  uint8_t yellowPin;
  uint8_t redPin;
  Level   level;
};

Tank tanks[] = {
  { "sensor_01", "A", 25, 26, 27, LEVEL_SAFE },
  { "sensor_02", "B", 32, 33, 14, LEVEL_SAFE },
  { "sensor_03", "C", 16, 17, 18, LEVEL_SAFE },
};
const int NUM_TANKS = sizeof(tanks) / sizeof(tanks[0]);

unsigned long lastPoll      = 0;
unsigned long lastSuccess   = 0;
unsigned long lastWifiRetry = 0;

// ---------------------------- HELPERS ----------------------------------
const char* levelName(Level l) {
  switch (l) {
    case LEVEL_EARLY_WARNING: return "Early_warning";
    case LEVEL_WARNING:       return "Warning";
    case LEVEL_DANGER:        return "DANGER";
    default:                  return "safe";
  }
}

bool parseLevel(const char* s, Level& out) {
  if (!s) return false;
  char buf[24];
  int n = 0;
  for (; *s && n < (int)sizeof(buf) - 1; s++) {
    if (isalnum((unsigned char)*s)) buf[n++] = (char)tolower((unsigned char)*s);
  }
  buf[n] = '\0';

  if (!strcmp(buf, "safe") || !strcmp(buf, "normal") || !strcmp(buf, "ok")) { out = LEVEL_SAFE;          return true; }
  if (!strcmp(buf, "earlywarning"))                                          { out = LEVEL_EARLY_WARNING; return true; }
  if (!strcmp(buf, "warning"))                                               { out = LEVEL_WARNING;       return true; }
  if (!strcmp(buf, "danger") || !strcmp(buf, "critical"))                    { out = LEVEL_DANGER;        return true; }
  return false;
}

void setBuzzer(bool on) {
  digitalWrite(BUZZER_PIN, (on != BUZZER_ACTIVE_LOW) ? HIGH : LOW);
}

void onTankLevelChange(Tank& tank, Level oldLevel, Level newLevel) {
  Serial.printf("[TANK %s] %s -> %s\n", tank.name, levelName(oldLevel), levelName(newLevel));
}

// ---------------------------- WIFI -------------------------------------
void connectWiFi() {
  Serial.printf("Connecting to WiFi '%s'", WIFI_SSID);
  WiFi.mode(WIFI_STA);

  // Lock this ESP32 to 192.168.4.50 so the PC can safely use 192.168.4.2
  if (!WiFi.config(local_IP, gateway, subnet)) {
    Serial.println("Static IP configuration failed!");
  }

  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(300);
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nConnected! Alarm ESP32 IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nWiFi not connected yet, retrying in background.");
  }
}

void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiRetry < WIFI_RETRY_MS) return;
  lastWifiRetry = millis();
  Serial.println("WiFi lost, reconnecting...");
  WiFi.disconnect();
  WiFi.config(local_IP, gateway, subnet);
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
                  ALARM_URL, code, code < 0 ? HTTPClient::errorToString(code).c_str() : "server error");
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

  Level overall = LEVEL_SAFE;
  parseLevel(doc["alert"], overall);

  for (int i = 0; i < NUM_TANKS; i++) {
    Level newLevel = LEVEL_SAFE; // Default to safe if missing

    JsonObject t = tanksObj[tanks[i].sensorId];
    if (!t.isNull()) {
      const char* raw = t["level"];
      if (!parseLevel(raw, newLevel)) {
        Serial.printf("[JSON] unknown level '%s' for %s\n", raw ? raw : "null", tanks[i].sensorId);
      }
    }

    if (newLevel > overall) newLevel = overall;

    if (newLevel != tanks[i].level) {
      Level oldLevel = tanks[i].level;
      tanks[i].level = newLevel;
      onTankLevelChange(tanks[i], oldLevel, newLevel);
    }
  }

  Serial.printf("[POLL] overall=%s | A=%s B=%s C=%s\n", doc["alert"] | "?",
                levelName(tanks[0].level), levelName(tanks[1].level), levelName(tanks[2].level));
  return true;
}

// ---------------------------- OUTPUTS ----------------------------------
void updateOutputs() {
  unsigned long now = millis();
  bool slowBlink = (now / 500) % 2;
  bool fastBlink = (now / 150) % 2;

  Level highest = LEVEL_SAFE;

  for (int i = 0; i < NUM_TANKS; i++) {
    bool g = false, y = false, r = false;
    switch (tanks[i].level) {
      case LEVEL_SAFE:          g = true;      break;
      case LEVEL_EARLY_WARNING: y = slowBlink; break;
      case LEVEL_WARNING:       y = true;      break;
      case LEVEL_DANGER:        r = fastBlink; break;
    }
    digitalWrite(tanks[i].greenPin,  g);
    digitalWrite(tanks[i].yellowPin, y);
    digitalWrite(tanks[i].redPin,    r);

    if (tanks[i].level > highest) highest = tanks[i].level;
  }

  bool buzz = false;
  switch (highest) {
    case LEVEL_DANGER:  buzz = (now / 300) % 2;    break;
    case LEVEL_WARNING: buzz = (now % 3000) < 250; break;
    default:            buzz = false;              break;
  }
  setBuzzer(buzz);

  bool commsLost = (now - lastSuccess > COMMS_TIMEOUT_MS);
  digitalWrite(STATUS_LED_PIN, commsLost ? fastBlink : HIGH);
}

// ---------------------------- ARDUINO ----------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(BUZZER_PIN, OUTPUT);
  setBuzzer(false);
  pinMode(STATUS_LED_PIN, OUTPUT);

  for (int i = 0; i < NUM_TANKS; i++) {
    pinMode(tanks[i].greenPin,  OUTPUT);
    pinMode(tanks[i].yellowPin, OUTPUT);
    pinMode(tanks[i].redPin,    OUTPUT);
  }

  // Self-test
  for (int i = 0; i < NUM_TANKS; i++) {
    digitalWrite(tanks[i].greenPin,  HIGH);
    digitalWrite(tanks[i].yellowPin, HIGH);
    digitalWrite(tanks[i].redPin,    HIGH);
  }
  setBuzzer(true);
  delay(300);
  setBuzzer(false);
  for (int i = 0; i < NUM_TANKS; i++) {
    digitalWrite(tanks[i].greenPin,  LOW);
    digitalWrite(tanks[i].yellowPin, LOW);
    digitalWrite(tanks[i].redPin,    LOW);
  }
  delay(400);

  connectWiFi();
  lastSuccess = millis();
}

void loop() {
  maintainWiFi();

  if (millis() - lastPoll >= POLL_INTERVAL_MS) {
    lastPoll = millis();
    if (fetchAlarm()) lastSuccess = millis();
  }

  updateOutputs();
}