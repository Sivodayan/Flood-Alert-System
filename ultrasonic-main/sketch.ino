#define TRIG_PIN 5
#define ECHO_PIN 18

const float TANK_HEIGHT = 30.0; // Max water capacity height in cm
const float SENSOR_OFFSET = 0.0; // Distance from sensor face to 100% water mark

// Timing and Speed Calculation Variables
unsigned long lastTime = 0;
float prevWaterLevel = -1.0; // Initialized to -1 to flag first reading
float smoothedSpeed = 0.0;   // In cm/s

// EMA Filter weight (0.0 to 1.0). Lower = smoother but slower reaction; Higher = faster reaction but noisy.
const float ALPHA = 0.2; 

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

    // Measure echo time (30ms timeout)
    long duration = pulseIn(ECHO_PIN, HIGH, 30000);

    if (duration == 0) {
        Serial.println("ERROR: Sensor timeout or out of range!");
    } 
    else {
        unsigned long currentTime = millis();
        
        // Calculate raw distance and current water level
        float distance = duration * 0.0343 / 2.0;
        float waterLevel = (TANK_HEIGHT + SENSOR_OFFSET) - distance;

        // Clamp values to realistic tank boundaries
        if (waterLevel < 0) waterLevel = 0;
        if (waterLevel > TANK_HEIGHT) waterLevel = TANK_HEIGHT;

        float percentage = (waterLevel / TANK_HEIGHT) * 100.0;

        // Calculate Rising Speed if we have a previous sample
        if (prevWaterLevel >= 0 && lastTime > 0) {
            float timeDeltaSeconds = (currentTime - lastTime) / 1000.0;

            if (timeDeltaSeconds > 0) {
                // Instantaneous rate of change (cm/s)
                float rawSpeed = (waterLevel - prevWaterLevel) / timeDeltaSeconds;

                // Apply Exponential Moving Average (EMA) filter to dampen sensor jitter
                smoothedSpeed = (ALPHA * rawSpeed) + ((1.0 - ALPHA) * smoothedSpeed);
            }
        }

        // Update tracking variables for next iteration
        prevWaterLevel = waterLevel;
        lastTime = currentTime;

        // Serial Output
        Serial.print("Distance to water: ");
        Serial.print(distance, 1);
        Serial.println(" cm");

        Serial.print("Water level: ");
        Serial.print(waterLevel, 1);
        Serial.println(" cm");

        Serial.print("Capacity: ");
        Serial.print(percentage, 1);
        Serial.println("%");

        // Speed Output (cm/s and cm/min)
        Serial.print("Rising Speed: ");
        if (smoothedSpeed > 0.05) {
            Serial.print("+"); // Rising
        }
        Serial.print(smoothedSpeed, 2);
        Serial.print(" cm/s  (");
        Serial.print(smoothedSpeed * 60.0, 1); // Convert to cm/min
        Serial.println(" cm/min)");
    }

    Serial.println("--------------------");

    delay(1000); // Sample rate: 1 Hz
}
