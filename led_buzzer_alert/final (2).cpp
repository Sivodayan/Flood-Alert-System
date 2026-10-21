#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>

// ---- Hotspot for the tank node (unchanged) ----
const char *ssid = "FloodNode_OutputServer", *password = "12345678";

// ---- NEW: router Wi-Fi that the Node server PC is also on ----
const char *STA_SSID = "YOUR_ROUTER_WIFI";
const char *STA_PASS = "YOUR_ROUTER_PASSWORD";
// IP of the PC running the Node server (check with ipconfig / ifconfig)
const char *urlDangerLevel = "http://192.168.1.100:3000/api/danger-level";

const char* urlTankA = "http://192.168.4.2/get_rate_a";
const char* urlTankB = "http://192.168.4.2/get_rate_b";
const char* urlTankC = "http://192.168.4.2/get_rate_c";

#define TANK_A_GREEN   12
#define TANK_A_YELLOW  14
#define TANK_A_RED     27

#define TANK_B_GREEN   16
#define TANK_B_YELLOW  17
#define TANK_B_RED     5

#define TANK_C_GREEN   18
#define TANK_C_YELLOW  19
#define TANK_C_RED     21

#define BUZZER         26

unsigned long lastFetchTime = 0;
const long fetchInterval = 2000;

// ---- NEW: server-driven alert state ----
enum ServerLevel { LVL_SAFE, LVL_EARLY, LVL_WARNING, LVL_DANGER };
ServerLevel serverLevel = LVL_SAFE;
bool buzzerOn = false;
unsigned long lastBeepToggle = 0;

void setTankLeds(int g, int y, int r, bool green, bool yellow, bool red) {
  digitalWrite(g, green);
  digitalWrite(y, yellow);
  digitalWrite(r, red);
}

bool updateTankLights(int greenPin, int yellowPin, int redPin, float rateOfRise) {
  if (rateOfRise >= 1.5) {
    digitalWrite(greenPin, LOW);
    digitalWrite(yellowPin, LOW);
    digitalWrite(redPin, HIGH);
    return true;
  }
  else if (rateOfRise >= 0.5) {
    digitalWrite(greenPin, LOW);
    digitalWrite(yellowPin, HIGH);
    digitalWrite(redPin, LOW);
    return false;
  }
  else {
    digitalWrite(greenPin, HIGH);
    digitalWrite(yellowPin, LOW);
    digitalWrite(redPin, LOW);
    return false;
  }
}

float fetchSingleRate(const char* url) {
  float rate = 0.0;
  if (WiFi.softAPgetStationNum() > 0) {
    HTTPClient http;
    http.begin(url);
    int httpCode = http.GET();
    
    if (httpCode == HTTP_CODE_OK) {
      String payload = http.getString();
      rate = payload.toFloat();
    }
    http.end();
  }
  return rate;
}

// NEW: ask the Node server for the current danger level.
// On failure we keep the previous level (fail-safe: an active alarm stays on).
void fetchServerLevel() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.setTimeout(1500);
  http.begin(urlDangerLevel);
  int httpCode = http.GET();

  if (httpCode == HTTP_CODE_OK) {
    String payload = http.getString();
    payload.trim();

    if (payload == "DANGER")             serverLevel = LVL_DANGER;
    else if (payload == "Warning")       serverLevel = LVL_WARNING;
    else if (payload == "Early_warning") serverLevel = LVL_EARLY;
    else                                 serverLevel = LVL_SAFE;

    Serial.print("Server level: ");
    Serial.println(payload);
  } else {
    Serial.printf("Server poll failed (%d)\n", httpCode);
  }
  http.end();
}

void processAllTanks() {
  fetchServerLevel();

  // Server DANGER: all red LEDs on, siren handled in loop()
  if (serverLevel == LVL_DANGER) {
    setTankLeds(TANK_A_GREEN, TANK_A_YELLOW, TANK_A_RED, LOW, LOW, HIGH);
    setTankLeds(TANK_B_GREEN, TANK_B_YELLOW, TANK_B_RED, LOW, LOW, HIGH);
    setTankLeds(TANK_C_GREEN, TANK_C_YELLOW, TANK_C_RED, LOW, LOW, HIGH);
    return;
  }

  // Otherwise: normal local per-tank rate-of-rise logic
  float rateA = fetchSingleRate(urlTankA);
  float rateB = fetchSingleRate(urlTankB);
  float rateC = fetchSingleRate(urlTankC);

  bool isTankACritical = updateTankLights(TANK_A_GREEN, TANK_A_YELLOW, TANK_A_RED, rateA);
  bool isTankBCritical = updateTankLights(TANK_B_GREEN, TANK_B_YELLOW, TANK_B_RED, rateB);
  bool isTankCCritical = updateTankLights(TANK_C_GREEN, TANK_C_YELLOW, TANK_C_RED, rateC);

  // Server "Warning": force at least yellow on any tank that isn't already red
  if (serverLevel == LVL_WARNING) {
    if (!isTankACritical) setTankLeds(TANK_A_GREEN, TANK_A_YELLOW, TANK_A_RED, LOW, HIGH, LOW);
    if (!isTankBCritical) setTankLeds(TANK_B_GREEN, TANK_B_YELLOW, TANK_B_RED, LOW, HIGH, LOW);
    if (!isTankCCritical) setTankLeds(TANK_C_GREEN, TANK_C_YELLOW, TANK_C_RED, LOW, HIGH, LOW);
  }

  if (isTankACritical || isTankBCritical || isTankCCritical) {
    tone(BUZZER, 2000, 200);
  } else {
    noTone(BUZZER);
  }
}

// NEW: non-blocking siren pattern (500 ms on / 500 ms off) while server says DANGER
void updateSiren() {
  if (serverLevel != LVL_DANGER) {
    buzzerOn = false;
    return;
  }
  if (millis() - lastBeepToggle >= 500) {
    lastBeepToggle = millis();
    buzzerOn = !buzzerOn;
    if (buzzerOn) tone(BUZZER, 2000);
    else noTone(BUZZER);
  }
}

void setup() {
  Serial.begin(115200);

  pinMode(TANK_A_GREEN, OUTPUT);
  pinMode(TANK_A_YELLOW, OUTPUT);
  pinMode(TANK_A_RED, OUTPUT);

  pinMode(TANK_B_GREEN, OUTPUT);
  pinMode(TANK_B_YELLOW, OUTPUT);
  pinMode(TANK_B_RED, OUTPUT);

  pinMode(TANK_C_GREEN, OUTPUT);
  pinMode(TANK_C_YELLOW, OUTPUT);
  pinMode(TANK_C_RED, OUTPUT);

  pinMode(BUZZER, OUTPUT);

  // AP (for tank node) + STA (to reach the Node server on the router)
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(ssid, password);
  Serial.print("Hotspot Running. IP: ");
  Serial.println(WiFi.softAPIP());

  WiFi.begin(STA_SSID, STA_PASS);
  WiFi.setAutoReconnect(true);
  Serial.print("Connecting to router");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Router IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Router not connected yet (will keep retrying)");
  }
}

void loop() {
  if (millis() - lastFetchTime >= fetchInterval) {
    lastFetchTime = millis();
    processAllTanks();
  }
  updateSiren();
}
