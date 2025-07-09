const mongoose = require('mongoose');

const SettingsSchema = mongoose.Schema({
    settingName: {
        type: String,
        required: true,
        unique: true
    },
    value: {
        type: mongoose.Schema.Types.Mixed, // Can be number, string, boolean, object
        required: true
    },
    description: {
        type: String
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Setting', SettingsSchema);