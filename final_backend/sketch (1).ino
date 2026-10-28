#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// --- Wi-Fi Configuration (ESP32 creates this network) ---
const char* ssid = "Flood_Sensor_Network";
const char* password = "adminpassword";

// The IP of the computer/server that connects to the ESP32's Wi-Fi.

const char* serverUrl = "http://192.168.4.2:8080/api/flood-data"; 

// --- Tank Data Structure ---
struct Tank {
    int trigPin;
    int echoPin;
    float height;
    float offset;
    float distance;
    float waterLevel;
    float speed;
    float prevLevel;
};

// Initialize 3 tanks
Tank tanks[3] = {
    {5,  18, 100.0, 0.0, 0, 0, 0, -1.0},
    {19, 21, 100.0, 0.0, 0, 0, 0, -1.0},
    {22, 23, 100.0, 0.0, 0, 0, 0, -1.0} 
};

unsigned long lastPushTime = 0;
const unsigned long PUSH_INTERVAL = 3000; // Push data every 3 seconds
const float ALPHA = 0.2; // Speed smoothing

// --- Helper: Median Filter (Ignores glitches) ---
float getFilteredDistance(int trig, int echo) {
    float readings[3];
    for (int i = 0; i < 3; i++) {
        digitalWrite(trig, LOW); delayMicroseconds(2);
        digitalWrite(trig, HIGH); delayMicroseconds(10);
        digitalWrite(trig, LOW);
        readings[i] = pulseIn(echo, HIGH, 30000) * 0.0343 / 2.0;
        delay(15); 
    }
    // Return middle value
    if (readings[0] > readings[1]) std::swap(readings[0], readings[1]);
    if (readings[1] > readings[2]) std::swap(readings[1], readings[2]);
    if (readings[0] > readings[1]) std::swap(readings[0], readings[1]);
    return readings[1]; 
}

// --- Measurement Logic ---
void measureTank(Tank &t, float timeDelta) {
    float dist = getFilteredDistance(t.trigPin, t.echoPin);
    if (dist > 0.0) {
        t.distance = dist;
        t.waterLevel = (t.height + t.offset) - t.distance;

        if (t.waterLevel < 0) t.waterLevel = 0;
        if (t.waterLevel > t.height) t.waterLevel = t.height;

        if (t.prevLevel >= 0 && timeDelta > 0) {
            float rawSpeed = (t.waterLevel - t.prevLevel) / timeDelta;
            if (abs(rawSpeed) < 15.0) { 
                t.speed = (ALPHA * rawSpeed) + ((1.0 - ALPHA) * t.speed);
            }
        }
        t.prevLevel = t.waterLevel;
    }
}

// --- Push Data Logic ---
void pushDataToConnectedComputer() {
    // 1. Pack data into JSON
    JsonDocument doc;
    JsonArray array = doc["tanks"].to<JsonArray>();

    for (int i = 0; i < 3; i++) {
        JsonObject t = array.add<JsonObject>();
        t["id"] = i + 1;
        t["water_level"] = round(tanks[i].waterLevel * 10.0) / 10.0;
        t["speed"] = round(tanks[i].speed * 100.0) / 100.0;
    }

    String jsonPayload;
    serializeJson(doc, jsonPayload);

    // 2. Push directly to the connected computer
    HTTPClient http;
    http.begin(serverUrl);
    http.addHeader("Content-Type", "application/json");

    int responseCode = http.POST(jsonPayload);
    
    Serial.print("Pushed data to ");
    Serial.print(serverUrl);
    Serial.print(" | Response: ");
    Serial.println(responseCode); // 200 = Success, -1 = Computer not listening

    http.end();
}

void setup() {
    Serial.begin(115200);

    for (int i = 0; i < 3; i++) {
        pinMode(tanks[i].trigPin, OUTPUT);
        pinMode(tanks[i].echoPin, INPUT);
        digitalWrite(tanks[i].trigPin, LOW);
    }

    // 1. Create the Wi-Fi Network
    Serial.println("Starting Wi-Fi Access Point...");
    WiFi.softAP(ssid, password);
    
    Serial.print("Network Created! Connect your computer to: ");
    Serial.println(ssid);
    Serial.println("ESP32 is actively pushing data. Ensure your server script is running.");
}

void loop() {
    unsigned long currentTime = millis();
    
    // Every 3 seconds, measure and push
    if (currentTime - lastPushTime >= PUSH_INTERVAL) {
        float timeDelta = (currentTime - lastPushTime) / 1000.0;
        lastPushTime = currentTime;
        
        // Measure tanks with acoustic delay
        for (int i = 0; i < 3; i++) {
            measureTank(tanks[i], timeDelta);
            delay(40); 
        }

        // Push to server
        // Note: Only pushes if at least one device (your computer) is connected to the Wi-Fi
        if (WiFi.softAPgetStationNum() > 0) {
            pushDataToConnectedComputer();
        } else {
            Serial.println("Waiting for a computer to connect to the Wi-Fi network...");
        }
    }
}
