const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose');
const mqtt = require('mqtt');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const connectDB = require('./config/db');
const Device = require('./models/Device');
const Log = require('./models/Log');
const Setting = require('./models/Settings');
const User = require('./models/User');
const Path = require('path');

dotenv.config();
connectDB();

const app = express();
app.use(cors());
app.use(express.json());

// --- JWT Middleware ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Access token required' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Invalid or expired token' });
        req.user = user;
        next();
    });
};

// --- MQTT Client Setup ---
const mqttOptions = {
    clientId: `mqttjs_${Math.random().toString(16).substr(2, 8)}`,
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
};

const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, mqttOptions);

mqttClient.on('connect', () => {
    console.log('Connected to MQTT Broker');
    const topics = [
        'home/lock/status',
        'home/sensor/motion',
        'home/sensor/distance',
        'home/security/alarm',
        'home/security/armed',
        'home/rfid/events',
        'home/light/status'
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

        switch (topic) {
            case 'home/lock/status':
                deviceId = 'smartLock001';
                status = payload;
                await Device.findOneAndUpdate(
                    { deviceId },
                    { status, isArmed: status === 'LOCKED', lastActivity: Date.now() },
                    { upsert: true, new: true }
                );
                logMessage = `Smart Lock status: ${status}`;
                break;

            case 'home/sensor/motion':
                deviceId = 'motionSensor001';
                status = payload;
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
                status = payload;
                await Device.findOneAndUpdate(
                    { deviceId },
                    { status, isArmed: status === 'ACTIVE', lastActivity: Date.now() },
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

            case 'home/light/status':
                deviceId = 'smartLight001';
                status = payload;
                await Device.findOneAndUpdate(
                    { deviceId },
                    { status, lastActivity: Date.now() },
                    { upsert: true, new: true }
                );
                logMessage = `Smart Light status: ${status}`;
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

// --- Authentication Routes ---
app.post('/api/auth/register', async (req, res) => {
    const { email, password, confirmPassword } = req.body;
    if (!email || !password || !confirmPassword) {
        return res.status(400).json({ message: 'All fields are required' });
    }
    if (password !== confirmPassword) {
        return res.status(400).json({ message: 'Passwords do not match' });
    }
    try {
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ message: 'Email already registered' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await User.create({ email, password: hashedPassword });
        res.status(201).json({ message: 'User registered successfully' });
    } catch (error) {
        console.error('Error registering user:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required' });
    }
    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }
        const token = jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.json({ token, message: 'Login successful' });
    } catch (error) {
        console.error('Error logging in:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('email');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json({ email: user.email, role: 'Owner' });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// --- Device Routes ---
app.get('/api/devices', authenticateToken, async (req, res) => {
    try {
        const devices = await Device.find();
        res.json(devices);
    } catch (error) {
        console.error('Error fetching devices:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

app.put('/api/devices/:deviceId', authenticateToken, async (req, res) => {
    const { deviceId } = req.params;
    const { name } = req.body;
    if (!name || name.trim() === '' || name.toLowerCase() === 'undefine' || name.toLowerCase() === 'undefined') {
        return res.status(400).json({ message: 'Invalid device name' });
    }
    try {
        const device = await Device.findOneAndUpdate(
            { deviceId },
            { name: name.trim() },
            { new: true }
        );
        if (!device) {
            return res.status(404).json({ message: 'Device not found' });
        }
        await Log.create({
            message: `Device ${deviceId} renamed to ${name}`,
            type: 'info',
            timestamp: new Date()
        });
        res.json(device);
    } catch (error) {
        console.error('Error renaming device:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/devices/:deviceId/toggle', authenticateToken, async (req, res) => {
    const { deviceId } = req.params;
    try {
        const device = await Device.findOne({ deviceId });
        if (!device) {
            return res.status(404).json({ message: 'Device not found' });
        }
        if (!device.type) {
            return res.status(400).json({ message: 'Device type is missing' });
        }

        let topic, payload, newStatus, newIsArmed;
        switch (device.type) {
            case 'smartLock':
                topic = 'home/lock/set';
                payload = device.status === 'LOCKED' ? 'UNLOCK' : 'LOCK';
                newStatus = payload === 'LOCK' ? 'LOCKED' : 'UNLOCKED';
                newIsArmed = payload === 'LOCK';
                break;
            case 'smartLight':
                topic = 'home/light/set';
                payload = device.status === 'ON' ? 'OFF' : 'ON';
                newStatus = payload;
                newIsArmed = false;
                break;
            case 'siren':
                topic = 'home/security/setAlarm';
                payload = device.status === 'ACTIVE' ? 'DEACTIVATE' : 'ACTIVATE';
                newStatus = payload === 'ACTIVATE' ? 'ACTIVE' : 'INACTIVE';
                newIsArmed = payload === 'ACTIVATE';
                break;
            default:
                return res.status(400).json({ message: 'Device type does not support toggling' });
        }

        if (mqttClient.connected) {
            mqttClient.publish(topic, payload, { qos: 1 }, async (err) => {
                if (err) {
                    console.error(`Failed to publish to ${topic}:`, err);
                    return res.status(500).json({ message: 'Failed to send command to MQTT' });
                }
                console.log(`Published command to ${topic}: ${payload}`);
                const updatedDevice = await Device.findOneAndUpdate(
                    { deviceId },
                    { status: newStatus, isArmed: newIsArmed, lastActivity: Date.now() },
                    { new: true }
                );
                await Log.create({
                    message: `Device ${deviceId} (${device.name}) toggled to ${newStatus}`,
                    type: 'info',
                    timestamp: new Date()
                });
                res.json(updatedDevice);
            });
        } else {
            console.error('MQTT client not connected');
            res.status(500).json({ message: 'MQTT client not connected' });
        }
    } catch (error) {
        console.error('Error toggling device:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// --- Other Protected Routes ---
app.post('/api/commands', authenticateToken, async (req, res) => {
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

app.post('/api/logs/clear', authenticateToken, async (req, res) => {
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

// --- Serve Static Files ---
app.get('/', (req, res) => {
    res.sendFile(Path.join(__dirname, 'public', 'login.html'));
});

app.use(express.static(Path.join(__dirname, 'public')));

// --- Start Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
    if (require('./controllers/settingsController').initializeDefaultSettings) {
        await require('./controllers/settingsController').initializeDefaultSettings();
    }
});