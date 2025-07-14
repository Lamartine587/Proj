#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <NewPing.h>
#include <MFRC522.h>
#include <ESP32Servo.h>
#include <SPI.h>
#include <time.h>

// --- WiFi Credentials ---
#define WIFI_SSID "OPPO A58"
#define WIFI_PASSWORD "gyutcuu55"

// --- Backend API Endpoint ---
#define API_BASE_URL "https://smarthome-lfyp.onrender.com"
#define API_SENSORS_ENDPOINT "/api/sensors"
#define API_COMMANDS_ENDPOINT "/api/commands"

// --- Device IDs ---
#define SMART_LOCK_ID "smartLock001"
#define MOTION_SENSOR_ID "motionSensor001"
#define ULTRASONIC_SENSOR_ID "ultrasonicSensor001"
#define SIREN_ID "siren001"
#define SYSTEM_ARMED_SETTING "systemArmed"

// --- Pin Definitions ---
const int SERVO_MOTOR_PIN = 2;
const int MOTION_SENSOR_PIN = 13;
const int ULTRASONIC_TRIG_PIN = 32;
const int ULTRASONIC_ECHO_PIN = 33;
const int ALARM_SIREN_PIN = 14;
const int ARMED_LED_PIN = 15;
#define SS_PIN 5
#define RST_PIN 27

// --- Global Variables and Objects ---
WiFiClientSecure espClient;
NewPing ultrasonicSensor(ULTRASONIC_TRIG_PIN, ULTRASONIC_ECHO_PIN, 200);
MFRC522 rfid(SS_PIN, RST_PIN);
Servo lockServo;

// Device States
String currentLockStatus = "LOCKED";
String currentMotionStatus = "CLEARED";
float currentDistanceValue = 0.0;
String currentAlarmStatus = "INACTIVE";
String currentArmedStatus = "DISARMED";

// Servo Angles
const int LOCKED_ANGLE = 0;
const int UNLOCKED_ANGLE = 90;

// RFID Authorized Tags
byte authorizedUIDs[1][4] = {{0xB4, 0xEB, 0x1E, 0x03}};
const int NUM_AUTHORIZED_TAGS = sizeof(authorizedUIDs) / sizeof(authorizedUIDs[0]);

// Timers
unsigned long lastMotionReadTime = 0;
unsigned long lastDistanceReadTime = 0;
unsigned long lastPublishTime = 0;
unsigned long lastRFIDReadTime = 0;
unsigned long lastUnlockTime = 0;
unsigned long unlockDelayStart = 0;
unsigned long lastCommandPollTime = 0;
const long HEARTBEAT_INTERVAL = 30000; // 30 seconds
const long MOTION_READ_INTERVAL = 500;
const long DISTANCE_READ_INTERVAL = 1000;
const long PUBLISH_INTERVAL = 5000;
const long RFID_READ_INTERVAL = 500;
const long UNLOCK_DURATION = 5000;
const long UNLOCK_DELAY = 5000;
const long DEBOUNCE_DELAY = 50;
const long BEEP_DURATION = 100;
const long COMMAND_POLL_INTERVAL = 5000; // Poll every 5 seconds
const float DISTANCE_UNLOCK_THRESHOLD = 8.0;

// Motion Sensor Debounce
int lastMotionState = LOW;
unsigned long lastDebounceTime = 0;

// Unique Device ID
char deviceId[30];

// Buffer for distance payload
char payloadBuffer[10];

// --- Function Prototypes ---
void setup_wifi();
void syncTime();
void sendSensorData();
void pollCommands();
void readMotionSensor();
void readUltrasonicSensor();
void readRFID();
bool compareUIDs(byte* uid1, byte* uid2, int size);
void updateLockActuator();
void updateAlarmActuator();
void updateArmedLed();
void beepSiren(int count);
void printLocalTime();

void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println("\nBooting ESP32 Smart Home Node...");

    pinMode(ALARM_SIREN_PIN, OUTPUT);
    pinMode(ARMED_LED_PIN, OUTPUT);
    pinMode(MOTION_SENSOR_PIN, INPUT);

    lockServo.attach(SERVO_MOTOR_PIN);
    lockServo.write(LOCKED_ANGLE);
    digitalWrite(ALARM_SIREN_PIN, LOW);
    digitalWrite(ARMED_LED_PIN, LOW);

    SPI.begin();
    rfid.PCD_Init();
    Serial.println("RFID Reader initialized.");

    uint8_t mac[6];
    WiFi.macAddress(mac);
    snprintf(deviceId, sizeof(deviceId), "esp32_smarthome_%02x%02x%02x", mac[3], mac[4], mac[5]);
    Serial.print("Device ID: ");
    Serial.println(deviceId);

    setup_wifi();
    syncTime();

    // Skip CA verification (Render uses Let's Encrypt, trusted by ESP32)
    espClient.setInsecure(); // Remove after testing if CA verification needed
    Serial.println("Setup Complete. Starting main loop...");
    printLocalTime();

    // Initialize devices in backend
    sendSensorData();
}

