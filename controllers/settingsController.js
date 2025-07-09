const Setting = require('../models/Settings');
const Log = require('../models/Log');

exports.getAllSettings = async (req, res) => {
    try {
        const settings = await Setting.find({});
        res.json(settings);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.getSetting = async (req, res) => {
    try {
        const setting = await Setting.findOne({ settingName: req.params.settingName });
        if (!setting) return res.status(404).json({ message: 'Setting not found' });
        res.json(setting);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.updateSetting = async (req, res) => {
    const { value, description } = req.body;
    try {
        const setting = await Setting.findOneAndUpdate(
            { settingName: req.params.settingName },
            { value, description },
            { new: true, upsert: true } // Creates if not exists
        );
        const logMessage = `Setting '${setting.settingName}' updated to: ${JSON.stringify(setting.value)}`;
        await Log.create({ message: logMessage, type: 'info' });

        res.json(setting);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
};

// Initial population of default settings if they don't exist
exports.initializeDefaultSettings = async () => {
    const defaultSettings = [
        { settingName: 'alarmDuration', value: 60, description: 'Duration of the alarm siren in seconds' },
        { settingName: 'armingDelay', value: 10, description: 'Delay before system fully arms in seconds' },
        { settingName: 'disarmingDelay', value: 5, description: 'Delay to enter disarm code before alarm triggers in seconds' },
        { settingName: 'pirSensitivity', value: 500, description: 'Sensitivity threshold for PIR motion sensors (0-1023)' },
        { settingName: 'systemArmed', value: false, description: 'Current armed state of the system' },
        { settingName: 'panicMode', value: false, description: 'Current panic mode state' },
        { settingName: 'motionAutomationEnabled', value: true, description: 'Enable/disable light automation based on motion' }
    ];

    for (const setting of defaultSettings) {
        await Setting.findOneAndUpdate(
            { settingName: setting.settingName },
            { $setOnInsert: { value: setting.value, description: setting.description } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
    }
    console.log('Default settings initialized/checked.');
};
