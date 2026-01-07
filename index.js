/**
 * Title: Split Reality Hybrid Engine
 * Description: Merges your working Input Logic (Upsampling) with clean Background Mixing.
 */

require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// --- CONFIGURATION ---
const AI_VOLUME = 1.0;  // 100% (No Boost of 5.0, prevents distortion)
const BG_VOLUME = 1.0;  // 100% (Since your file is already quieted to 5%)

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Hybrid Audio Server Online"));

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

// --- DSP ENGINE (G.711 LUT) ---
const muLawToLinearTable = new Int16Array(256);
const linearToMuLawTable = new Uint8Array(65536);

// Generate Decode Table
for (let i = 0; i < 256; i++) {
    let mu = ~i;
    let sign = (mu & 0x80) >> 7;
    let exponent = (mu & 0x70) >> 4;
    let mantissa = mu & 0x0F;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    muLawToLinearTable[i] = sign === 0 ? -(sample - 0x84) : (sample - 0x84);
}

// Generate Encode Table
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
    const filePath = path.join(__dirname, 'background.raw');
    if (fs.existsSync(filePath)) {
        backgroundBuffer = fs.readFileSync(filePath);
        console.log(`[SYSTEM] Background Loaded: ${backgroundBuffer.length} bytes`);
    } else {
        console.warn(`[WARN] background.raw not found. Please upload it.`);
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
    
    // VARIABLES FOR YOUR UPSAMPLING LOGIC
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
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        const newChunk = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                        audioQueue = Buffer.concat([audioQueue, newChunk]);
                    }
                });
            } else if (msg.event === 'media') {
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    // --- YOUR ORIGINAL INPUT LOGIC (UPSAMPLING 8k -> 16k) ---
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); // 2 bytes * 2 (doubling samples)

                    for (let i = 0; i < twilioChunk.length; i++) {
                        const currentSample = muLawToLinearTable[twilioChunk[i]];
                        // Create a mid-point sample (Linear Interpolation)
                        const midPoint = Math.floor((lastInputSample + currentSample) / 2);
                        
                        // Write Mid-point (Upsample)
                        pcmChunk.writeInt16LE(midPoint, i * 4);
                        // Write Actual Sample
                        pcmChunk.writeInt16LE(currentSample, i * 4 + 2);
                        
                        lastInputSample = currentSample;
                    }

                    pcmInputQueue = Buffer.concat([pcmInputQueue, pcmChunk]);

                    // Send when we have enough data
                    if (pcmInputQueue.length >= 1600) {
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

            // 1. Add Background
            if (backgroundBuffer.length > 0) {
                if (bgIndex >= backgroundBuffer.length - 2) bgIndex = 0; 
                const bgSample = backgroundBuffer.readInt16LE(bgIndex);
                bgIndex += 2;
                
                // Use 1.0 because your file is quiet. Use 0.05 if using original file.
                sampleSum += (bgSample * BG_VOLUME);
            }

            // 2. Add AI Voice (NO BOOST)
            if (aiChunk) {
                const aiSample = muLawToLinearTable[aiChunk[i]];
                sampleSum += (aiSample * AI_VOLUME);
            }

            // 3. Hard Clip
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