void loop() {
    unsigned long currentMillis = millis();

    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("WiFi disconnected, reconnecting...");
        setup_wifi();
    }

    if (currentMillis - lastMotionReadTime >= MOTION_READ_INTERVAL) {
        readMotionSensor();
        lastMotionReadTime = currentMillis;
    }

    if (currentMillis - lastDistanceReadTime >= DISTANCE_READ_INTERVAL) {
        readUltrasonicSensor();
        lastDistanceReadTime = currentMillis;
    }

    if (currentMillis - lastRFIDReadTime >= RFID_READ_INTERVAL) {
        readRFID();
        lastRFIDReadTime = currentMillis;
    }

    if (currentLockStatus == "UNLOCKED" && unlockDelayStart > 0 && currentMillis - unlockDelayStart >= UNLOCK_DELAY) {
        lockServo.write(UNLOCKED_ANGLE);
        Serial.println("Servo: UNLOCKED (after 5-second delay)");
        unlockDelayStart = 0;
    }

    if (currentLockStatus == "UNLOCKED" && lastUnlockTime > 0 && currentMillis - lastUnlockTime >= UNLOCK_DURATION) {
        currentLockStatus = "LOCKED";
        updateLockActuator();
        sendSensorData();
        Serial.println("Door auto-locked after timeout.");
        lastUnlockTime = 0;
    }

    if (currentMillis - lastPublishTime >= PUBLISH_INTERVAL) {
        sendSensorData();
        lastPublishTime = currentMillis;
    }

    if (currentMillis - lastCommandPollTime >= COMMAND_POLL_INTERVAL) {
        pollCommands();
        lastCommandPollTime = currentMillis;
    }

    if (currentMillis - lastPublishTime >= HEARTBEAT_INTERVAL) {
        sendSensorData();
        printLocalTime();
        lastPublishTime = currentMillis;
    }
}

void setup_wifi() {
    delay(10);
    Serial.print("Connecting to WiFi: ");
    Serial.println(WIFI_SSID);

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    int attempts = 0;
    const int MAX_WIFI_ATTEMPTS = 40;
    while (WiFi.status() != WL_CONNECTED && attempts < MAX_WIFI_ATTEMPTS) {
        delay(500);
        Serial.print(".");
        attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\nWiFi connected successfully!");
        Serial.print("IP address: ");
        Serial.println(WiFi.localIP());
        IPAddress serverIP;
        if (WiFi.hostByName("smarthome-lfyp.onrender.com", serverIP)) {
            Serial.print("Resolved backend IP: ");
            Serial.println(serverIP);
        } else {
            Serial.println("Failed to resolve backend hostname!");
        }
    } else {
        Serial.println("\nWiFi connection FAILED! Please check credentials or network.");
        Serial.println("Attempting to restart ESP32 in 5 seconds...");
        delay(5000);
        ESP.restart();
    }
}

