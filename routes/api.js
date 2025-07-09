const express = require('express');
const router = express.Router();
const deviceController = require('../controllers/deviceController');
const logController = require('../controllers/logController');
const settingsController = require('../controllers/settingsController');
const commandController = require('../controllers/commandController');

// Device Routes
router.get('/devices', deviceController.getAllDevices);
router.get('/devices/:deviceId', deviceController.getDeviceById);
router.post('/devices', deviceController.createDevice);
router.put('/devices/:deviceId/state', deviceController.updateDeviceState);
router.put('/devices/:deviceId/automation', deviceController.updateDeviceAutomation);
router.delete('/devices/:deviceId', deviceController.deleteDevice);

// Log Routes
router.get('/logs', logController.getLogs);
router.delete('/logs', logController.clearLogs);

// Settings Routes
router.get('/settings', settingsController.getAllSettings);
router.get('/settings/:settingName', settingsController.getSetting);
router.put('/settings/:settingName', settingsController.updateSetting);

// Command Route (for sending commands to ESP32 via MQTT)
router.post('/commands', commandController.sendCommand);

module.exports = router;
