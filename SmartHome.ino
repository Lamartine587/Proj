#include <WiFi.h>
#include <PubSubClient.h>
#include <NewPing.h>
#include <MFRC522.h>
#include <ESP32Servo.h>
#include <SPI.h>

// --- WiFi and MQTT Broker Credentials ---
#define WIFI_SSID "OPPO A58"
#define WIFI_PASSWORD "gyutcuu55"
#define MQTT_BROKER_IP "192.168.2.134"
#define MQTT_BROKER_PORT 1883
#define MQTT_USERNAME "your_mqtt_username"
#define MQTT_PASSWORD "your_mqtt_password"
#define MQTT_CLIENT_ID_PREFIX "esp32_smarthome_"

// --- Device IDs and MQTT Topics ---
#define SMART_LOCK_ID "smartLock001"
#define MOTION_SENSOR_ID "motionSensor001"
#define ULTRASONIC_SENSOR_ID "ultrasonicSensor001"
#define SIREN_ID "siren001"
#define SYSTEM_ARMED_SETTING "systemArmed"

#define TOPIC_LOCK_STATUS "home/lock/status"
#define TOPIC_MOTION_STATUS "home/sensor/motion"
#define TOPIC_DISTANCE_VALUE "home/sensor/distance"
#define TOPIC_ALARM_STATUS "home/security/alarm"
#define TOPIC_ARMED_STATUS "home/security/armed"
#define TOPIC_RFID_EVENTS "home/rfid/events" // New topic for RFID events

#define TOPIC_LOCK_SET "home/lock/set"
#define TOPIC_ARMED_SET "home/security/setArmed"
#define TOPIC_ALARM_SET "home/security/setAlarm"

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
WiFiClient espClient;
PubSubClient mqttClient(espClient);
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
unsigned long lastMQTTReconnectAttempt = 0;
unsigned long lastUnlockTime = 0;
unsigned long unlockDelayStart = 0; // New variable for unlock delay
unsigned long mqttReconnectInterval = 1000;

const long MOTION_READ_INTERVAL = 500;
const long DISTANCE_READ_INTERVAL = 1000;
const long PUBLISH_INTERVAL = 5000;
const long RFID_READ_INTERVAL = 500;
const long UNLOCK_DURATION = 5000;
const long UNLOCK_DELAY = 5000; // 5-second delay before unlocking
const long DEBOUNCE_DELAY = 50;
const long BEEP_DURATION = 100;

// Motion Sensor Debounce
int lastMotionState = LOW;
unsigned long lastDebounceTime = 0;

// Unique Client ID for MQTT
char mqttClientId[30];

// --- Function Prototypes ---
void setup_wifi();
void reconnectMqtt();
void mqttCallback(char* topic, byte* payload, unsigned int length);
void publishState(const char* topic, const String& payload);
void readMotionSensor();
void readUltrasonicSensor();
void readRFID();
bool compareUIDs(byte* uid1, byte* uid2, int size);
void updateLockActuator();
void updateAlarmActuator();
void updateArmedLed();
void beepSiren(int count);

// --- Setup Function ---
void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println("Booting ESP32 Smart Home Node...");

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
    snprintf(mqttClientId, sizeof(mqttClientId), "%s%02x%02x%02x", MQTT_CLIENT_ID_PREFIX, mac[3], mac[4], mac[5]);
    Serial.print("MQTT Client ID: ");
    Serial.println(mqttClientId);

    setup_wifi();
    mqttClient.setServer(MQTT_BROKER_IP, MQTT_BROKER_PORT);
    mqttClient.setCallback(mqttCallback);
    mqttClient.setBufferSize(2048);
    Serial.println("Setup Complete.");
}