void syncTime() {
    Serial.println("Setting up time using SNTP");
    const char* ntpServers[] = {"time.google.com", "time.windows.com", "pool.ntp.org"};
    int ntpServerCount = 3;
    bool timeSynced = false;

    for (int i = 0; i < ntpServerCount && !timeSynced; i++) {
        Serial.print("Trying NTP server: ");
        Serial.println(ntpServers[i]);
        configTime(0, 0, ntpServers[i]);
        time_t now = time(nullptr);
        int retry = 0;
        const int retry_count = 30;
        while (now < 24 * 3600 && retry < retry_count) {
            Serial.print(".");
            delay(200);
            now = time(nullptr);
            retry++;
        }
        if (now >= 24 * 3600) {
            timeSynced = true;
            Serial.println("\nTime synchronized with " + String(ntpServers[i]) + ": " + String(ctime(&now)));
        } else {
            Serial.println("\nFailed to sync with " + String(ntpServers[i]));
        }
    }

    if (!timeSynced) {
        Serial.println("All NTP servers failed, trying HTTP time API...");
        HTTPClient http;
        http.begin("http://worldtimeapi.org/api/timezone/Etc/UTC");
        int httpCode = http.GET();
        if (httpCode == HTTP_CODE_OK) {
            String payload = http.getString();
            DynamicJsonDocument doc(1024);
            deserializeJson(doc, payload);
            long unixtime = doc["unixtime"];
            if (unixtime > 0) {
                timeval tv = { unixtime, 0 };
                settimeofday(&tv, nullptr);
                time_t now = time(nullptr);
                Serial.println("Time synchronized via HTTP API: " + String(ctime(&now)));
                timeSynced = true;
            } else {
                Serial.println("Failed to parse HTTP time API response!");
            }
        } else {
            Serial.println("HTTP time API request failed, code: " + String(httpCode));
        }
        http.end();
    }

    if (!timeSynced) {
        Serial.println("All time sync attempts failed, using fallback");
        struct tm timeinfo;
        timeinfo.tm_year = 125; // 2025 - 1900
        timeinfo.tm_mon = 6;    // July
        timeinfo.tm_mday = 14;
        timeinfo.tm_hour = 10;  // 10:35 EAT (UTC+3)
        timeinfo.tm_min = 35;
        timeinfo.tm_sec = 0;
        time_t fallback = mktime(&timeinfo);
        timeval tv = { fallback, 0 };
        settimeofday(&tv, nullptr);
        time_t now = time(nullptr);
        Serial.println("Fallback time set: " + String(ctime(&now)));
    }
}

void printLocalTime() {
    time_t now = time(nullptr);
    Serial.print("Current time: ");
    Serial.println(ctime(&now));
}

void sendSensorData() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("Cannot send sensor data: WiFi not connected");
        return;
    }

    HTTPClient http;
    http.begin(String(API_BASE_URL) + API_SENSORS_ENDPOINT);
    http.addHeader("Content-Type", "application/json");

    // Send data for each device
    DynamicJsonDocument doc(1024);
    JsonArray updates = doc.createNestedArray("updates");

    // Get current time
    time_t now = time(nullptr);
    String timestamp = String(ctime(&now)).substring(0, 24);

    // Smart Lock
    JsonObject lockUpdate = updates.createNestedObject();
    lockUpdate["deviceId"] = SMART_LOCK_ID;
    lockUpdate["status"] = currentLockStatus;
    lockUpdate["isArmed"] = (currentLockStatus == "LOCKED");
    lockUpdate["lastActivity"] = timestamp;

    // Motion Sensor
    JsonObject motionUpdate = updates.createNestedObject();
    motionUpdate["deviceId"] = MOTION_SENSOR_ID;
    motionUpdate["status"] = currentMotionStatus;
    motionUpdate["lastActivity"] = timestamp;

    // Ultrasonic Sensor
    JsonObject ultrasonicUpdate = updates.createNestedObject();
    ultrasonicUpdate["deviceId"] = ULTRASONIC_SENSOR_ID;
    ultrasonicUpdate["value"] = currentDistanceValue;
    ultrasonicUpdate["lastActivity"] = timestamp;

    // Siren
    JsonObject sirenUpdate = updates.createNestedObject();
    sirenUpdate["deviceId"] = SIREN_ID;
    sirenUpdate["status"] = currentAlarmStatus;
    sirenUpdate["lastActivity"] = timestamp;

    // System Armed
    JsonObject settingUpdate = updates.createNestedObject();
    settingUpdate["settingName"] = SYSTEM_ARMED_SETTING;
    settingUpdate["value"] = (currentArmedStatus == "ARMED");
    settingUpdate["lastActivity"] = timestamp;

    String payload;
    serializeJson(doc, payload);

    int httpCode = http.POST(payload);
    if (httpCode == HTTP_CODE_OK || httpCode == HTTP_CODE_CREATED) {
        Serial.println("Sensor data sent successfully: " + payload);
    } else {
        Serial.println("Failed to send sensor data, HTTP code: " + String(httpCode));
        Serial.println("Payload: " + payload);
    }
    http.end();
}

