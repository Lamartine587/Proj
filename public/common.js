let BACKEND_URL, MQTT_BROKER;
const MQTT_OPTIONS = {
    // 🔒 CHANGE THESE: Use your actual HiveMQ Cloud username and password here.
    // These are the credentials you created in HiveMQ Cloud's Access Management.
    username: 'hemsworth', // Make sure this matches your HiveMQ username EXACTLY.
    password: '132400La@', // Make sure this matches your HiveMQ password EXACTLY.
    clientId: 'webClient_' + Math.random().toString(16).slice(3)
};
const MQTT_TOPICS = [
    'home/lock/status',
    'home/sensor/motion',
    'home/sensor/distance',
    'home/security/alarm',
    'home/security/armed',
    'home/rfid/events'
];
const POLL_INTERVAL = 2000;
const DISTANCE_WARNING_THRESHOLD = 30;
const DISTANCE_DANGER_THRESHOLD = 15;
const DISTANCE_UNLOCK_THRESHOLD = 8;

// 🌐 This is already correctly pointing to your deployed Render backend. No change needed here.
const CONFIG_URL = 'https://smarthome-lfyp.onrender.com/api/config';

// NEW: Speech synthesis setup
const synth = window.speechSynthesis;
let currentUtterance = null; // To keep track of the current speech utterance

/**
 * Speaks the given text aloud using the Web Speech API.
 * Interrupts any ongoing speech.
 * @param {string} text The text to speak.
 * @param {number} [rate=1.0] Speech rate (0.1 to 10.0).
 * @param {number} [pitch=1.0] Speech pitch (0.0 to 2.0).
 */
