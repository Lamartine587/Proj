// server.js
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const mongoose = require('mongoose');
const mqtt = require('mqtt');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const rateLimit = require('express-rate-limit');

dotenv.config();

const app = express();

app.set('trust proxy', 1);

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch((err) => console.error('MongoDB connection error:', err));

const DeviceSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    type: { type: String, required: true },
    room: { type: String, required: true },
    status: { type: String, default: 'IDLE' },
    value: Number,
    isArmed: Boolean,
    lastActivity: Date
});
const LogSchema = new mongoose.Schema({
    message: String,
    timestamp: { type: Date, default: Date.now },
    type: { type: String, default: 'info' }
});
const SettingSchema = new mongoose.Schema({
    settingName: { type: String, required: true, unique: true },
    value: mongoose.Mixed
});
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    name: { type: String, required: true }
});

const Device = mongoose.model('Device', DeviceSchema);
const Log = mongoose.model('Log', LogSchema);
const Setting = mongoose.model('Setting', SettingSchema);
const User = mongoose.model('User', UserSchema);

// --- FIXED CORS CONFIGURATION ---
const allowedOrigins = [
    'http://localhost:3000', // For local backend development
    'http://localhost:5500', // Common for Live Server in VS Code
    'https://proj-five-opal.vercel.app', // Your Vercel frontend URL
    process.env.FRONTEND_URL, // Environment variable for Vercel URL on Render
    process.env.RENDER_EXTERNAL_URL // Your Render backend's own URL (often useful for direct access or same-origin requests)
].filter(Boolean); // Filter out any undefined/null values if env vars are missing

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}.`;
            console.warn(msg); // Log for debugging on the server side
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Explicitly list allowed methods
    credentials: true, // If you plan to send cookies/auth headers with your requests
    optionsSuccessStatus: 204 // Some legacy browsers (IE11, various SmartTVs) choke on 200
}));
// --- END FIXED CORS CONFIGURATION ---

app.use(express.json()); // This line must be AFTER cors middleware

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: { message: 'Too many requests, please try again later' }
});
app.use('/api/auth/login', limiter);
app.use('/api/auth/register', limiter);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/devices.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'devices.html'));
});
app.get('/analytics.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'analytics.html'));
});
app.get('/settings.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});
app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/register.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

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

const mqttBrokerUrl = process.env.MQTT_BROKER_URL;
if (!mqttBrokerUrl) {
    console.error('MQTT_BROKER_URL environment variable is not set. MQTT client will not connect.');
} else {
    console.log('Attempting to connect to MQTT Broker:', mqttBrokerUrl);
    const mqttOptions = {
        clientId: `mqttjs_${Math.random().toString(16).slice(2, 8)}`,
        username: process.env.MQTT_USERNAME,
        password: process.env.MQTT_PASSWORD,
        connectTimeout: 5000,
        keepalive: 60,
        reconnectPeriod: 1000
    };

    const mqttClient = mqtt.connect(mqttBrokerUrl, mqttOptions);

    mqttClient.on('connect', () => {
        console.log(`Connected to MQTT Broker at ${mqttBrokerUrl}`);
        const topics = [
            'home/lock/status',
            'home/sensor/motion',
            'home/sensor/distance',
            'home/security/alarm',
            'home/security/armed',
            'home/rfid/events'
        ];
        topics.forEach(topic => {
            mqttClient.subscribe(topic, { qos: 1 }, (err) => {
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
                    if (status === 'UNLOCKED') {
                        const ultrasonic = await Device.findOne({ deviceId: 'ultrasonicSensor001' });
                        if (ultrasonic && ultrasonic.value > 0 && ultrasonic.value < 8) {
                            logMessage = 'Door unlocked by RFID at close distance';
                            logType = 'success';
                        }
                    }
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
                        { status, lastActivity: Date.now() },
                        { upsert: true, new: true }
                    );
                    logMessage = `Alarm status: ${status}`;
                    if (status === 'ACTIVE') logType = 'danger';
                    break;

                case 'home/security/armed':
                    await Setting.findOneAndUpdate(
                        { settingName: 'systemArmed' },
                        { value: payload === 'ARMED', lastActivity: Date.now() },
                        { upsert: true, new: true }
                    );
                    logMessage = `Security system is now: ${payload}`;
                    if (payload === 'ARMED') logType = 'success';
                    break;

                case 'home/rfid/events':
                    logMessage = payload.includes('Authorized Tag') ? 'Valid key card scanned' : 'Invalid key card scanned';
                    logType = payload.includes('Authorized Tag') ? 'success' : 'alert';
                    break;
            }

            if (logMessage) {
                await Log.create({ message: logMessage, type: logType });
            }
        } catch (error) {
            console.error(`Error processing MQTT message for topic ${topic}:`, error);
        }
    });

    mqttClient.on('error', (err) => {
        console.error('MQTT Client Error:', err);
    });

    mqttClient.on('close', () => {
        console.log('MQTT connection closed. Attempting to reconnect...');
    });
}

// --- FIXED /api/config endpoint ---
app.get('/api/config', (req, res) => {
    let backendUrl;
    if (process.env.NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_HOSTNAME) {
        backendUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
    } else {
        backendUrl = `http://${req.headers.host || '127.0.0.1:3000'}`;
    }

    // Use MQTT_BROKER_CLIENT_URL if available, otherwise fallback to MQTT_BROKER_URL
    const mqttBroker = process.env.MQTT_BROKER_CLIENT_URL || process.env.MQTT_BROKER_URL;

    res.json({
        backendUrl: backendUrl, // Changed key from backendHost to backendUrl
        mqttBroker: mqttBroker // Changed key from mqttBrokerClientUrl to mqttBroker
    });
});
// --- END FIXED /api/config endpoint ---