// --- Loop Function ---
void loop() {
    unsigned long currentMillis = millis();

    if (!mqttClient.connected()) {
        if (currentMillis - lastMQTTReconnectAttempt >= mqttReconnectInterval) {
            reconnectMqtt();
            lastMQTTReconnectAttempt = currentMillis;
            mqttReconnectInterval = min(mqttReconnectInterval * 2, (unsigned long)60000);
        }
    } else {
        mqttClient.loop();
        mqttReconnectInterval = 1000;
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

    // Handle unlock delay
    if (currentLockStatus == "UNLOCKED" && unlockDelayStart > 0 && currentMillis - unlockDelayStart >= UNLOCK_DELAY) {
        lockServo.write(UNLOCKED_ANGLE);
        Serial.println("Servo: UNLOCKED (after 5-second delay)");
        unlockDelayStart = 0; // Reset delay timer
    }

    // Auto-lock after UNLOCK_DURATION
    if (currentLockStatus == "UNLOCKED" && lastUnlockTime > 0 && currentMillis - lastUnlockTime >= UNLOCK_DURATION) {
        currentLockStatus = "LOCKED";
        updateLockActuator();
        publishState(TOPIC_LOCK_STATUS, currentLockStatus);
        Serial.println("Door auto-locked after timeout.");
        lastUnlockTime = 0;
    }

    if (currentMillis - lastPublishTime >= PUBLISH_INTERVAL) {
        publishState(TOPIC_LOCK_STATUS, currentLockStatus);
        publishState(TOPIC_MOTION_STATUS, currentMotionStatus);
        publishState(TOPIC_DISTANCE_VALUE, String(currentDistanceValue));
        publishState(TOPIC_ALARM_STATUS, currentAlarmStatus);
        publishState(TOPIC_ARMED_STATUS, currentArmedStatus);
        lastPublishTime = currentMillis;
    }
}

// --- WiFi Connection ---
void setup_wifi() {
    delay(10);
    Serial.print("Connecting to WiFi: ");
    Serial.println(WIFI_SSID);

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    unsigned long connectStart = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - connectStart < 30000) {
        delay(500);
        Serial.print(".");
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\nWiFi connected");
        Serial.print("IP address: ");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println("\nWiFi connection FAILED! Please check credentials and try again.");
    }
}

// --- MQTT Reconnection ---
void reconnectMqtt() {
    Serial.print("Attempting MQTT connection...");
    if (mqttClient.connect(mqttClientId, MQTT_USERNAME, MQTT_PASSWORD)) {
        Serial.println("connected");
        mqttClient.subscribe(TOPIC_LOCK_SET);
        mqttClient.subscribe(TOPIC_ARMED_SET);
        mqttClient.subscribe(TOPIC_ALARM_SET);
    } else {
        Serial.print("failed, rc=");
        Serial.print(mqttClient.state());
        Serial.println(" Retrying...");
    }
}

// --- MQTT Message Callback ---
void mqttCallback(char* topic, byte* payload, unsigned int length) {
    Serial.print("Message arrived [");
    Serial.print(topic);
    Serial.print("] ");
    char messageChar[length + 1];
    strncpy(messageChar, (char*)payload, length);
    messageChar[length] = '\0';
    String message = String(messageChar);
    Serial.println(message);

    if (String(topic) == TOPIC_LOCK_SET) {
        if (message == "LOCK") {
            currentLockStatus = "LOCKED";
            unlockDelayStart = 0; // Cancel any ongoing unlock delay
            Serial.println("Command: LOCK DOOR (cancels unlock delay)");
            updateLockActuator();
            publishState(TOPIC_LOCK_STATUS, currentLockStatus);
        } else if (message == "UNLOCK") {
            currentLockStatus = "UNLOCKED";
            lastUnlockTime = millis();
            unlockDelayStart = millis(); // Start 5-second delay for servo
            Serial.println("Command: UNLOCK DOOR (starting 5-second delay)");
            publishState(TOPIC_LOCK_STATUS, currentLockStatus);
        }
    } else if (String(topic) == TOPIC_ARMED_SET) {
        if (message == "ARMED") {
            currentArmedStatus = "ARMED";
            Serial.println("Command: ARM SYSTEM");
        } else if (message == "DISARMED") {
            currentArmedStatus = "DISARMED";
            lastUnlockTime = 0;
            Serial.println("Command: DISARM SYSTEM");
        }
        updateArmedLed();
        publishState(TOPIC_ARMED_STATUS, currentArmedStatus);
    } else if (String(topic) == TOPIC_ALARM_SET) {
        if (message == "ACTIVATE") {
            currentAlarmStatus = "ACTIVE";
            Serial.println("Command: ACTIVATE ALARM");
        } else if (message == "DEACTIVATE") {
            currentAlarmStatus = "INACTIVE";
            Serial.println("Command: DEACTIVATE ALARM");
        }
        updateAlarmActuator();
        publishState(TOPIC_ALARM_STATUS, currentAlarmStatus);
    }
}

