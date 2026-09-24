#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h> // Ensure you install this via Library Manager

// --- Wi-Fi & Server Configuration ---
const char* ssid = "MultiTank_Monitor";
const char* password = "adminpassword";

WebServer server(80);

// --- Tank Data Structure ---
struct Tank {
    int trigPin;
    int echoPin;
    float height;       // Max capacity height in cm
    float offset;       // Gap between sensor face and 100% water mark in cm
    
    // Runtime telemetry
    float distance;
    float waterLevel;
    float percentage;
    float speed;
    float prevLevel;
    bool error;
};

// Initialize 3 tanks (Adjust pins, height, and offset as needed)
Tank tanks[3] = {
    {5,  18, 100.0, 0.0, 0, 0, 0, 0, -1.0, false}, // Tank 1
    {19, 21, 100.0, 0.0, 0, 0, 0, 0, -1.0, false}, // Tank 2
    {22, 23, 100.0, 0.0, 0, 0, 0, 0, -1.0, false}  // Tank 3
};

unsigned long lastMeasureTime = 0;
const unsigned long MEASURE_INTERVAL = 1000; // Measure once per second
const float ALPHA = 0.2; // EMA Filter weight for smoothing speed

// --- Helper: Median Filter for Ultrasonic Sensor ---
// Takes 3 quick readings and returns the median to eliminate FreeRTOS spikes
float getFilteredDistance(int trig, int echo) {
    float readings[3];
    
    for (int i = 0; i < 3; i++) {
        digitalWrite(trig, LOW);
        delayMicroseconds(2);
        digitalWrite(trig, HIGH);
        delayMicroseconds(10);
        digitalWrite(trig, LOW);

        long duration = pulseIn(echo, HIGH, 30000);
        readings[i] = duration * 0.0343 / 2.0;
        
        delay(15); // Tiny delay between internal samples to let local echoes fade
    }

    // Sort the 3 readings from lowest to highest
    if (readings[0] > readings[1]) std::swap(readings[0], readings[1]);
    if (readings[1] > readings[2]) std::swap(readings[1], readings[2]);
    if (readings[0] > readings[1]) std::swap(readings[0], readings[1]);

    // Return the middle value (discarding random highs or lows)
    return readings[1]; 
}

// --- Tank Measurement Logic ---
void measureTank(Tank &t, float timeDeltaSeconds) {
    float dist = getFilteredDistance(t.trigPin, t.echoPin);

    // If distance is 0, the sensor timed out or is disconnected
    if (dist == 0.0) {
        t.error = true;
    } else {
        t.error = false;
        t.distance = dist;
        t.waterLevel = (t.height + t.offset) - t.distance;

        // Clamp boundaries to prevent impossible percentages
        if (t.waterLevel < 0) t.waterLevel = 0;
        if (t.waterLevel > t.height) t.waterLevel = t.height;

        t.percentage = (t.waterLevel / t.height) * 100.0;

        // Calculate Rising/Falling Speed
        if (t.prevLevel >= 0 && timeDeltaSeconds > 0) {
            float rawSpeed = (t.waterLevel - t.prevLevel) / timeDeltaSeconds;
            
            // Only update speed if the change is physically possible (e.g., < 15 cm/s)
            // This prevents massive speed spikes if a rogue glitch slips through
            if (abs(rawSpeed) < 15.0) { 
                t.speed = (ALPHA * rawSpeed) + ((1.0 - ALPHA) * t.speed);
            }
        }
        
        t.prevLevel = t.waterLevel;
    }
}

// --- Web Server Endpoint ---
void handleGetData() {
    // JsonDocument automatically handles memory allocation safely without fragmentation
    JsonDocument doc; 
    
    JsonArray tankArray = doc["tanks"].to<JsonArray>();

    for (int i = 0; i < 3; i++) {
        JsonObject tankObj = tankArray.add<JsonObject>();
        tankObj["id"] = i + 1;
        
        if (tanks[i].error) {
            tankObj["status"] = "error";
            tankObj["distance_cm"] = 0;
            tankObj["water_level_cm"] = 0;
            tankObj["capacity_percent"] = 0;
            tankObj["speed_cm_s"] = 0;
        } else {
            tankObj["status"] = "ok";
            // Round values to 1 or 2 decimal places to keep JSON payload clean
            tankObj["distance_cm"] = round(tanks[i].distance * 10.0) / 10.0;
            tankObj["water_level_cm"] = round(tanks[i].waterLevel * 10.0) / 10.0;
            tankObj["capacity_percent"] = round(tanks[i].percentage * 10.0) / 10.0;
            tankObj["speed_cm_s"] = round(tanks[i].speed * 100.0) / 100.0;
        }
    }

    String response;
    serializeJson(doc, response);
    server.send(200, "application/json", response);
}

void setup() {
    Serial.begin(115200);

    // Initialize pins for all tanks
    for (int i = 0; i < 3; i++) {
        pinMode(tanks[i].trigPin, OUTPUT);
        pinMode(tanks[i].echoPin, INPUT);
        digitalWrite(tanks[i].trigPin, LOW);
    }

    // Start Wi-Fi Access Point
    WiFi.softAP(ssid, password);
    Serial.print("\nAccess Point Started!");
    Serial.print("\nConnect to Wi-Fi: ");
    Serial.println(ssid);
    Serial.print("Data available at: http://");
    Serial.print(WiFi.softAPIP());
    Serial.println("/data");

    // Define server routes
    server.on("/data", HTTP_GET, handleGetData);
    server.begin();
}

void loop() {
    // Keep web server responsive
    server.handleClient();

    unsigned long currentTime = millis();
    
    // Non-blocking loop for taking measurements
    if (currentTime - lastMeasureTime >= MEASURE_INTERVAL) {
        
        // Calculate exact time delta for highly accurate speed math
        float timeDeltaSeconds = (currentTime - lastMeasureTime) / 1000.0;
        lastMeasureTime = currentTime;
        
        // Measure each tank sequentially
        for (int i = 0; i < 3; i++) {
            measureTank(tanks[i], timeDeltaSeconds);
            
            // CRITICAL: 40ms acoustic clearing delay between tanks.
            // Prevents Tank 2 from picking up residual echoes bouncing from Tank 1.
            delay(40); 
        }

        // Serial Debug Print
        for (int i = 0; i < 3; i++) {
            Serial.print("Tank "); 
            Serial.print(i + 1);
            if (tanks[i].error) {
                Serial.println(": SENSOR ERROR");
            } else {
                Serial.print(": "); 
                Serial.print(tanks[i].waterLevel, 1);
                Serial.print(" cm | Speed: "); 
                Serial.print(tanks[i].speed, 2);
                Serial.println(" cm/s");
            }
        }
        Serial.println("--------------------------------");
    }
}
