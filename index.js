/**
 * Title: Split Reality Diagnostic Engine
 * Description: Mutes audio to test AI, logs data to find distortion source.
 */

require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// --- DIAGNOSTIC SETTINGS ---
const AI_VOLUME = 1.0; 
const BG_VOLUME = 0.0; // MUTED: We want to hear if the AI works alone.

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Diagnostic Server Online"));

app.post('/incoming-call', (req, res) => {
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

// --- G.711 LUTs ---
const muLawToLinearTable = new Int16Array(256);
const linearToMuLawTable = new Uint8Array(65536);

for (let i = 0; i < 256; i++) {
    let mu = ~i;
    let sign = (mu & 0x80) >> 7;
    let exponent = (mu & 0x70) >> 4;
    let mantissa = mu & 0x0F;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    muLawToLinearTable[i] = sign === 0 ? -(sample - 0x84) : (sample - 0x84);
}

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

// --- FILE LOADER ---
let backgroundBuffer = Buffer.alloc(0);
try {
    const filePath = path.join(__dirname, 'background.raw');
    if (fs.existsSync(filePath)) {
        backgroundBuffer = fs.readFileSync(filePath);
        console.log(`[SYSTEM] Loaded background.raw: ${backgroundBuffer.length} bytes`);
    } else {
        console.error(`[WARN] File not found: ${filePath}`);
    }
} catch (err) {
    console.error(`[ERROR] Load Failed: ${err.message}`);
}

// --- MIXER ---
wss.on('connection', (ws) => {
    console.log('[TWILIO] Connection Accepted');
    
    let elevenLabsWs = null;
    let streamSid = null;
    let audioQueue = Buffer.alloc(0);
    let bgIndex = 0;
    let mixerInterval = null;
    let logCounter = 0; // Limit logs so we don't crash

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });

                elevenLabsWs.on('open', () => {
                    console.log("[11LABS] Connected");
                    mixerInterval = setInterval(mixAndStream, 20);
                });
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        const newChunk = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                        audioQueue = Buffer.concat([audioQueue, newChunk]);
                    }
                });
            } else if (msg.event === 'media') {
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    const twilioData = Buffer.from(msg.media.payload, 'base64');
                    // INPUT DEBUG: Are we receiving audio?
                    if (logCounter < 5) console.log(`[INPUT] Received ${twilioData.length} bytes from Twilio`);
                    
                    const pcmData = Buffer.alloc(twilioData.length * 2);
                    for (let i = 0; i < twilioData.length; i++) {
                        pcmData.writeInt16LE(muLawToLinearTable[twilioData[i]], i * 2);
                    }
                    elevenLabsWs.send(JSON.stringify({ user_audio_chunk: pcmData.toString('base64') }));
                }
            } else if (msg.event === 'stop') {
                if (elevenLabsWs) elevenLabsWs.close();
                clearInterval(mixerInterval);
            }
        } catch (e) { console.error(e); }
    });

    ws.on('close', () => clearInterval(mixerInterval));

    function mixAndStream() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        
        const CHUNK_SIZE = 160; 
        const mixedBuffer = Buffer.alloc(CHUNK_SIZE); 

        let aiChunk = null;
        if (audioQueue.length >= CHUNK_SIZE) {
            aiChunk = audioQueue.subarray(0, CHUNK_SIZE);
            audioQueue = audioQueue.subarray(CHUNK_SIZE);
        }

        // --- DIAGNOSTIC LOGGING ---
        // We log the very first sample of every 50th frame to see what's happening
        let debugBgSample = 0;
        let debugAiSample = 0;

        for (let i = 0; i < CHUNK_SIZE; i++) {
            let sampleSum = 0;

            // 1. Read Background (Even if volume is 0, we read it to check values)
            let bgSample = 0;
            if (backgroundBuffer.length > 0) {
                if (bgIndex >= backgroundBuffer.length - 2) bgIndex = 0; 
                bgSample = backgroundBuffer.readInt16LE(bgIndex);
                bgIndex += 2;
                debugBgSample = bgSample; // Capture for log
            }

            // 2. Read AI
            let aiSample = 0;
            if (aiChunk) {
                aiSample = muLawToLinearTable[aiChunk[i]];
                debugAiSample = aiSample; // Capture for log
            }

            // 3. MIX (With Mute applied)
            sampleSum += (bgSample * BG_VOLUME); // This is 0.0 right now
            sampleSum += (aiSample * AI_VOLUME);

            // 4. Clip
            if (sampleSum > 32700) sampleSum = 32700;
            if (sampleSum < -32700) sampleSum = -32700;

            mixedBuffer[i] = linearToMuLawTable[Math.floor(sampleSum) + 32768];
        }

        // --- PRINT THE DATA (Once per second approx) ---
        logCounter++;
        if (logCounter % 50 === 0) {
             console.log(`[DIAGNOSTIC] BG Raw Value: ${debugBgSample} | AI Raw Value: ${debugAiSample}`);
             if (Math.abs(debugBgSample) > 10000) console.warn(">>> WARNING: Background file is VERY LOUD! <<<");
        }

        ws.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: mixedBuffer.toString('base64') }
        }));
    }
});

server.listen(PORT, () => console.log(`[SYSTEM] Diagnostic Server on ${PORT}`));