void pollCommands() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("Cannot poll commands: WiFi not connected");
        return;
    }

    HTTPClient http;
    http.begin(String(API_BASE_URL) + API_COMMANDS_ENDPOINT + "?device_id=" + String(deviceId));
    int httpCode = http.GET();
    if (httpCode == HTTP_CODE_OK) {
        String payload = http.getString();
        DynamicJsonDocument doc(512);
        DeserializationError error = deserializeJson(doc, payload);
        if (!error) {
            if (doc.containsKey("command")) {
                String command = doc["command"].as<String>();
                if (command == "LOCK" && currentLockStatus != "LOCKED") {
                    currentLockStatus = "LOCKED";
                    unlockDelayStart = 0;
                    Serial.println("Command: LOCK DOOR");
                    updateLockActuator();
                    sendSensorData();
                } else if (command == "UNLOCK" && currentLockStatus != "UNLOCKED") {
                    currentLockStatus = "UNLOCKED";
                    lastUnlockTime = millis();
                    unlockDelayStart = millis();
                    Serial.println("Command: UNLOCK DOOR (starting 5-second delay)");
                    sendSensorData();
                } else if (command == "ARM" && currentArmedStatus != "ARMED") {
                    currentArmedStatus = "ARMED";
                    Serial.println("Command: ARM SYSTEM");
                    updateArmedLed();
                    sendSensorData();
                } else if (command == "DISARM" && currentArmedStatus != "DISARMED") {
                    currentArmedStatus = "DISARMED";
                    lastUnlockTime = 0;
                    Serial.println("Command: DISARM SYSTEM");
                    updateArmedLed();
                    sendSensorData();
                }
            }
        } else {
            Serial.println("Failed to parse command JSON: " + String(error.c_str()));
        }
    } else {
        Serial.println("Failed to poll commands, HTTP code: " + String(httpCode));
    }
    http.end();
}

void readMotionSensor() {
    int reading = digitalRead(MOTION_SENSOR_PIN);
    if (reading != lastMotionState) {
        lastDebounceTime = millis();
    }
    if ((millis() - lastDebounceTime) > DEBOUNCE_DELAY) {
        if (reading != (currentMotionStatus.equals("DETECTED") ? HIGH : LOW)) {
            String newMotionStatus;
            if (reading == HIGH) {
                newMotionStatus = "DETECTED";
                if (currentArmedStatus == "ARMED" && currentAlarmStatus == "INACTIVE") {
                    currentAlarmStatus = "ACTIVE";
                    updateAlarmActuator();
                    sendSensorData();
                    Serial.println("Motion detected while armed! ALARM ACTIVE!");
                }
            } else {
                newMotionStatus = "CLEARED";
            }
            if (newMotionStatus != currentMotionStatus) {
                currentMotionStatus = newMotionStatus;
                Serial.print("Motion: ");
                Serial.println(currentMotionStatus);
                sendSensorData();
            }
        }
    }
    lastMotionState = reading;
}

void readUltrasonicSensor() {
    unsigned int uS = ultrasonicSensor.ping_cm();
    float newDistanceValue = (float)uS;
    if (abs(newDistanceValue - currentDistanceValue) > 1.0 || (newDistanceValue == 0 && currentDistanceValue != 0) || (newDistanceValue != 0 && currentDistanceValue == 0)) {
        currentDistanceValue = newDistanceValue;
        Serial.print("Distance: ");
        Serial.print(currentDistanceValue);
        Serial.println(" cm");
        sendSensorData();
        if (currentArmedStatus == "ARMED" && currentAlarmStatus == "INACTIVE" && currentDistanceValue > 0 && currentDistanceValue < 10) {
            currentAlarmStatus = "ACTIVE";
            updateAlarmActuator();
            sendSensorData();
            Serial.println("Object too close while armed! ALARM ACTIVE!");
        }
    }
}

