#define TRIG_PIN 5
#define ECHO_PIN 18

const float TANK_HEIGHT = 30.0; // Max water capacity height in cm
const float SENSOR_OFFSET = 0.0; // Distance from sensor face to the 100% water line

void setup() {
    Serial.begin(115200);

    pinMode(TRIG_PIN, OUTPUT);
    pinMode(ECHO_PIN, INPUT);

    digitalWrite(TRIG_PIN, LOW);
}

void loop() {
    // Send ultrasonic pulse
    digitalWrite(TRIG_PIN, LOW);
    delayMicroseconds(2);

    digitalWrite(TRIG_PIN, HIGH);
    delayMicroseconds(10);

    digitalWrite(TRIG_PIN, LOW);

    // Measure echo time with a 30ms timeout
    long duration = pulseIn(ECHO_PIN, HIGH, 30000);

    // 1. Handle Sensor Timeout / Disconnect
    if (duration == 0) {
        Serial.println("ERROR: Sensor timeout or out of range!");
    } 
    else {
        // Calculate raw distance to water surface
        float distance = duration * 0.0343 / 2;

        // 2. Calculate actual water level accounting for mounting offset
        float waterLevel = (TANK_HEIGHT + SENSOR_OFFSET) - distance;

        // Prevent impossible values
        if (waterLevel < 0) waterLevel = 0;
        if (waterLevel > TANK_HEIGHT) waterLevel = TANK_HEIGHT;

        // Calculate percentage
        float percentage = (waterLevel / TANK_HEIGHT) * 100.0;

        Serial.print("Distance to water: ");
        Serial.print(distance);
        Serial.println(" cm");

        Serial.print("Water level: ");
        Serial.print(waterLevel);
        Serial.println(" cm");

        Serial.print("Tank Capacity: ");
        Serial.print(percentage);
        Serial.println("%");
    }

    Serial.println("--------------------");

    delay(1000);
}