app.post('/api/auth/register', limiter, async (req, res) => {
    const { email, password, name } = req.body;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ message: 'Invalid email format' });
    if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' });
    if (!name.trim()) return res.status(400).json({ message: 'Name is required' });

    try {
        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ message: 'User already exists' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const user = await User.create({ email, password: hashedPassword, name });
        const token = jwt.sign({ email: user.email, name: user.name }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.status(201).json({ token, user: { email, name } });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/auth/login', limiter, async (req, res) => {
    const { email, password } = req.body;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ message: 'Invalid email format' });

    try {
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ message: 'Invalid credentials' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

        const token = jwt.sign({ email: user.email, name: user.name }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.json({ token, user: { email: user.email, name: user.name } });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const user = await User.findOne({ email: req.user.email }).select('-password');
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json({ email: user.email, name: user.name });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/devices', authenticateToken, async (req, res) => {
    try {
        const devices = await Device.find();
        res.json(devices);
    } catch (error) {
        console.error('Error fetching devices:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/devices', authenticateToken, async (req, res) => {
    const { deviceId, name, type, room, status } = req.body;
    if (!deviceId || !name || !type || !room) {
        return res.status(400).json({ message: 'deviceId, name, type, and room are required' });
    }

    try {
        const existingDevice = await Device.findOne({ deviceId });
        if (existingDevice) {
            return res.status(400).json({ message: `Device with deviceId ${deviceId} already exists` });
        }

        const device = await Device.create({
            deviceId,
            name,
            type,
            room,
            status: status || 'IDLE',
            lastActivity: Date.now()
        });
        console.log(`Created device: ${deviceId}`);
        await Log.create({ message: `Device added: ${name} (${deviceId})`, type: 'info' });
        res.status(201).json(device);
    } catch (error) {
        console.error('Error creating device:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/logs', authenticateToken, async (req, res) => {
    try {
        const logs = await Log.find().sort({ timestamp: -1 }).limit(50);
        res.json(logs);
    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/logs/clear', authenticateToken, async (req, res) => {
    try {
        await Log.deleteMany({});
        res.json({ message: 'Logs cleared' });
    } catch (error) {
        console.error('Error clearing logs:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

app.get('/api/settings', authenticateToken, async (req, res) => {
    try {
        const settings = await Setting.find();
        res.json(settings);
    } catch (error) {
        console.error('Error fetching settings:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/commands', authenticateToken, async (req, res) => {
    const { command } = req.body;
    const validCommands = ['ARM', 'DISARM', 'LOCK', 'UNLOCK'];
    if (!validCommands.includes(command)) {
        return res.status(400).json({ message: 'Invalid command' });
    }

    try {
        if (!mqttClient || !mqttClient.connected) {
            console.warn('MQTT client not connected, cannot send command.');
            return res.status(503).json({ message: 'MQTT service unavailable' });
        }
        const topic = command === 'ARM' || command === 'DISARM' ? 'home/security/armed' : 'home/lock/status';
        const payload = command === 'ARM' ? 'ARMED' : command === 'DISARM' ? 'DISARMED' : command;
        mqttClient.publish(topic, payload, { qos: 1 }, (err) => {
            if (err) {
                console.error(`Error publishing to ${topic}:`, err);
                return res.status(500).json({ message: 'Failed to send command' });
            }
            console.log(`Published command ${command} to ${topic}`);
            res.json({ message: `Command ${command} sent` });
        });
    } catch (error) {
        console.error('Error sending command:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT} in ${process.env.NODE_ENV} mode`);
    if (process.env.NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_HOSTNAME) {
        console.log(`Production URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME}`);
    } else {
        console.log(`Local Access: http://localhost:${PORT}`);
        console.log(`Local Network Access: http://${getPublicIp()}:${PORT}`);
    }
});

function getPublicIp() {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return 'UNKNOWN_IP';
}