function speak(text, rate = 1.0, pitch = 1.0) {
    if (!synth) {
        console.warn('SpeechSynthesis not supported in this browser.');
        return;
    }

    // Stop any ongoing speech to prevent overlapping
    if (currentUtterance && synth.speaking) {
        synth.cancel();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate; // Speed of speech
    utterance.pitch = pitch; // Tone of speech
    // Optional: Set a voice if specific language/voice is preferred.
    // Example: utterance.voice = synth.getVoices().find(voice => voice.lang === 'en-US' && voice.name === 'Google US English');

    utterance.onend = () => {
        currentUtterance = null; // Clear reference when speech ends
    };
    utterance.onerror = (event) => {
        console.error('SpeechSynthesisUtterance.onerror', event);
        currentUtterance = null;
    };

    synth.speak(utterance);
    currentUtterance = utterance; // Store reference to the current utterance
}

async function fetchConfig() {
    try {
        const response = await fetch(CONFIG_URL, { timeout: 5000 });
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        
        const config = await response.json();
        console.log('Received config from API:', config); // Log what you actually get

        // --- FIXED LOGIC FOR CONFIG PARSING ---
        // Your backend /api/config returns { backendHost: "...", mqttBrokerClientUrl: "..." }
        if (config.backendHost && config.mqttBrokerClientUrl) {
            BACKEND_URL = `https://${config.backendHost}`; // Construct full URL with HTTPS
            MQTT_BROKER = config.mqttBrokerClientUrl; // Use directly
        } else {
            // This error will now only be thrown if the expected keys are truly missing
            throw new Error('Invalid config format received from API: Missing backendHost or mqttBrokerClientUrl');
        }
        // --- END FIXED LOGIC ---

        console.log(`Fetched config: BACKEND_URL=${BACKEND_URL}, MQTT_BROKER=${MQTT_BROKER}`);
    } catch (error) {
        console.error('Error fetching config:', error.message);
        showToast('Failed to load server configuration. Using default deployed URLs.', 'error');
        // 🚨 FALLBACK: These are already correctly set to your deployed Render backend and HiveMQ Cloud.
        BACKEND_URL = 'https://smarthome-lfyp.onrender.com';
        MQTT_BROKER = 'mqtts://e6973762221648ee81e22bdb68c9a524.s1.eu.hivemq.cloud:8883';
    }
}

function connectMqtt(callback) {
    // Ensure MQTT_OPTIONS are used when connecting
    const mqttClient = mqtt.connect(MQTT_BROKER, MQTT_OPTIONS);
    mqttClient.on('connect', () => {
        console.log('Connected to MQTT broker');
        MQTT_TOPICS.forEach(topic => {
            mqttClient.subscribe(topic, { qos: 1 }, (err) => {
                if (err) {
                    console.error(`Error subscribing to ${topic}:`, err);
                    showToast(`Failed to subscribe to ${topic}`, 'error');
                } else {
                    console.log(`Subscribed to ${topic}`);
                }
            });
        });
        if (callback) callback(mqttClient);
    });
    mqttClient.on('message', (topic, message) => {
        const payload = message.toString();
        console.log(`MQTT message on ${topic}: ${payload}`);
        handleMqttMessage(topic, payload);
    });
    mqttClient.on('error', (err) => {
        console.error('MQTT error:', err);
        showToast('MQTT connection failed. Retrying...', 'error');
        // No explicit setTimeout for reconnect here, mqtt.js client has built-in reconnect logic
        // This 'error' event often leads to 'close' then auto-reconnect
    });
    mqttClient.on('close', () => {
        console.log('MQTT connection closed. Attempting to reconnect...');
        showToast('MQTT connection lost. Reconnecting...', 'error');
        // The mqtt.js client usually handles auto-reconnect on 'close' events
    });
    return mqttClient;
}

function handleMqttMessage(topic, message) {
    const systemStatus = window.systemStatus || { armed: false, lock: 'LOCKED', motion: 'CLEARED', distance: 0, alarm: 'INACTIVE' };
    let logMessageText = '';

    switch (topic) {
        case 'home/lock/status':
            systemStatus.lock = message;
            updateStatusElement('lockStatus', message === 'LOCKED' ? 'Locked' : 'Unlocked', message === 'LOCKED' ? 'status-locked' : 'status-unlocked');
            logMessageText = message === 'UNLOCKED' && systemStatus.distance > 0 && systemStatus.distance < DISTANCE_UNLOCK_THRESHOLD ?
                    'Door unlocked by RFID at close distance' : mapLogMessage(topic, message);
            addLogEntry({
                message: logMessageText,
                timestamp: Date.now(),
                type: message === 'UNLOCKED' && systemStatus.distance > 0 && systemStatus.distance < DISTANCE_UNLOCK_THRESHOLD ? 'success' : 'info'
            });
            break;
        case 'home/sensor/motion':
            systemStatus.motion = message;
            updateStatusElement('motionStatus', message === 'DETECTED' ? 'Motion Detected' : 'No Motion', message === 'DETECTED' ? 'status-detected' : 'status-cleared');
            logMessageText = mapLogMessage(topic, message);
            addLogEntry({ message: logMessageText, timestamp: Date.now(), type: getLogType(topic, message) });
            break;
        case 'home/sensor/distance':
            systemStatus.distance = parseFloat(message) || 0;
            updateDistanceIndicator(systemStatus.distance);
            logMessageText = mapLogMessage(topic, message);
            addLogEntry({ message: logMessageText, timestamp: Date.now(), type: getLogType(topic, message) });
            break;
        case 'home/security/alarm':
            systemStatus.alarm = message;
            updateStatusElement('alarmStatus', message === 'ACTIVE' ? 'On' : 'Off', message === 'ACTIVE' ? 'status-active' : 'status-inactive');
            logMessageText = mapLogMessage(topic, message);
            addLogEntry({ message: logMessageText, timestamp: Date.now(), type: getLogType(topic, message) });
            break;
        case 'home/security/armed':
            systemStatus.armed = message === 'ARMED';
            updateStatusElement('armedStatus', systemStatus.armed ? 'On' : 'Off', systemStatus.armed ? 'status-armed' : 'status-disarmed');
            logMessageText = mapLogMessage(topic, message);
            addLogEntry({ message: logMessageText, timestamp: Date.now(), type: getLogType(topic, message) });
            break;
        case 'home/rfid/events':
            logMessageText = mapLogMessage(topic, message);
            addLogEntry({ message: logMessageText, timestamp: Date.now(), type: getLogType(topic, message) });
            break;
    }
    window.systemStatus = systemStatus;

    if (logMessageText === 'Valid key card scanned') {
        playBeep(1);
        showToast('Valid key card scanned!', 'success');
        speak('Valid key card scanned!');
        if (typeof incrementNotificationCount === 'function') incrementNotificationCount();
    } else if (logMessageText === 'Invalid key card scanned') {
        playBeep(3);
        showToast('Invalid key card detected!', 'error');
        speak('Invalid key card detected!');
        if (typeof incrementNotificationCount === 'function') incrementNotificationCount();
    } else if (logMessageText === 'Alarm turned off') {
        playBeep(2);
        showToast('Alarm turned off!', 'success');
        speak('Alarm turned off.');
        if (typeof incrementNotificationCount === 'function') incrementNotificationCount();
    } else if (logMessageText === 'Alarm turned on') {
        playBeep(5);
        showToast('Alarm triggered!', 'error', true);
        speak('Warning! Alarm triggered!');
        if (typeof incrementNotificationCount === 'function') incrementNotificationCount();
    } else if (logMessageText === 'Security system turned on') {
        playBeep(2);
        showToast('Security system turned on!', 'success');
        speak('Security system turned on.');
    } else if (logMessageText === 'Security system turned off') {
        playBeep(2);
        showToast('Security system turned off!', 'success');
        speak('Security system turned off.');
    } else if (logMessageText === 'Door unlocked by RFID at close distance') {
        playBeep(2);
        showToast('Door unlocked by RFID at close distance!', 'success');
        speak('Door unlocked by key card at close distance.');
        if (typeof incrementNotificationCount === 'function') incrementNotificationCount();
    } else if (logMessageText === 'Motion detected') {
        playBeep(1);
        showToast('Motion detected!', 'warning');
        speak('Motion detected.');
        if (typeof incrementNotificationCount === 'function') incrementNotificationCount();
    }
}

function updateStatusElement(elementId, text, className) {
    const el = document.getElementById(elementId);
    if (el) {
        el.textContent = text;
        el.className = `status-badge ${className}`;
        el.setAttribute('aria-label', `${elementId.replace('Status', '')} status: ${text}`);
    }
}

function updateDistanceIndicator(distance) {
    const valueEl = document.getElementById('distanceValue');
    const markerEl = document.getElementById('distanceMarker');
    const statusEl = document.getElementById('distanceStatus');
    const distanceIndicatorEl = document.querySelector('.distance-indicator');

    if (valueEl) valueEl.textContent = distance.toFixed(0);
    if (markerEl) {
        const displayDistance = Math.min(distance, 100);
        const markerPosition = (displayDistance / 100) * 100;
        markerEl.style.left = `${markerPosition}%`;
    }
    if (statusEl) {
        let statusText = 'Safe';
        let statusClass = 'status-inactive';

        if (distance <= DISTANCE_DANGER_THRESHOLD && distance > 0) {
            statusText = 'Too Close';
            statusClass = 'status-active';
        } else if (distance <= DISTANCE_WARNING_THRESHOLD && distance > 0) {
            statusText = 'Close';
            statusClass = 'status-warning';
        } else {
            statusText = 'Safe';
            statusClass = 'status-inactive';
        }
        statusEl.textContent = statusText;
        statusEl.className = `status-badge ${statusClass}`;
        statusEl.setAttribute('aria-label', `Proximity sensor status: ${statusText}`);
    }

    if (distanceIndicatorEl) {
        distanceIndicatorEl.setAttribute('aria-valuenow', distance);
        distanceIndicatorEl.setAttribute('aria-valuetext', `Distance: ${distance.toFixed(0)} centimeters`);
    }
}

function mapLogMessage(topic, message) {
    if (topic) {
        switch (topic) {
            case 'home/lock/status': return message === 'LOCKED' ? 'Front Door locked' : 'Front Door unlocked';
            case 'home/sensor/motion': return message === 'DETECTED' ? 'Motion detected' : 'No motion detected';
            case 'home/security/alarm': return message === 'ACTIVE' ? 'Alarm turned on' : 'Alarm turned off';
            case 'home/security/armed': return message === 'ARMED' ? 'Security system turned on' : 'Security system turned off';
            case 'home/rfid/events': return message.includes('Authorized Tag') ? 'Valid key card scanned' : 'Invalid key card scanned';
            case 'home/sensor/distance': return `Object ${parseFloat(message).toFixed(0)} cm away`;
        }
    } else {
        if (message.includes('Smart Lock status: LOCKED')) return 'Front Door locked';
        if (message.includes('Smart Lock status: UNLOCKED')) return 'Front Door unlocked';
        if (message.includes('Door unlocked by RFID')) return 'Door unlocked by RFID at close distance';
        if (message.includes('Motion Sensor status: DETECTED')) return 'Motion detected';
        if (message.includes('Motion Sensor status: CLEARED')) return 'No motion detected';
        if (message.includes('Alarm status: ACTIVE')) return 'Alarm turned on';
        if (message.includes('Alarm status: INACTIVE')) return 'Alarm turned off';
        if (message.includes('Security system is now: ARMED')) return 'Security system turned on';
        if (message.includes('Security system is now: DISARMED')) return 'Security system turned off';
        if (message.includes('Authorized Tag')) return 'Valid key card scanned';
        if (message.includes('Unauthorized Tag')) return 'Invalid key card scanned';
        if (message.includes('Ultrasonic Sensor distance')) {
            const distance = message.match(/[\d.]+/);
            return `Object ${distance ? distance[0] : 'unknown'} cm away`;
        }
        return message;
    }
}

function getLogType(topic, message) {
    if ((topic && topic === 'home/rfid/events' && message.includes('Unauthorized')) || message.includes('Unauthorized Tag')) return 'alert';
    if ((topic && topic === 'home/security/alarm' && message === 'ACTIVE') || message.includes('Alarm status: ACTIVE')) return 'danger';
    if ((topic && topic === 'home/sensor/motion' && message === 'DETECTED') || message.includes('Motion Sensor status: DETECTED')) return 'warning';
    if ((topic && topic === 'home/rfid/events' && message.includes('Authorized Tag')) || message.includes('Authorized Tag')) return 'success';
    if ((topic && topic === 'home/lock/status' && message === 'UNLOCKED') || message.includes('Door unlocked by RFID')) return 'success';
    return 'info';
}

function getLogIcon(type) {
    switch (type) {
        case 'danger':
        case 'alert': return 'fa-exclamation-circle';
        case 'warning': return 'fa-exclamation-triangle';
        case 'success': return 'fa-check-circle';
        default: return 'fa-info-circle';
    }
}

async function fetchUser() {
    try {
        const response = await fetch(`${BACKEND_URL}/api/auth/me`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Failed to fetch user');
        document.getElementById('userEmail').textContent = data.email;
    } catch (error) {
        console.error('Error fetching user:', error);
        showToast('Failed to load user data. Please check server connectivity.', 'error');
        speak('Failed to load user data. Please check server connectivity.');
        localStorage.removeItem('token');
        window.location.href = '/index.html';
    }
}

async function sendCommand(command, callback) {
    try {
        const response = await fetch(`${BACKEND_URL}/api/commands`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({ command }),
            timeout: 5000
        });
        if (!response.ok) throw new Error(`Failed to send command: ${response.status}`);
        const result = await response.json();
        const message = `Command "${command.toLowerCase()}" sent successfully!`;
        showToast(message, 'success');
        speak(message);
        if (callback) callback();
    } catch (error) {
        console.error('Error sending command:', error);
        const message = 'Failed to send command. Please check server connectivity.';
        showToast(message, 'error');
        speak(message);
    }
}

async function clearLogs(callback) {
    try {
        const response = await fetch(`${BACKEND_URL}/api/logs/clear`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        if (!response.ok) throw new Error(`Failed to clear logs: ${response.status}`);
        const activityLogEl = document.getElementById('activityLog');
        if (activityLogEl) {
            activityLogEl.innerHTML = '<div class="text-center text-gray-500 py-4">No recent activity</div>';
            activityLogEl.setAttribute('aria-live', 'polite');
            setTimeout(() => activityLogEl.removeAttribute('aria-live'), 100);
        }
        const message = 'Activity cleared successfully!';
        showToast(message, 'success');
        speak(message);
        if (callback) callback();
    } catch (error) {
        console.error('Error clearing logs:', error);
        const message = 'Failed to clear activity. Please check server connectivity.';
        showToast(message, 'error');
        speak(message);
    }
}

/**
 * Displays a toast notification.
 * @param {string|HTMLElement} message The message text or an HTMLElement to display.
 * @param {string} type The type of toast ('info', 'success', 'warning', 'error').
 * @param {boolean} persistent If true, the toast will not auto-dismiss.
 */
function showToast(message, type = 'info', persistent = false) {
    const toastContainer = document.getElementById('toastContainer');
    if (!toastContainer) {
        console.warn('Toast container not found. Cannot display toast.');
        return;
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type} bg-${type === 'error' ? 'red' : type === 'success' ? 'green' : type === 'warning' ? 'yellow' : 'blue'}-600 text-white p-4 rounded shadow`;

    if (type === 'error' || type === 'danger') {
        toast.setAttribute('role', 'alert');
        toast.setAttribute('aria-live', 'assertive');
    } else {
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
    }

    let messageContent;
    if (typeof message === 'string') {
        messageContent = message;
    } else if (message instanceof HTMLElement) {
        messageContent = message.outerHTML;
    } else {
        messageContent = String(message);
    }

    toast.innerHTML = `
        <div class="toast-content">${messageContent}</div>
        <button class="toast-close text-white ml-2" onclick="this.parentElement.remove()" aria-label="Close notification">×</button>
    `;

    toastContainer.appendChild(toast);

    if (!persistent) {
        setTimeout(() => {
            if (toastContainer.contains(toast)) {
                toast.remove();
            }
        }, 5000);
    }
}

// Function to toggle loading spinner visibility
function toggleLoading(show) {
    const loadingSpinner = document.getElementById('loadingSpinner');
    if (loadingSpinner) {
        loadingSpinner.classList.toggle('hidden', !show);
        if (show) {
            loadingSpinner.setAttribute('aria-busy', 'true');
            loadingSpinner.setAttribute('aria-label', loadingSpinner.getAttribute('aria-label') || 'Loading content');
        } else {
            loadingSpinner.removeAttribute('aria-busy');
            loadingSpinner.removeAttribute('aria-label');
        }
    }
}


/**
 * Plays a simple beep sound.
 * @param {number} count Number of beeps.
 */
function playBeep(count) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (!audioCtx) {
        console.warn('AudioContext not supported. Cannot play beep.');
        return;
    }

    const beepDuration = 100;
    const beepFrequency = 600;
    const gainNode = audioCtx.createGain();

    for (let i = 0; i < count; i++) {
        setTimeout(() => {
            const oscillator = audioCtx.createOscillator();
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(beepFrequency, audioCtx.currentTime);
            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            gainNode.gain.setValueAtTime(0.5, audioCtx.currentTime);

            oscillator.start();
            setTimeout(() => {
                oscillator.stop();
                oscillator.disconnect();
                // Close AudioContext after last beep, ensuring it's not closed prematurely if multiple beeps
                if (i === count - 1) {
                    audioCtx.close().catch(e => console.error('Error closing AudioContext:', e));
                }
            }, beepDuration);
        }, i * beepDuration * 2);
    }
}