// index.js (Cloud Beep Diagnostic)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Cloud Beep Server Online"));

// Generate 1 Second of u-law Beep (Mathematical)
const createBeep = () => {
    const frequency = 440; 
    const sampleRate = 8000;
    const buffer = Buffer.alloc(sampleRate); 
    for (let i = 0; i < buffer.length; i++) {
        const t = i / sampleRate;
        const sample = Math.sin(2 * Math.PI * frequency * t);
        const s = Math.max(-1, Math.min(1, sample));
        const ulaw = Math.sign(s) * (Math.log(1 + 255 * Math.abs(s)) / Math.log(256));
        buffer[i] = (ulaw * 127 + 128); 
    }
    return buffer;
};
const beepBuffer = createBeep();

app.post('/incoming-call', (req, res) => {
    const callerId = req.body.From || "Unknown";
    console.log(`[TWILIO] Call from: ${callerId}`);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${req.headers.host}/media-stream" />
        </Connect>
      </Response>`;
    res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log("[TWILIO] Connected");
    let intervalId = null;
    let index = 0;

    ws.on('message', (message) => {
        const msg = JSON.parse(message);
        if (msg.event === 'start') {
            console.log(`[TWILIO] Stream Started! Sending Beep...`);
            intervalId = setInterval(() => {
                if (ws.readyState !== WebSocket.OPEN) return clearInterval(intervalId);
                
                // Send 20ms (160 bytes) chunks
                const chunk = beepBuffer.subarray(index, index + 160);
                index = (index + 160) % beepBuffer.length; 

                ws.send(JSON.stringify({
                    event: 'media',
                    streamSid: msg.start.streamSid,
                    media: { payload: chunk.toString('base64') }
                }));
            }, 20);
        } else if (msg.event === 'stop') {
            clearInterval(intervalId);
        }
    });

    ws.on('close', () => clearInterval(intervalId));
});

server.listen(PORT, () => console.log(`[SYSTEM] Beep Server listening on port ${PORT}`));
