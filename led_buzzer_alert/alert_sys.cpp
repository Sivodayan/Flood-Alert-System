#include <Arduino.h>

// Pin Definitions
#define GREEN_LED  12
#define YELLOW_LED 14
#define RED_LED    27
#define BUZZER     26

void setup() {
  pinMode(GREEN_LED, OUTPUT);
  pinMode(YELLOW_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(BUZZER, OUTPUT);
}

// Helper to set LED states in a single line
void setLEDs(bool g, bool y, bool r) {
  digitalWrite(GREEN_LED, g);
  digitalWrite(YELLOW_LED, y);
  digitalWrite(RED_LED, r);
}

// Compact alert decision logic
void triggerAlert(float rateOfRise) {
  if (rateOfRise >= 1.5) {        // High Risk Alert (Almost Flooded)
    setLEDs(LOW, LOW, HIGH);
    tone(BUZZER, 2000, 200);      // Buzzer turns ON only here
  } 
  else if (rateOfRise >= 0.5) {   // Moderate Warning
    setLEDs(LOW, HIGH, LOW);
    noTone(BUZZER);               // Buzzer stays SILENT
  } 
  else {                          // Normal / Safe
    setLEDs(HIGH, LOW, LOW);
    noTone(BUZZER);               // Buzzer stays SILENT
  }
}

void loop() {
  // Example usage: pass the rate-of-rise value
  triggerAlert(1.8);
  delay(500); // Sample rate interval
}