// --- Publish State to MQTT Broker ---
void publishState(const char* topic, const String& payload) {
    if (mqttClient.connected()) {
        if (mqttClient.publish(topic, payload.c_str())) {
            Serial.print("Published [");
            Serial.print(topic);
            Serial.print("]: ");
            Serial.println(payload);
        } else {
            Serial.print("Failed to publish [");
            Serial.print(topic);
            Serial.println("]");
        }
    } else {
        Serial.println("MQTT client not connected, cannot publish.");
    }
}

// --- Sensor Reading Functions ---
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
                    publishState(TOPIC_ALARM_STATUS, currentAlarmStatus);
                    Serial.println("Motion detected while armed! ALARM ACTIVE!");
                }
            } else {
                newMotionStatus = "CLEARED";
            }
            if (newMotionStatus != currentMotionStatus) {
                currentMotionStatus = newMotionStatus;
                Serial.print("Motion: ");
                Serial.println(currentMotionStatus);
                publishState(TOPIC_MOTION_STATUS, currentMotionStatus);
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
        char payloadBuffer[10];
        snprintf(payloadBuffer, sizeof(payloadBuffer), "%.1f", currentDistanceValue);
        publishState(TOPIC_DISTANCE_VALUE, String(payloadBuffer));
        if (currentArmedStatus == "ARMED" && currentAlarmStatus == "INACTIVE" && currentDistanceValue > 0 && currentDistanceValue < 10) {
            currentAlarmStatus = "ACTIVE";
            updateAlarmActuator();
            publishState(TOPIC_ALARM_STATUS, currentAlarmStatus);
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

        if (authorized) {
            Serial.println("Authorized Tag!");
            beepSiren(1);
            publishState(TOPIC_RFID_EVENTS, "Authorized Tag Scanned: " + uidStr);
            if (currentArmedStatus == "ARMED") {
                currentArmedStatus = "DISARMED";
                Serial.println("System DISARMED by RFID.");
                lastUnlockTime = 0;
            } else {
                currentArmedStatus = "ARMED";
                Serial.println("System ARMED by RFID.");
            }
            updateArmedLed();
            publishState(TOPIC_ARMED_STATUS, currentArmedStatus);
            if (currentMotionStatus == "DETECTED" && currentDistanceValue > 0 && currentDistanceValue < 50) {
                currentLockStatus = "UNLOCKED";
                lastUnlockTime = millis();
                unlockDelayStart = millis(); // Start 5-second delay for servo
                Serial.println("Door UNLOCKED: Authorized RFID, motion detected, and distance < 50 cm (starting 5-second delay).");
                publishState(TOPIC_LOCK_STATUS, currentLockStatus);
            } else {
                Serial.println("Door NOT unlocked: Conditions not met (motion or distance criteria).");
            }
        } else {
            Serial.println("Unauthorized Tag!");
            beepSiren(3);
            publishState(TOPIC_RFID_EVENTS, "Unauthorized Tag Detected");
        }

        rfid.PICC_HaltA();
        rfid.PCD_StopCrypto1();
    }
}

// --- Helper function to compare two UIDs ---
bool compareUIDs(byte* uid1, byte* uid2, int size) {
    for (int i = 0; i < size; i++) {
        if (uid1[i] != uid2[i]) {
            return false;
        }
    }
    return true;
}

// --- Helper function to beep siren ---
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

// --- Actuator Control Functions ---
void updateLockActuator() {
    if (currentLockStatus == "LOCKED") {
        lockServo.write(LOCKED_ANGLE);
        Serial.println("Servo: LOCKED");
        unlockDelayStart = 0; // Cancel any ongoing unlock delay
    }
    // Servo movement to UNLOCKED is handled in loop() after delay
    delay(500); // Short delay to ensure smooth servo movement
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