const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const alawmulaw = require('alawmulaw'); 

const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const BG_VOLUME = 0.05; // Reduced to 5% (was 20%)
const CHUNK_SIZE = 160; 

// Validate Environment Variables
if (!process.env.ELEVENLABS_API_KEY || !process.env.AGENT_ID) {
    console.error("[SYSTEM] ERROR: Missing Environment Variables");
    process.exit(1);
}

// --- LOAD BACKGROUND AUDIO ---
let bgBuffer = null;
try {
    const filePath = path.join(__dirname, 'background.wav');
    const fileData = fs.readFileSync(filePath);
    // REMINDER: Ensure your file is S16LE (16-bit), 8000Hz, Mono!
    const rawBuffer = fileData.subarray(44); 
    bgBuffer = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2);
    console.log(`[SYSTEM] Background audio loaded: ${bgBuffer.length} samples`);
} catch (err) {
    console.error("[SYSTEM] Failed to load background.wav", err.message);
}

const app = express();

// Parse Twilio Data
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.get('/', (req, res) => res.send('Split-Reality Server is Online'));

app.post('/incoming-call', (req, res) => {
    const callerId = req.body.From || "Unknown";
    console.log(`[TWILIO] Call from: ${callerId}`);
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

wss.on('connection', (ws) => {
    console.log("[TWILIO] Client Connected");
    let elevenLabsWs = null;
    let streamSid = null;
    let mixerInterval = null;
    let aiAudioQueue = []; 
    let bgIndex = 0;

    const sendAudioToTwilio = (audioData) => {
        if (!streamSid) return;
        ws.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: audioData }
        }));
    };

    // --- HEARTBEAT MIXER (20ms) ---
    const startMixer = () => {
        if (mixerInterval) clearInterval(mixerInterval);
        mixerInterval = setInterval(() => {
            if (!streamSid || !bgBuffer) return;

            const outputSamples = new Int16Array(CHUNK_SIZE);
            const aiSamples = aiAudioQueue.splice(0, CHUNK_SIZE);

            for (let i = 0; i < CHUNK_SIZE; i++) {
                // Mix Background + AI
                const bgSample = bgBuffer[bgIndex] * BG_VOLUME;
                bgIndex = (bgIndex + 1) % bgBuffer.length;
                
                // If AI has audio, use it. Otherwise 0.
                const aiSample = i < aiSamples.length ? aiSamples[i] : 0;
                
                let mixed = aiSample + bgSample;
                
                // Prevent Distortion
                outputSamples[i] = Math.max(-32768, Math.min(32767, mixed));
            }

            // Encode output to phone
            const muLawSamples = alawmulaw.mulaw.encode(outputSamples);
            sendAudioToTwilio(Buffer.from(muLawSamples).toString('base64'));

        }, 20);
    };

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream Started! SID: ${streamSid}`);
                
                startMixer(); 

                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        // Decode AI audio and put in queue
                        const rawAudio = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                        const pcmSamples = alawmulaw.mulaw.decode(rawAudio);
                        for (let i = 0; i < pcmSamples.length; i++) aiAudioQueue.push(pcmSamples[i]);
                    }
                });
                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    // --- PASS-THROUGH (No Boost) ---
                    // We send the data exactly as Twilio sent it. 
                    // This guarantees the AI hears clean audio (no static).
                    elevenLabsWs.send(JSON.stringify({ 
                        user_audio_chunk: msg.media.payload 
                    }));
                }
            } else if (msg.event === 'stop') {
                if (elevenLabsWs) elevenLabsWs.close();
                if (mixerInterval) clearInterval(mixerInterval);
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => {
        if (elevenLabsWs) elevenLabsWs.close();
        if (mixerInterval) clearInterval(mixerInterval);
    });
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));
