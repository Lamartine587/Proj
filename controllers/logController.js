const Log = require('../models/Log');

exports.getLogs = async (req, res) => {
    try {
        const logs = await Log.find({}).sort({ timestamp: -1 }).limit(100); // Get latest 100 logs
        res.json(logs);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.clearLogs = async (req, res) => {
    try {
        await Log.deleteMany({});
        res.json({ message: 'Logs cleared' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};