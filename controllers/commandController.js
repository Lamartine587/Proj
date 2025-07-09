const Log = require('../models/Log'); // Assuming you want to log commands

exports.sendCommand = async (req, res) => {
    const { command } = req.body;
    const mqttClient = req.mqttClient; // Access MQTT client from middleware

    if (!mqttClient || !mqttClient.connected) {
        console.error('MQTT client not connected, cannot send command.');
        return res.status(500).json({ message: 'MQTT client not connected.' });
    }

    const validCommands = ["LOCK", "UNLOCK", "ARM", "DISARM"];
    if (!validCommands.includes(command)) {
        return res.status(400).json({ message: 'Invalid command.' });
    }

    try {
        mqttClient.publish('home/commands', command, (err) => {
            if (err) {
                console.error('Failed to publish MQTT command:', err);
                Log.create({ message: `Failed to publish command ${command}: ${err.message}`, type: 'danger' });
                return res.status(500).json({ message: 'Failed to send command via MQTT.' });
            }
            console.log(`Command '${command}' published to MQTT.`);
            Log.create({ message: `Command '${command}' sent to ESP32.`, type: 'info' });
            res.status(200).json({ message: `Command '${command}' sent successfully.` });
        });
    } catch (error) {
        console.error('Error in sendCommand:', error);
        res.status(500).json({ message: 'Server error sending command.' });
    }
};
