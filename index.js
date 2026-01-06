// index.js (Final Cloud Production)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');

// Render sets the PORT environment variable to 10000 automatically
const PORT = process.env.PORT || 3000;

// Validate Keys
if (!process.env.ELEVENLABS_API_KEY || !process.env.AGENT_ID) {
    console.error("ERROR: Missing Environment Variables");
    process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: true }));

// 1. Add a Browser Test Route (So you can check if it works in Chrome)
app.get('/', (req, res) => {
    res.send("Server is Online and Ready!");
});

// 2. The Twilio Route
app.post('/incoming-call', (req, res) => {
    const callerId = req.body.From || "Unknown";
    console.log(`[TWILIO] Incoming Call from: ${callerId}`);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${req.headers.host}/media-stream">
            <Parameter name="caller_id" value="${callerId}" />
          </Stream>
        </Connect>
      </Response>`;
    res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log("[TWILIO] Client Connected");
    let elevenLabsWs = null;
    let streamSid = null;
    let audioBuffer = Buffer.alloc(0);
    let intervalId = null;

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream Started! SID: ${streamSid}`);

                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => {
                    console.log("[11LABS] Connected");
                    intervalId = setInterval(sendNextChunk, 20); // Start Spoon-Feeder
                });

                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        const newChunk = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                        audioBuffer = Buffer.concat([audioBuffer, newChunk]);
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => {
                    console.log("[11LABS] Disconnected");
                    clearInterval(intervalId);
                });

            } else if (msg.event === 'media') {
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    elevenLabsWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
                }
            } else if (msg.event === 'stop') {
                if (elevenLabsWs) elevenLabsWs.close();
                clearInterval(intervalId);
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => clearInterval(intervalId));

    function sendNextChunk() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        const CHUNK_SIZE = 160;
        if (audioBuffer.length >= CHUNK_SIZE) {
            const chunkToSend = audioBuffer.subarray(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.subarray(CHUNK_SIZE);
            ws.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: { payload: chunkToSend.toString('base64') }
            }));
        }
    }
});

server.listen(PORT, () => console.log(`[SYSTEM] Final Cloud Server listening on port ${PORT}`));
