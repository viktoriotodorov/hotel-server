// index.js (Split Reality Engine: Volume Fixed + Input Fixed)
require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

// --- CRITICAL SETTINGS ---
const AI_VOLUME = 1.0; 
// FIX 1: Lowered Background from 0.1 to 0.02 (Much quieter)
const BG_VOLUME = 0.02; 
const BG_URL = "https://raw.githubusercontent.com/viktoriotodorov/hotel-server/main/background.raw"; 

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Split Reality Audio Server Online"));

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

// --- AUDIO LOOKUP TABLES ---
const muLawToLinearTable = new Int16Array(256);
const linearToMuLawTable = new Uint8Array(65536);

// Generate Decode Table (u-Law -> Linear)
for (let i = 0; i < 256; i++) {
    let muLawByte = ~i; 
    let sign = (muLawByte & 0x80) >> 7;
    let exponent = (muLawByte & 0x70) >> 4;
    let mantissa = muLawByte & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    muLawToLinearTable[i] = sign === 0 ? -sample : sample;
}

// Generate Encode Table (Linear -> u-Law)
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

for (let i = -32768; i <= 32767; i++) {
    linearToMuLawTable[i + 32768] = linearToMuLaw(i);
}

// --- BACKGROUND AUDIO LOADER ---
let backgroundBuffer = Buffer.alloc(0);

console.log(`[SYSTEM] Downloading Background Raw Audio...`);
https.get(BG_URL, (res) => {
    const data = [];
    res.on('data', chunk => data.push(chunk));
    res.on('end', () => {
        backgroundBuffer = Buffer.concat(data);
        console.log(`[SYSTEM] Background Loaded! ${backgroundBuffer.length} bytes.`);
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

                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => {
                    console.log("[11LABS] Connected to AI Agent");
                    if (!mixerInterval) {
                        mixerInterval = setInterval(mixAndStream, 20); 
                    }
                });
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    // Check if AI is sending audio
                    let chunkData = null;
                    if (aiMsg.audio_event?.audio_base64_chunk) chunkData = aiMsg.audio_event.audio_base64_chunk;
                    
                    if (chunkData) {
                        // console.log("[11LABS] Received Audio Chunk"); // Uncomment to debug
                        const newChunk = Buffer.from(chunkData, 'base64');
                        audioQueue = Buffer.concat([audioQueue, newChunk]);
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                // --- FIX 2: INPUT TRANSLATION (u-Law -> PCM) ---
                // We must decode Twilio audio before sending to AI, 
                // otherwise the AI just hears static and won't respond.
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    const twilioData = Buffer.from(msg.media.payload, 'base64');
                    const pcmData = Buffer.alloc(twilioData.length * 2); // 16-bit = 2 bytes

                    for (let i = 0; i < twilioData.length; i++) {
                        const linearSample = muLawToLinearTable[twilioData[i]];
                        pcmData.writeInt16LE(linearSample, i * 2);
                    }

                    const payload = {
                        user_audio_chunk: pcmData.toString('base64')
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

    // --- THE MIXER ---
    function mixAndStream() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        
        const SAMPLES_PER_CHUNK = 160; 
        const mixedBuffer = Buffer.alloc(SAMPLES_PER_CHUNK); 

        // 1. Get AI Audio
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
                if (bgIndex >= backgroundBuffer.length - 2) bgIndex = 0; 
                const bgSample = backgroundBuffer.readInt16LE(bgIndex);
                bgIndex += 2;
                
                // Low volume mixing
                sampleSum += (bgSample * BG_VOLUME);
            }

            // B. AI Layer
            if (aiChunk) {
                const aiSample = muLawToLinearTable[aiChunk[i]];
                sampleSum += (aiSample * AI_VOLUME);
            }

            // C. Hard Limiting
            if (sampleSum > 32767) sampleSum = 32767;
            if (sampleSum < -32768) sampleSum = -32768;

            // D. Encode
            mixedBuffer[i] = linearToMuLawTable[Math.floor(sampleSum) + 32768];
        }

        ws.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: mixedBuffer.toString('base64') }
        }));
    }
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));
