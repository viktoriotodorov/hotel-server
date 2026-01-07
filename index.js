/**
 * Title: Split Reality Balanced Engine (Crash Fixed)
 * Description: Adds safety clamping to the Input Boost to prevent server crashes.
 */

require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// --- CRITICAL VOLUME SETTINGS ---
const AI_INPUT_BOOST = 5.0;  // Mic Boost (x5)
const AI_OUTPUT_BOOST = 3.0; // Speaker Boost (x3)
const BG_VOLUME = 0.02;      // Background (2%)

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Balanced Audio Server Online"));

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

// --- DSP ENGINE ---
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

// --- LOCAL FILE LOADER ---
let backgroundBuffer = Buffer.alloc(0);
try {
    const filePath = path.join(__dirname, 'backgroundn.raw');
    if (fs.existsSync(filePath)) {
        backgroundBuffer = fs.readFileSync(filePath);
        console.log(`[SYSTEM] Background Loaded: ${backgroundBuffer.length} bytes`);
    } else {
        console.warn(`[WARN] backgroundn.raw not found.`);
    }
} catch (err) {
    console.error(`[ERROR] File Load Failed: ${err.message}`);
}

// --- MIXER ---
wss.on('connection', (ws) => {
    console.log('[TWILIO] Stream Connected');
    
    let elevenLabsWs = null;
    let streamSid = null;
    let audioQueue = Buffer.alloc(0);
    let bgIndex = 0;
    let mixerInterval = null;
    
    let pcmInputQueue = Buffer.alloc(0);
    let lastInputSample = 0;

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });

                elevenLabsWs.on('open', () => {
                    console.log("[11LABS] Connected");
                    if (!mixerInterval) mixerInterval = setInterval(mixAndStream, 20);
                });
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    let chunkData = null;
                    if (aiMsg.audio_event) {
                        if (aiMsg.audio_event.audio_base64_chunk) chunkData = aiMsg.audio_event.audio_base64_chunk;
                        else if (aiMsg.audio_event.audio) chunkData = aiMsg.audio_event.audio;
                    }

                    if (chunkData) {
                        const newChunk = Buffer.from(chunkData, 'base64');
                        audioQueue = Buffer.concat([audioQueue, newChunk]);
                    }
                });
            } else if (msg.event === 'media') {
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); 

                    for (let i = 0; i < twilioChunk.length; i++) {
                        let currentSample = muLawToLinearTable[twilioChunk[i]];
                        
                        // 1. BOOST (x5)
                        currentSample = currentSample * AI_INPUT_BOOST; 

                        // 2. CLAMP (THE FIX: Prevent Crash)
                        if (currentSample > 32767) currentSample = 32767;
                        if (currentSample < -32768) currentSample = -32768;
                        
                        // 3. Upsample
                        const midPoint = Math.floor((lastInputSample + currentSample) / 2);
                        
                        pcmChunk.writeInt16LE(midPoint, i * 4);
                        pcmChunk.writeInt16LE(Math.floor(currentSample), i * 4 + 2);
                        
                        lastInputSample = currentSample;
                    }

                    pcmInputQueue = Buffer.concat([pcmInputQueue, pcmChunk]);

                    if (pcmInputQueue.length >= 3200) { 
                        elevenLabsWs.send(JSON.stringify({ 
                            user_audio_chunk: pcmInputQueue.toString('base64') 
                        }));
                        pcmInputQueue = Buffer.alloc(0);
                    }
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

        for (let i = 0; i < CHUNK_SIZE; i++) {
            let sampleSum = 0;

            // Background
            if (backgroundBuffer.length > 0) {
                if (bgIndex >= backgroundBuffer.length - 2) bgIndex = 0; 
                const bgSample = backgroundBuffer.readInt16LE(bgIndex);
                bgIndex += 2;
                sampleSum += (bgSample * BG_VOLUME); 
            }

            // AI Voice
            if (aiChunk) {
                let aiSample = muLawToLinearTable[aiChunk[i]];
                aiSample = aiSample * AI_OUTPUT_BOOST; 
                sampleSum += aiSample;
            }

            // Output Clamp
            if (sampleSum > 32700) sampleSum = 32700;
            if (sampleSum < -32700) sampleSum = -32700;

            mixedBuffer[i] = linearToMuLawTable[Math.floor(sampleSum) + 32768];
        }

        ws.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: mixedBuffer.toString('base64') }
        }));
    }
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on ${PORT}`));
