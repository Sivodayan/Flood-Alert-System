#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>

// --- SOFT ACCESS POINT CREDENTIALS ---
const char *ssid = "FloodNode_OutputServer";
const char *password = "12345678"; // Must be at least 8 characters

// Create WebServer object on port 80
WebServer server(80);

// --- PIN DEFINITIONS FOR 3 TANKS ---
// Tank A (City 1)
#define TANK_A_GREEN   12
#define TANK_A_YELLOW  14
#define TANK_A_RED     27

// Tank B (City 2)
#define TANK_B_GREEN   16
#define TANK_B_YELLOW  17
#define TANK_B_RED     5

// Tank C (City 3)
#define TANK_C_GREEN   18
#define TANK_C_YELLOW  19
#define TANK_C_RED     21

// Shared Alert Buzzer
#define BUZZER         26

// Helper to update LEDs for a specific tank
void setTankLEDs(int greenPin, int yellowPin, int redPin, float rateOfRise, bool &isCritical) {
  if (rateOfRise >= 1.5) {        // High Risk / Almost Flooded
    digitalWrite(greenPin, LOW);
    digitalWrite(yellowPin, LOW);
    digitalWrite(redPin, HIGH);
    isCritical = true;            // At least one tank is high risk
  } 
  else if (rateOfRise >= 0.5) {   // Moderate Warning
    digitalWrite(greenPin, LOW);
    digitalWrite(yellowPin, HIGH);
    digitalWrite(redPin, LOW);
  } 
  else {                          // Normal / Safe
    digitalWrite(greenPin, HIGH);
    digitalWrite(yellowPin, LOW);
    digitalWrite(redPin, LOW);
  }
}

// Core evaluation function for all 3 tanks
void updateSystemAlerts(float rateA, float rateB, float rateC) {
  bool criticalAlert = false;

  // Update visual indicators for each city/tank independently
  setTankLEDs(TANK_A_GREEN, TANK_A_YELLOW, TANK_A_RED, rateA, criticalAlert);
  setTankLEDs(TANK_B_GREEN, TANK_B_YELLOW, TANK_B_RED, rateB, criticalAlert);
  setTankLEDs(TANK_C_GREEN, TANK_C_YELLOW, TANK_C_RED, rateC, criticalAlert);

  // Turn on buzzer ONLY if AT LEAST ONE tank is almost flooded
  if (criticalAlert) {
    tone(BUZZER, 2000, 200); // 2000Hz tone for high alert
  } else {
    noTone(BUZZER);
  }
}

// HTTP POST/GET Handler to process incoming data from the backend
void handleUpdate() {
  if (server.hasArg("rateA") && server.hasArg("rateB") && server.hasArg("rateC")) {
    float rateA = server.arg("rateA").toFloat();
    float rateB = server.arg("rateB").toFloat();
    float rateC = server.arg("rateC").toFloat();

    // Trigger LED & Buzzer alerts
    updateSystemAlerts(rateA, rateB, rateC);

    // Send HTTP OK response back to backend
    server.send(200, "text/plain", "Data Received Successfully");
  } else {
    server.send(400, "text/plain", "Bad Request: Missing parameters");
  }
}

void setup() {
  Serial.begin(115200);

  // Initialize pins for Tank A
  pinMode(TANK_A_GREEN, OUTPUT);
  pinMode(TANK_A_YELLOW, OUTPUT);
  pinMode(TANK_A_RED, OUTPUT);

  // Initialize pins for Tank B
  pinMode(TANK_B_GREEN, OUTPUT);
  pinMode(TANK_B_YELLOW, OUTPUT);
  pinMode(TANK_B_RED, OUTPUT);

  // Initialize pins for Tank C
  pinMode(TANK_C_GREEN, OUTPUT);
  pinMode(TANK_C_YELLOW, OUTPUT);
  pinMode(TANK_C_RED, OUTPUT);

  // Initialize Buzzer
  pinMode(BUZZER, OUTPUT);

  // --- START SOFT ACCESS POINT (HOTSPOT) ---
  WiFi.softAP(ssid, password);
  IPAddress IP = WiFi.softAPIP();
  Serial.print("Access Point Started. IP Address: ");
  Serial.println(IP); // Default IP is usually 192.168.4.1

  // Define HTTP route for updating data
  server.on("/update", HTTP_POST, handleUpdate);
  server.on("/update", HTTP_GET, handleUpdate); // Allows both GET and POST requests

  // Start the server
  server.begin();
  Serial.println("HTTP Web Server Started");
}

void loop() {
  // Listen for incoming Wi-Fi HTTP requests from the backend
  server.handleClient();
}
