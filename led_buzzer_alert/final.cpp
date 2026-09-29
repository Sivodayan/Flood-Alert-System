#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>

const char *ssid = "FloodNode_OutputServer", *password = "12345678";

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

void processAllTanks() {
  float rateA = fetchSingleRate(urlTankA);
  float rateB = fetchSingleRate(urlTankB);
  float rateC = fetchSingleRate(urlTankC);

  bool isTankACritical = updateTankLights(TANK_A_GREEN, TANK_A_YELLOW, TANK_A_RED, rateA);
  bool isTankBCritical = updateTankLights(TANK_B_GREEN, TANK_B_YELLOW, TANK_B_RED, rateB);
  bool isTankCCritical = updateTankLights(TANK_C_GREEN, TANK_C_YELLOW, TANK_C_RED, rateC);

  if (isTankACritical || isTankBCritical || isTankCCritical) {
    tone(BUZZER, 2000, 200);
  } else {
    noTone(BUZZER);
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

  WiFi.softAP(ssid, password);
  Serial.print("Hotspot Running. IP: ");
  Serial.println(WiFi.softAPIP());
}

void loop() {
  if (millis() - lastFetchTime >= fetchInterval) {
    lastFetchTime = millis();
    processAllTanks();
  }
}
