const mongoose = require('mongoose');

const DeviceSchema = mongoose.Schema({
    deviceId: {
        type: String,
        required: true,
        unique: true
    },
    name: {
        type: String,
        required: true
    },
    type: {
        type: String,
        required: true,
        enum: ['motionSensor', 'contactSensor', 'smartLock', 'smartLight', 'siren', 'ultrasonicSensor', 'rfidReader']
    },
    status: { // For ON/OFF, Locked/Unlocked, Detected/Cleared, Armed/Disarmed
        type: String,
        default: 'UNKNOWN'
    },
    value: { // For sensor readings (e.g., distance, analog PIR sensitivity)
        type: Number,
        default: 0
    },
    lastActivity: {
        type: Date,
        default: Date.now
    },
    room: {
        type: String,
        default: 'General'
    },
    isArmed: { // Relevant for security devices
        type: Boolean,
        default: false
    },
    autoOnMotion: { // For lights automation
        type: Boolean,
        default: false
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Device', DeviceSchema);