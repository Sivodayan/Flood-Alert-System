#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>

// --- CONFIGURATION & PINS ---
const char *ssid = "FloodNode_OutputServer", *password = "12345678";

// Backend endpoint to request data from (adjust IP/port if your backend uses a different one)
const char* backendUrl = "http://192.168.4.2/get_rates"; 

// Pin layout for 3 tanks: {Green, Yellow, Red}
const int TANK_PINS[3][3] = {
  {12, 14, 27}, // Tank A (City 1)
  {16, 17, 5},  // Tank B (City 2)
  {18, 19, 21}  // Tank C (City 3)
};
#define BUZZER 26

unsigned long lastFetchTime = 0;
const long fetchInterval = 2000; // Request data every 2 seconds (2000ms)

// Updates LEDs for a single tank and checks if critical
bool updateTank(int tankIndex, float rate) {
  bool highRisk = (rate >= 1.5);
  bool warning  = (rate >= 0.5 && !highRisk);

  digitalWrite(TANK_PINS[tankIndex][0], (!highRisk && !warning) ? HIGH : LOW); // Green
  digitalWrite(TANK_PINS[tankIndex][1], warning ? HIGH : LOW);                 // Yellow
  digitalWrite(TANK_PINS[tankIndex][2], highRisk ? HIGH : LOW);                // Red

  return highRisk;
}

// Request data from the backend and update alerts
void fetchAndUpdateAlerts() {
  if (WiFi.softAPgetStationNum() > 0) { // Check if backend ESP32 is connected to hotspot
    HTTPClient http;
    http.begin(backendUrl);
    int httpCode = http.GET(); // Send HTTP GET request to backend

    if (httpCode == HTTP_CODE_OK) {
      String payload = http.getString(); // Expecting format: "0.2,0.8,1.8"
      
      // Parse rates for Tank A, B, and C
      float rateA = payload.substring(0, payload.indexOf(',')).toFloat();
      int firstComma = payload.indexOf(',');
      int secondComma = payload.indexOf(',', firstComma + 1);
      float rateB = payload.substring(firstComma + 1, secondComma).toFloat();
      float rateC = payload.substring(secondComma + 1).toFloat();

      // Update LEDs for all 3 tanks
      bool criticalAlert = false;
      if (updateTank(0, rateA)) criticalAlert = true;
      if (updateTank(1, rateB)) criticalAlert = true;
      if (updateTank(2, rateC)) criticalAlert = true;

      // Trigger buzzer ONLY if at least one tank is almost flooded
      if (criticalAlert) tone(BUZZER, 2000, 200); else noTone(BUZZER);
    }
    http.end();
  }
}

void setup() {
  Serial.begin(115200);
  
  // Initialize LED pins and Buzzer
  for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 3; j++) pinMode(TANK_PINS[i][j], OUTPUT);
  }
  pinMode(BUZZER, OUTPUT);

  // Start Soft AP (Hotspot)
  WiFi.softAP(ssid, password);
  Serial.print("Hotspot Started. IP: ");
  Serial.println(WiFi.softAPIP()); // Default: 192.168.4.1
}

void loop() {
  // Repeats data request every 2 seconds without blocking the chip
  if (millis() - lastFetchTime >= fetchInterval) {
    lastFetchTime = millis();
    fetchAndUpdateAlerts();
  }
}
