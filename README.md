# 🌊 IoT-Based Flood Early Warning & Alert System

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform: Arduino / ESP32 / ESP8266](https://img.shields.io/badge/Platform-Arduino%20%7C%20ESP32%20%7C%20NodeMCU-blue.svg)](https://www.arduino.cc/)
[![IoT: GSM / Blynk / MQTT](https://img.shields.io/badge/Connectivity-GSM%20%7C%20WiFi%20%7C%20MQTT-brightgreen.svg)]()
[![Status: Active](https://img.shields.io/badge/Status-Maintained-success.svg)]()

An automated IoT-driven flood monitoring and early warning system designed to detect rising water levels in rivers, drains, reservoirs, and urban underpasses. It provides real-time local warnings (buzzer, LEDs, LCD display) and remote emergency alerts via GSM/SMS and cloud IoT platforms (Blynk, MQTT, or Webhooks) to mitigate disaster impact and safeguard communities.

---
## 🧑‍💻 Contributors

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/Sivodayan" style="text-decoration:none">
        <img src="https://github.com/Sivodayan.png" width="80px;" alt="Sivodayan"/><br />
        <sub><b><font color="inherit">Sivodayan</font></b></sub>
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/notShehaz" style="text-decoration:none">
        <img src="https://github.com/notShehaz.png" width="80px;" alt="Shehaz"/><br />
        <sub><b><font color="inherit">Shehaz</font></b></sub>
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/RLackshika" style="text-decoration:none">
        <img src="https://github.com/RLackshika.png" width="80px;" alt="Lackshika"/><br />
        <sub><b><font color="inherit">Lackshika</font></b></sub>
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/dhanitha-61616" style="text-decoration:none">
        <img src="https://github.com/dhanitha-61616.png" width="80px;" alt="Dhanitha"/><br />
        <sub><b><font color="inherit">Dhanitha</font></b></sub>
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/sabthavi03" style="text-decoration:none">
        <img src="https://github.com/sabthavi03.png" width="80px;" alt="Sabthavi"/><br />
        <sub><b><font color="inherit">Sabthavi</font></b></sub>
      </a>
    </td>
  </tr>
</table>
 

A team project of VOID WARRIORS

## 📌 Table of Contents

- [Key Features](#-key-features)
- [System Architecture](#-system-architecture)
- [Hardware Components](#-hardware-components)
- [Software & Dependencies](#-software--dependencies)
- [Alert Level Logic](#-alert-level-logic)
- [Pinout & Wiring Guide](#-pinout--wiring-guide)
- [Getting Started](#-getting-started)
  - [Hardware Setup](#1-hardware-setup)
  - [Configuration](#2-configuration)
  - [Upload & Run](#3-upload--run)
- [Project Directory Structure](#-project-directory-structure)
- [Roadmap](#-roadmap)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🚀 Key Features

- **Continuous Level Sensing**: High-accuracy contactless distance/depth measurement using ultrasonic sensors (HC-SR04 / JSN-SR04T waterproof).
- **Multi-Stage Threshold Alerts**:
  - 🟢 **Normal / Safe**: Water level within safe operating boundaries.
  - 🟡 **Warning**: Water level reaches pre-flood cautionary threshold; local visual warning activated.
  - 🔴 **Danger / Critical**: Water level exceeds safe limit; triggers continuous loud alarms and automated SMS/IoT push notifications.
- **Fail-Safe Connectivity**:
  - Remote SMS broadcasting to registered emergency contacts via GSM Module (SIM800L / SIM900).
  - Optional cloud dashboard integration (Blynk / Adafruit IO / ThingsBoard / MQTT) over Wi-Fi.
- **Local Telemetry & Indication**:
  - 16x2 / 20x4 I2C Liquid Crystal Display (LCD) for real-time distance and status.
  - Piezo buzzer audible alert and multi-color indicator LEDs.
- **Low Power & Solar Ready**: Designed with low quiescent current, suitable for 5V–12V battery and solar-assisted remote deployments.

---

## 🏗 System Architecture

```text
  ┌─────────────────────────────────────────────────────────────┐
  │                        Sensing Layer                        │
  │   - HC-SR04 / JSN-SR04T Ultrasonic Sensor (Water Level)      │
  │   - Optional: Rain / Flow Rate Sensors                      │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                       Processing Unit                       │
  │          Microcontroller (Arduino Uno / ESP32 / ESP8266)    │
  │   - Signal filtering & moving average distance calculation  │
  │   - Threshold comparator & alert state engine               │
  └───────────────┬─────────────────────────────┬───────────────┘
                  │                             │
                  ▼                             ▼
  ┌──────────────────────────────┐ ┌────────────────────────────┐
  │     Local Warning Unit       │ │     Remote Telemetry       │
  │ - 16x2 / 20x4 I2C LCD        │ │ - GSM Module (SIM800L)     │
  │ - High-Decibel Buzzer        │ │   (Automated SMS Alerts)   │
  │ - Status Indicator LEDs      │ │ - Wi-Fi Cloud Dashboard    │
  │ - Optional: Barrier Servo    │ │   (Blynk / MQTT Broker)    │
  └──────────────────────────────┘ └────────────────────────────┘
```

---

## 🔌 Hardware Components

| Component | Recommended Model | Purpose |
| :--- | :--- | :--- |
| **Microcontroller** | Arduino Uno / Nano / ESP32 / NodeMCU | Main logic, sensor reading, control loop |
| **Water Level Sensor** | HC-SR04 or JSN-SR04T (Waterproof) | Contactless distance sensing to water surface |
| **GSM Module** | SIM800L / SIM900A | Cellular communication for emergency SMS |
| **Display** | 16x2 or 20x4 LCD with I2C Backpack | Real-time status, distance, and warnings |
| **Audio Alert** | 5V Active Buzzer | Local acoustic warning tone |
| **Visual Indicators** | Red, Yellow, Green LEDs | Visual alert status indicators |
| **Power Supply** | 5V / 2A Step-Down / 18650 Battery / LM7805 | Regulated power delivery |
| **Resistors & Wiring** | 220Ω, 1kΩ, 2kΩ (voltage divider for SIM800L) | Breadboard, jumper wires, pull-down resistors |

---

## 💻 Software & Dependencies

- **IDE**: [Arduino IDE](https://www.arduino.cc/en/software) (version 1.8.x or 2.x) or [PlatformIO](https://platformio.org/)
- **Core Libraries**:
  - `LiquidCrystal_I2C` by Frank de Brabander (LCD management)
  - `SoftwareSerial` (for GSM communication on Arduino Uno/Nano)
  - `Wire` (I2C communication)
  - *(Optional)* `BlynkSimpleEsp8266` / `BlynkSimpleEsp32` (if using Blynk IoT cloud)
  - *(Optional)* `PubSubClient` (for MQTT-based reporting)

---

## 📊 Alert Level Logic

Assuming the sensor is mounted overhead at height $H_{\text{total}}$ pointing downward toward the river/drain bed:

$$\text{Water Level} = H_{\text{total}} - \text{Measured Distance}$$

| Condition | Water Level % | Local Action | Remote Action |
| :--- | :---: | :--- | :--- |
| **SAFE** | $< 50\%$ | Green LED ON; LCD displays "Status: NORMAL" | Routine telemetry |
| **WARNING** | $50\% - 79\%$ | Yellow LED ON; intermittent beep | Pre-alert telemetry |
| **CRITICAL / FLOOD**| $\ge 80\%$ | Red LED ON; continuous buzzer alarm | Instant SMS sent to authorities / residents |

---

## 📌 Pinout & Wiring Guide

### Ultrasonic Sensor (HC-SR04)
- `VCC` $\rightarrow$ `5V`
- `GND` $\rightarrow$ `GND`
- `TRIG` $\rightarrow$ `D9` *(Configurable in code)*
- `ECHO` $\rightarrow$ `D10` *(Configurable in code)*

### I2C LCD (16x2)
- `VCC` $\rightarrow$ `5V`
- `GND` $\rightarrow$ `GND`
- `SDA` $\rightarrow$ `A4` (Arduino Uno) / `GPIO 21` (ESP32)
- `SCL` $\rightarrow$ `A5` (Arduino Uno) / `GPIO 22` (ESP32)

### GSM Module (SIM800L)
- `VCC` $\rightarrow$ External `3.7V - 4.2V` (Peak 2A source)
- `GND` $\rightarrow$ Common `GND`
- `TXD` $\rightarrow$ `D2` (Software Serial RX)
- `RXD` $\rightarrow$ `D3` (Software Serial TX via voltage divider: $5\text{V} \rightarrow 3.3\text{V}$)

### Indicators & Buzzer
- **Green LED**: Pin `D5` (with 220Ω resistor)
- **Yellow LED**: Pin `D6` (with 220Ω resistor)
- **Red LED**: Pin `D7` (with 220Ω resistor)
- **Buzzer**: Pin `D8`

---

## 🛠 Getting Started

### 1. Hardware Setup
1. Assemble the circuit following the wiring table above.
2. If using a GSM module (e.g., SIM800L), insert a 2G/compatible micro-SIM card with active SMS credit.
3. Ensure the SIM800L has an independent power supply capable of supplying 2A current bursts.

### 2. Configuration
1. Clone this repository:
   ```bash
   git clone https://github.com/Sivodayan/Flood-Alert-System.git
   cd Flood-Alert-System
   ```
2. Open the main sketch (`.ino`) file in the Arduino IDE.
3. Update key system constants in the configuration section:
   ```cpp
   // Emergency Contact
   const char EMERGENCY_PHONE[] = "+1234567890";

   // Threshold distances in cm (distance from sensor to water surface)
   const int DISTANCE_SAFE = 50;     // Greater than 50cm = Safe
   const int DISTANCE_WARNING = 25;  // Between 10cm and 25cm = Warning
   const int DISTANCE_DANGER = 10;   // Less than 10cm = Danger
   ```

### 3. Upload & Run
1. Connect your microcontroller to your computer via USB.
2. Select your board and COM port under **Tools > Board** and **Tools > Port**.
3. Install required libraries using **Sketch > Include Library > Manage Libraries...**.
4. Click **Upload** ($\rightarrow$).
5. Open the Serial Monitor at `9600` baud (or configured baud rate) to verify live readings and AT commands.

---

## 📁 Project Directory Structure

```text
Flood-Alert-System/
├── src/
│   └── flood_alert_system.ino     # Core microcontroller firmware
├── schematics/
│   └── circuit_diagram.png        # Circuit connection diagram
├── docs/
│   └── architecture_flowchart.png # Flowchart diagram of system logic
├── LICENSE                        # Project license
└── README.md                      # Project documentation
```

---

## 🗺 Roadmap

- [ ] Add support for waterproof JSN-SR04T sensor calibration.
- [ ] Implement LoRa point-to-point wireless transmission for remote rural basins without GSM coverage.
- [ ] Add deep-sleep cycles to optimize battery and solar power life.
- [ ] Provide web dashboard templates with ESP32 WebSockets / Chart.js for real-time hydrographs.

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues or pull requests:

1. Fork the Project (`git checkout -b feature/AmazingFeature`)
2. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
3. Push to the Branch (`git push origin feature/AmazingFeature`)
4. Open a Pull Request

---

## 📄 License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.