void readRFID() {
    if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
        Serial.print("RFID Tag detected! UID:");
        String uidStr = "";
        for (byte i = 0; i < rfid.uid.size; i++) {
            if (rfid.uid.uidByte[i] < 0x10) {
                uidStr += " 0";
            } else {
                uidStr += " ";
            }
            uidStr += String(rfid.uid.uidByte[i], HEX);
        }
        uidStr.toUpperCase();
        Serial.println(uidStr);

        bool authorized = false;
        for (int i = 0; i < NUM_AUTHORIZED_TAGS; i++) {
            if (rfid.uid.size == 4 && compareUIDs(rfid.uid.uidByte, authorizedUIDs[i], 4)) {
                authorized = true;
                break;
            }
        }

        // Get current time
        time_t now = time(nullptr);
        String timestamp = String(ctime(&now)).substring(0, 24);

        if (authorized) {
            Serial.println("Authorized Tag!");
            beepSiren(1);
            DynamicJsonDocument doc(512);
            JsonArray updates = doc.createNestedArray("updates");
            JsonObject eventUpdate = updates.createNestedObject();
            eventUpdate["deviceId"] = "rfidEvent";
            eventUpdate["message"] = "Valid key card scanned";
            eventUpdate["type"] = "success";
            eventUpdate["lastActivity"] = timestamp;
            String payload;
            serializeJson(doc, payload);
            HTTPClient http;
            http.begin(String(API_BASE_URL) + API_SENSORS_ENDPOINT);
            http.addHeader("Content-Type", "application/json");
            int httpCode = http.POST(payload);
            if (httpCode == HTTP_CODE_OK || httpCode == HTTP_CODE_CREATED) {
                Serial.println("RFID event sent: " + payload);
            } else {
                Serial.println("Failed to send RFID event, HTTP code: " + String(httpCode));
            }
            http.end();

            if (currentAlarmStatus == "ACTIVE") {
                currentAlarmStatus = "INACTIVE";
                updateAlarmActuator();
                sendSensorData();
                Serial.println("Alarm DEACTIVATED by authorized RFID.");
            }
            if (currentArmedStatus == "ARMED") {
                currentArmedStatus = "DISARMED";
                Serial.println("System DISARMED by RFID.");
                lastUnlockTime = 0;
            } else {
                currentArmedStatus = "ARMED";
                Serial.println("System ARMED by RFID.");
            }
            updateArmedLed();
            sendSensorData();
            if (currentDistanceValue > 0 && currentDistanceValue < DISTANCE_UNLOCK_THRESHOLD) {
                currentLockStatus = "UNLOCKED";
                lastUnlockTime = millis();
                unlockDelayStart = millis();
                Serial.println("Door UNLOCKED: Authorized RFID and distance < 8 cm (starting 5-second delay).");
                sendSensorData();
            } else {
                Serial.println("Door NOT unlocked: Distance >= 8 cm.");
            }
        } else {
            Serial.println("Unauthorized Tag!");
            beepSiren(3);
            DynamicJsonDocument doc(512);
            JsonArray updates = doc.createNestedArray("updates");
            JsonObject eventUpdate = updates.createNestedObject();
            eventUpdate["deviceId"] = "rfidEvent";
            eventUpdate["message"] = "Invalid key card scanned";
            eventUpdate["type"] = "alert";
            eventUpdate["lastActivity"] = timestamp;
            String payload;
            serializeJson(doc, payload);
            HTTPClient http;
            http.begin(String(API_BASE_URL) + API_SENSORS_ENDPOINT);
            http.addHeader("Content-Type", "application/json");
            int httpCode = http.POST(payload);
            if (httpCode == HTTP_CODE_OK || httpCode == HTTP_CODE_CREATED) {
                Serial.println("RFID event sent: " + payload);
            } else {
                Serial.println("Failed to send RFID event, HTTP code: " + String(httpCode));
            }
            http.end();
        }

        rfid.PICC_HaltA();
        rfid.PCD_StopCrypto1();
    }
}

bool compareUIDs(byte* uid1, byte* uid2, int size) {
    for (int i = 0; i < size; i++) {
        if (uid1[i] != uid2[i]) {
            return false;
        }
    }
    return true;
}

void beepSiren(int count) {
    bool sirenWasActive = (currentAlarmStatus == "ACTIVE");
    for (int i = 0; i < count; i++) {
        digitalWrite(ALARM_SIREN_PIN, HIGH);
        delay(BEEP_DURATION);
        digitalWrite(ALARM_SIREN_PIN, LOW);
        if (i < count - 1) {
            delay(BEEP_DURATION);
        }
    }
    if (sirenWasActive) {
        digitalWrite(ALARM_SIREN_PIN, HIGH);
        Serial.println("Siren: Restored to ACTIVE");
    } else {
        digitalWrite(ALARM_SIREN_PIN, LOW);
        Serial.println("Siren: Restored to INACTIVE");
    }
}

void updateLockActuator() {
    if (currentLockStatus == "LOCKED") {
        lockServo.write(LOCKED_ANGLE);
        Serial.println("Servo: LOCKED");
        unlockDelayStart = 0;
    }
    delay(500);
}

void updateAlarmActuator() {
    if (currentAlarmStatus == "ACTIVE") {
        digitalWrite(ALARM_SIREN_PIN, HIGH);
        Serial.println("Siren: ACTIVE");
    } else {
        digitalWrite(ALARM_SIREN_PIN, LOW);
        Serial.println("Siren: INACTIVE");
    }
}

void updateArmedLed() {
    if (currentArmedStatus == "ARMED") {
        digitalWrite(ARMED_LED_PIN, HIGH);
    } else {
        digitalWrite(ARMED_LED_PIN, LOW);
    }
}
