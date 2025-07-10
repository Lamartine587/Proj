const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose');
const mqtt = require('mqtt');
const connectDB = require('./config/db');
const Device = require('./models/Device');
const Log = require('./models/Log');
const Setting = require('./models/Settings');
const Path = require('path');

dotenv.config();
connectDB();

const app = express();
app.use(cors());
app.use(express.json());

// --- MQTT Client Setup ---
const mqttOptions = {
    clientId: `mqttjs_${Math.random().toString(16).substr(2, 8)}`,
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
};

const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, mqttOptions);

mqttClient.on('connect', () => {
    console.log('Connected to MQTT Broker');
    // Subscribe to ESP32-published topics
    const topics = [
        'home/lock/status',
        'home/sensor/motion',
        'home/sensor/distance',
        'home/security/alarm',
        'home/security/armed',
        'home/rfid/events' // New topic for RFID events
    ];
    topics.forEach(topic => {
        mqttClient.subscribe(topic, (err) => {
            if (!err) console.log(`Subscribed to ${topic}`);
            else console.error(`Failed to subscribe to ${topic}:`, err);
        });
    });
});

mqttClient.on('message', async (topic, message) => {
    const payload = message.toString();
    console.log(`MQTT Message - Topic: ${topic}, Payload: ${payload}`);

    try {
        let deviceId, status, value, logMessage, logType = 'info';

        // Update Device states and Log events based on MQTT messages
        switch (topic) {
            case 'home/lock/status':
                deviceId = 'smartLock001';
                status = payload; // "LOCKED" or "UNLOCKED"
                await Device.findOneAndUpdate(
                    { deviceId },
                    { status, lastActivity: Date.now() },
                    { upsert: true, new: true }
                );
                logMessage = `Smart Lock status: ${status}`;
                break;

            case 'home/sensor/motion':
                deviceId = 'motionSensor001';
                status = payload; // "DETECTED" or "CLEARED"
                await Device.findOneAndUpdate(
                    { deviceId },
                    { status, lastActivity: Date.now() },
                    { upsert: true, new: true }
                );
                logMessage = `Motion Sensor status: ${status}`;
                if (status === 'DETECTED') logType = 'warning';
                break;

            case 'home/sensor/distance':
                deviceId = 'ultrasonicSensor001';
                value = parseFloat(payload);
                await Device.findOneAndUpdate(
                    { deviceId },
                    { value, lastActivity: Date.now() },
                    { upsert: true, new: true }
                );
                logMessage = `Ultrasonic Sensor distance: ${value} cm`;
                if (value > 0 && value < 15) logType = 'warning';
                break;

            case 'home/security/alarm':
                deviceId = 'siren001';
                status = payload; // "ACTIVE" or "INACTIVE"
                await Device.findOneAndUpdate(
                    { deviceId },
                    { status, lastActivity: Date.now() },
                    { upsert: true, new: true }
                );
                logMessage = `Alarm status: ${status}`;
                if (status === 'ACTIVE') logType = 'danger';
                break;

            case 'home/security/armed':
                const armedStatus = payload === 'ARMED';
                await Setting.findOneAndUpdate(
                    { settingName: 'systemArmed' },
                    { value: armedStatus, lastActivity: Date.now() },
                    { upsert: true, new: true }
                );
                logMessage = `Security system is now: ${payload}`;
                logType = armedStatus ? 'success' : 'info';
                break;

            case 'home/rfid/events':
                logMessage = payload;
                logType = payload.includes('Authorized Tag') ? 'success' : 'alert';
                break;
        }

        if (logMessage) {
            await Log.create({ message: logMessage, type: logType, timestamp: new Date() });
        }

    } catch (error) {
        console.error('Error processing MQTT message:', error);
        await Log.create({
            message: `Backend error processing MQTT: ${error.message}`,
            type: 'danger',
            timestamp: new Date()
        });
    }
});

mqttClient.on('error', (err) => {
    console.error('MQTT Client Error:', err);
});

// --- API Routes ---
app.use('/api', require('./routes/api'));

// Command endpoint to handle frontend requests
app.post('/api/commands', async (req, res) => {
    const { command } = req.body;
    if (!command) {
        return res.status(400).json({ message: 'Command is required' });
    }

    try {
        let topic, payload;
        switch (command.toUpperCase()) {
            case 'ARM':
                topic = 'home/security/setArmed';
                payload = 'ARMED';
                break;
            case 'DISARM':
                topic = 'home/security/setArmed';
                payload = 'DISARMED';
                break;
            case 'LOCK':
                topic = 'home/lock/set';
                payload = 'LOCK';
                break;
            case 'UNLOCK':
                topic = 'home/lock/set';
                payload = 'UNLOCK';
                break;
            case 'ACTIVATE':
                topic = 'home/security/setAlarm';
                payload = 'ACTIVATE';
                break;
            case 'DEACTIVATE':
                topic = 'home/security/setAlarm';
                payload = 'DEACTIVATE';
                break;
            default:
                return res.status(400).json({ message: 'Invalid command' });
        }

        if (mqttClient.connected) {
            mqttClient.publish(topic, payload, { qos: 1 }, (err) => {
                if (err) {
                    console.error(`Failed to publish to ${topic}:`, err);
                    return res.status(500).json({ message: 'Failed to send command to MQTT' });
                }
                console.log(`Published command to ${topic}: ${payload}`);
                res.json({ message: `Command ${command} sent successfully` });
            });
        } else {
            console.error('MQTT client not connected');
            res.status(500).json({ message: 'MQTT client not connected' });
        }

    } catch (error) {
        console.error('Error processing command:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Clear logs endpoint
app.post('/api/logs/clear', async (req, res) => {
    try {
        await Log.deleteMany({});
        await Log.create({
            message: 'Activity logs cleared',
            type: 'info',
            timestamp: new Date()
        });
        res.json({ message: 'Logs cleared successfully' });
    } catch (error) {
        console.error('Error clearing logs:', error);
        res.status(500).json({ message: 'Failed to clear logs' });
    }
});

// Serve static files (frontend)
app.use(express.static(Path.join(__dirname, 'public')));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
    // Initialize default settings if needed (assuming initializeDefaultSettings exists)
    if (require('./controllers/settingsController').initializeDefaultSettings) {
        await require('./controllers/settingsController').initializeDefaultSettings();
    }
});
