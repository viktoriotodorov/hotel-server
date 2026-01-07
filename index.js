// index.js (Split Reality Engine: Production Ready)
require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const AI_VOLUME = 1.0;        // 1.0 = 100% (No Boost, No Distortion)
const BG_VOLUME = 0.1;        // 0.1 = 10% (Subtle background)
// REPLACE THIS URL WITH YOUR RAW FILE URL
const BG_URL = "https://raw.githubusercontent.com/viktoriotodorov/hotel-server/main/background.raw"; 

const app = express();
app.use(express.urlencoded({ extended: true }));

// Root Route
app.get('/', (req, res) => res.send("Split Reality Audio Server Online"));

// Twilio Incoming Call Route
app.post('/incoming-call', (req, res) => {
    const callerId = req.body.From || "Unknown";
    console.log(`[TWILIO] Incoming call from: ${callerId}`);
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

// --- AUDIO PROCESSING TABLES (G.711 u-Law) ---
const muLawToLinearTable = new Int16Array(256);
const linearToMuLawTable = new Uint8Array(65536);

// 1. Generate Decode Table (u-Law -> Linear)
for (let i = 0; i < 256; i++) {
    let muLawByte = ~i; 
    let sign = (muLawByte & 0x80) >> 7;
    let exponent = (muLawByte & 0x70) >> 4;
    let mantissa = muLawByte & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    muLawToLinearTable[i] = sign === 0 ? -sample : sample;
}

// 2. Generate Encode Table (Linear -> u-Law)
// We precompute this to save CPU during the call
const linearToMuLaw = (sample) => {
    const BIAS = 0x84;
    const CLIP = 32635;
    sample = (sample < -CLIP) ? -CLIP : (sample > CLIP) ? CLIP : sample;
    const sign = (sample < 0) ? 0x80 : 0;
    sample = (sample < 0) ? -sample : sample;
    sample += BIAS;
    let exponent = 7;
    for (let exp = 0; exp < 8; exp++) {
        if (sample < (1 << (exp + 5))) {
            exponent = exp;
            break;
        }
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
};

// Fill the encode table
for (let i = -32768; i <= 32767; i++) {
    // Offset by 32768 to map array index (0-65535) to int16 range
    linearToMuLawTable[i + 32768] = linearToMuLaw(i);
}

// --- BACKGROUND AUDIO LOADER ---
let backgroundBuffer = Buffer.alloc(0);

console.log(`[SYSTEM] Downloading Background Raw Audio from: ${BG_URL}`);
https.get(BG_URL, (res) => {
    const data = [];
    res.on('data', chunk => data.push(chunk));
    res.on('end', () => {
        backgroundBuffer = Buffer.concat(data);
        console.log(`[SYSTEM] Background Loaded! Size: ${backgroundBuffer.length} bytes.`);
        if (backgroundBuffer.length < 1000) {
            console.warn("[WARN] Background file seems too small. Check URL.");
        }
    });
}).on('error', err => console.error("[ERROR] Failed to download background:", err.message));


// --- WEBSOCKET SERVER ---
wss.on('connection', (ws) => {
    console.log("[TWILIO] Stream Connected");
    
    let elevenLabsWs = null;
    let streamSid = null;
    let audioQueue = Buffer.alloc(0); 
    let bgIndex = 0;
    let mixerInterval = null;

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream ID: ${streamSid}`);

                // Connect to ElevenLabs (Asking for u-law 8000Hz)
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => {
                    console.log("[11LABS] Connected to AI Agent");
                    // Start the Heartbeat Mixer immediately
                    if (!mixerInterval) {
                        mixerInterval = setInterval(mixAndStream, 20); // 20ms Loop
                    }
                });
                
                // Handle AI Responses
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    
                    // Extract Audio from 11Labs Message
                    let chunkData = null;
                    if (aiMsg.audio_event?.audio_base64_chunk) chunkData = aiMsg.audio_event.audio_base64_chunk;
                    else if (aiMsg.audio_event?.audio) chunkData = aiMsg.audio_event.audio;
                    
                    if (chunkData) {
                        const newChunk = Buffer.from(chunkData, 'base64');
                        audioQueue = Buffer.concat([audioQueue, newChunk]);
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                // --- SPLIT REALITY INPUT STRATEGY ---
                // We send the caller's audio DIRECTLY to ElevenLabs.
                // We DO NOT mix the hotel lobby sound here.
                // This ensures the AI has "perfect hearing".
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    const payload = {
                        user_audio_chunk: msg.media.payload // Send raw base64 u-law
                    };
                    elevenLabsWs.send(JSON.stringify(payload));
                }
            } else if (msg.event === 'stop') {
                console.log("[TWILIO] Stream Stopped");
                if (elevenLabsWs) elevenLabsWs.close();
                clearInterval(mixerInterval);
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => {
        clearInterval(mixerInterval);
        console.log("[TWILIO] Client Disconnected");
    });

    // --- THE MIXER (Heartbeat) ---
    // Runs every 20ms to send audio to the caller.
    // It mixes the Hotel Lobby + AI Voice (if speaking).
    function mixAndStream() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        
        // G.711 u-law is 8000Hz. 20ms = 160 samples.
        const SAMPLES_PER_CHUNK = 160; 
        const mixedBuffer = Buffer.alloc(SAMPLES_PER_CHUNK); // Output buffer (u-law is 1 byte per sample)

        // 1. Get AI Audio (if available)
        let aiChunk = null;
        if (audioQueue.length >= SAMPLES_PER_CHUNK) {
            aiChunk = audioQueue.subarray(0, SAMPLES_PER_CHUNK);
            audioQueue = audioQueue.subarray(SAMPLES_PER_CHUNK);
        }

        // 2. Mix Loop
        for (let i = 0; i < SAMPLES_PER_CHUNK; i++) {
            let sampleSum = 0;

            // A. Background Layer
            if (backgroundBuffer.length > 0) {
                // Read 16-bit Little Endian (2 bytes)
                if (bgIndex >= backgroundBuffer.length - 2) bgIndex = 0; // Loop
                const bgSample = backgroundBuffer.readInt16LE(bgIndex);
                bgIndex += 2;
                
                sampleSum += (bgSample * BG_VOLUME);
            }

            // B. AI Layer
            if (aiChunk) {
                // Decode u-law byte to linear integer
                const aiSample = muLawToLinearTable[aiChunk[i]];
                sampleSum += (aiSample * AI_VOLUME);
            }

            // C. Hard Limiting (Prevent Distortion/Crackle)
            if (sampleSum > 32767) sampleSum = 32767;
            if (sampleSum < -32768) sampleSum = -32768;

            // D. Encode back to u-Law
            // We use the offset +32768 to handle negative indices for the lookup table
            mixedBuffer[i] = linearToMuLawTable[Math.floor(sampleSum) + 32768];
        }

        // 3. Send to Twilio
        ws.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: mixedBuffer.toString('base64') }
        }));
    }
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));

