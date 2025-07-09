const Device = require('../models/Device');
const Log = require('../models/Log');

// No direct MQTT publishing from here, as MQTT client is in server.js
// This controller handles API requests for device data.

exports.getAllDevices = async (req, res) => {
    try {
        const devices = await Device.find({});
        res.json(devices);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.getDeviceById = async (req, res) => {
    try {
        const device = await Device.findOne({ deviceId: req.params.deviceId });
        if (!device) return res.status(404).json({ message: 'Device not found' });
        res.json(device);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.createDevice = async (req, res) => {
    const { deviceId, name, type, room } = req.body;
    try {
        const newDevice = new Device({ deviceId, name, type, room });
        await newDevice.save();
        await Log.create({ message: `New device created: ${name} (${deviceId})`, type: 'info' });
        res.status(201).json(newDevice);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
};

// This update is primarily for MQTT messages. For API, it's a direct update.
exports.updateDeviceState = async (req, res) => {
    const { status, value } = req.body; // status could be "LOCKED", "UNLOCKED", "DETECTED", "CLEARED"
    try {
        const device = await Device.findOneAndUpdate(
            { deviceId: req.params.deviceId },
            { status, value, lastActivity: Date.now() },
            { new: true }
        );
        if (!device) return res.status(404).json({ message: 'Device not found' });

        const logMessage = `Device ${device.name} (${device.deviceId}) updated. Status: ${status}, Value: ${value !== undefined ? value : 'N/A'}`;
        await Log.create({ message: logMessage, type: 'info' });

        res.json(device);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
};

exports.deleteDevice = async (req, res) => {
    try {
        const device = await Device.findOneAndDelete({ deviceId: req.params.deviceId });
        if (!device) return res.status(404).json({ message: 'Device not found' });
        await Log.create({ message: `Device deleted: ${device.name} (${device.deviceId})`, type: 'warning' });
        res.json({ message: 'Device deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.updateDeviceAutomation = async (req, res) => {
    const { isArmed, autoOnMotion } = req.body;
    try {
        const device = await Device.findOneAndUpdate(
            { deviceId: req.params.deviceId },
            { isArmed, autoOnMotion },
            { new: true }
        );
        if (!device) return res.status(404).json({ message: 'Device not found' });

        const logMessage = `Automation settings for ${device.name} (${device.deviceId}) updated.`;
        await Log.create({ message: logMessage, type: 'info' });

        res.json(device);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
};
