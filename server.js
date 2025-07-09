const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose'); // Ensure mongoose is imported
const mqtt = require('mqtt'); // MQTT client library
const connectDB = require('./config/db');
const apiRoutes = require('./routes/api');
const { initializeDefaultSettings } = require('./controllers/settingsController');
const Device = require('./models/Device'); // Import Device model to update states
const Log = require('./models/Log'); // Import Log model to record events
const Setting = require('./models/Settings'); // Import Setting model to update armed status

dotenv.config();

connectDB();

const app = express();
app.use(cors());
app.use(express.json());

// --- MQTT Client Setup ---
const mqttOptions = {
    clientId: `mqttjs_${Math.random().toString(16).substr(2, 8)}`, // Unique client ID
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
};

const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, mqttOptions);

mqttClient.on('connect', () => {
    console.log('Connected to MQTT Broker 🎉');
    // Subscribe to topics where ESP32 publishes data
    mqttClient.subscribe('home/lock/status', (err) => {
        if (!err) console.log('Subscribed to home/lock/status');
    });
    mqttClient.subscribe('home/sensor/motion', (err) => {
        if (!err) console.log('Subscribed to home/sensor/motion');
    });
    mqttClient.subscribe('home/sensor/distance', (err) => {
        if (!err) console.log('Subscribed to home/sensor/distance');
    });
    mqttClient.subscribe('home/security/alarm', (err) => {
        if (!err) console.log('Subscribed to home/security/alarm');
    });
    mqttClient.subscribe('home/security/armed', (err) => {
        if (!err) console.log('Subscribed to home/security/armed');
    });
});

mqttClient.on('message', async (topic, message) => {
    const payload = message.toString();
    console.log(`MQTT Message - Topic: ${topic}, Payload: ${payload}`);

    try {
        let deviceId;
        let status;
        let value;
        let logMessage;
        let logType = 'info';

        // Update Device states and Log events based on MQTT messages
        if (topic === 'home/lock/status') {
            deviceId = 'smartLock001'; // Assuming a fixed ID for your smart lock
            status = payload; // "LOCKED" or "UNLOCKED"
            await Device.findOneAndUpdate({ deviceId }, { status, lastActivity: Date.now() }, { upsert: true, new: true });
            logMessage = `Smart Lock status: ${status}`;
        } else if (topic === 'home/sensor/motion') {
            deviceId = 'motionSensor001'; // Assuming a fixed ID for your motion sensor
            status = payload; // "DETECTED" or "CLEARED"
            await Device.findOneAndUpdate({ deviceId }, { status, lastActivity: Date.now() }, { upsert: true, new: true });
            logMessage = `Motion Sensor status: ${status}`;
            if (status === "DETECTED") logType = 'warning';
        } else if (topic === 'home/sensor/distance') {
            deviceId = 'ultrasonicSensor001'; // Assuming a fixed ID for your ultrasonic sensor
            value = parseFloat(payload);
            // You might want to set a status like "NEAR" or "FAR" based on distance here
            await Device.findOneAndUpdate({ deviceId }, { value, lastActivity: Date.now() }, { upsert: true, new: true });
            logMessage = `Ultrasonic Sensor distance: ${value} cm`;
        } else if (topic === 'home/security/alarm') {
            deviceId = 'siren001'; // Assuming a fixed ID for your siren/alarm
            status = payload; // "ACTIVE" or "INACTIVE"
            await Device.findOneAndUpdate({ deviceId }, { status, lastActivity: Date.now() }, { upsert: true, new: true });
            logMessage = `Alarm status: ${status}`;
            if (status === "ACTIVE") logType = 'danger';
        } else if (topic === 'home/security/armed') {
            const armedStatus = (payload === "ARMED");
            await Setting.findOneAndUpdate({ settingName: 'systemArmed' }, { value: armedStatus }, { upsert: true, new: true });
            logMessage = `Security system is now: ${payload}`;
            logType = armedStatus ? 'success' : 'info';
        }

        if (logMessage) {
            await Log.create({ message: logMessage, type: logType });
        }

    } catch (error) {
        console.error('Error processing MQTT message or updating MongoDB:', error);
        await Log.create({ message: `Backend error processing MQTT: ${error.message}`, type: 'danger' });
    }
});

mqttClient.on('error', (err) => {
    console.error('MQTT Client Error:', err);
});

// Middleware to make mqttClient available to routes/controllers
app.use((req, res, next) => {
    req.mqttClient = mqttClient;
    next();
});

// Define API routes
app.use('/api', apiRoutes);

// Root route for testing
app.get('/', (req, res) => {
    res.send('Smart Home Backend API is running!');
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
    await initializeDefaultSettings(); // Initialize default settings on server start
});