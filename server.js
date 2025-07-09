require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const mqtt = require('mqtt');
const path = require('path');

// Database and Route Imports
const connectDB = require('./config/db');
const apiRoutes = require('./routes/api');
const { initializeDefaultSettings } = require('./controllers/settingsController');
const Device = require('./models/Device');
const Log = require('./models/Log');
const Setting = require('./models/Settings');

// Initialize Express App
const app = express();

// Connect to MongoDB
connectDB();

// Middleware
app.use(cors());
app.use(express.json());

// MQTT Configuration
const mqttOptions = {
  clientId: `mqttjs_${Math.random().toString(16).substr(2, 8)}`,
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  reconnectPeriod: 1000 // Reconnect every 1 second if connection is lost
};

const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, mqttOptions);

// MQTT Event Handlers
mqttClient.on('connect', () => {
  console.log('✅ Connected to MQTT Broker');
  
  const topics = [
    'home/lock/status',
    'home/sensor/motion',
    'home/sensor/distance',
    'home/security/alarm',
    'home/security/armed'
  ];

  topics.forEach(topic => {
    mqttClient.subscribe(topic, (err) => {
      if (err) {
        console.error(`❌ Failed to subscribe to ${topic}:`, err);
      } else {
        console.log(`🔔 Subscribed to ${topic}`);
      }
    });
  });
});

mqttClient.on('message', async (topic, message) => {
  const payload = message.toString();
  console.log(`📨 MQTT Message - ${topic}: ${payload}`);

  try {
    let deviceId, status, value, logMessage, logType = 'info';

    switch (topic) {
      case 'home/lock/status':
        deviceId = 'smartLock001';
        status = payload;
        logMessage = `Smart Lock status: ${status}`;
        break;
      
      case 'home/sensor/motion':
        deviceId = 'motionSensor001';
        status = payload;
        logMessage = `Motion ${status === "DETECTED" ? "detected" : "cleared"}`;
        logType = status === "DETECTED" ? 'warning' : 'info';
        break;
      
      case 'home/sensor/distance':
        deviceId = 'ultrasonicSensor001';
        value = parseFloat(payload);
        logMessage = `Distance: ${value} cm`;
        break;
      
      case 'home/security/alarm':
        deviceId = 'siren001';
        status = payload;
        logMessage = `Alarm ${status === "ACTIVE" ? "triggered" : "deactivated"}`;
        logType = status === "ACTIVE" ? 'danger' : 'info';
        break;
      
      case 'home/security/armed':
        const armedStatus = (payload === "ARMED");
        await Setting.findOneAndUpdate(
          { settingName: 'systemArmed' },
          { value: armedStatus },
          { upsert: true, new: true }
        );
        logMessage = `Security system ${armedStatus ? "armed" : "disarmed"}`;
        logType = armedStatus ? 'success' : 'info';
        break;
    }

    if (deviceId) {
      await Device.findOneAndUpdate(
        { deviceId },
        { status, value, lastActivity: Date.now() },
        { upsert: true, new: true }
      );
    }

    if (logMessage) {
      await Log.create({ 
        message: logMessage, 
        type: logType,
        source: 'mqtt',
        topic
      });
    }

  } catch (error) {
    console.error('❌ Error processing MQTT message:', error);
    await Log.create({ 
      message: `Error processing MQTT: ${error.message}`,
      type: 'danger',
      source: 'system'
    });
  }
});

mqttClient.on('error', (err) => {
  console.error('❌ MQTT Error:', err);
  Log.create({
    message: `MQTT connection error: ${err.message}`,
    type: 'danger',
    source: 'system'
  });
});

// Make MQTT client available to routes
app.use((req, res, next) => {
  req.mqttClient = mqttClient;
  next();
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api', apiRoutes);

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    mqtt: mqttClient.connected ? 'connected' : 'disconnected',
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Catch-all route for SPA (must be last)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error('❌ Server Error:', err.stack);
  res.status(500).json({ 
    error: 'Internal Server Error',
    message: err.message 
  });
});

// Server Startup
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  try {
    await initializeDefaultSettings();
    console.log('⚙️  Default settings initialized');
  } catch (err) {
    console.error('❌ Failed to initialize settings:', err);
  }
});

// Graceful Shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    mqttClient.end();
    mongoose.connection.close(false, () => {
      console.log('🔴 Server stopped');
      process.exit(0);
    });
  });
});