// index.js (Final: Event-Driven Sync & Memory Safe)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Server Online: Event-Driven Mixer"));

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

// --- CONFIGURATION ---
const BG_VOLUME = 0.10;   // 10% Background volume
const AI_VOLUME = 1.0;    // 100% AI Volume
const MIC_BOOST = 3.0;    // 300% Boost for Scribe

// --- GLOBAL LOAD: Background Sound ---
// We load this ONCE into memory to prevent disk lag during calls
let GLOBAL_BG_BUFFER = null;

function loadBackgroundSound() {
    console.log("[SYSTEM] Downloading Background Sound...");
    https.get("https://raw.githubusercontent.com/viktoriotodorov/hotel-server/main/lobby.wav", (res) => {
        const data = [];
        res.on('data', chunk => data.push(chunk));
        res.on('end', () => {
            const fullFile = Buffer.concat(data);
            // Simple WAV header strip (skip first 44 bytes)
            if (fullFile.length > 44) {
                GLOBAL_BG_BUFFER = fullFile.subarray(44);
                console.log(`[SYSTEM] Background Loaded: ${GLOBAL_BG_BUFFER.length} bytes`);
            }
        });
    }).on('error', err => console.error("[SYSTEM] BG Download Error:", err.message));
}
loadBackgroundSound();

// --- TABLES (G.711 Mu-Law) ---
const muLawToLinear = new Int16Array(256);
const linearToMuLaw = new Uint8Array(65536);

// Initialize Tables
(() => {
    const BIAS = 0x84;
    const CLIP = 32635;
    for (let i = 0; i < 256; i++) {
        let muLawByte = ~i;
        let sign = (muLawByte & 0x80) >> 7;
        let exponent = (muLawByte & 0x70) >> 4;
        let mantissa = muLawByte & 0x0F;
        let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
        muLawToLinear[i] = sign === 0 ? -sample : sample;
    }
    for (let i = 0; i < 65536; i++) {
        let sample = i - 32768;
        if (sample < -CLIP) sample = -CLIP;
        if (sample > CLIP) sample = CLIP;
        const sign = (sample < 0) ? 0x80 : 0;
        sample = (sample < 0) ? -sample : sample;
        sample += BIAS;
        let exponent = 7;
        for (let exp = 0; exp < 8; exp++) {
            if (sample < (1 << (exp + 5))) { exponent = exp; break; }
        }
        if (sample > 32767) sample = 32767;
        let mantissa = (sample >> (exponent === 0 ? 0 : exponent + 3)) & 0x0F;
        // Correct G.711 encoding logic simplified for lookup
        let exponent_bits = exponent; 
        // Re-implement standard lookup generation to be safe:
        // (Skipping deep math for brevity, standard mu-law tables are robust)
        // ...actually, for safety, let's use a simpler on-the-fly encode if table is suspect, 
        // but table is faster. We will stick to the previous working table logic for Encode.
    }
    // *Correction*: Re-using the standard MuLaw encode logic from your working version
    for (let i = 0; i < 65536; i++) {
        let sample = i - 32768;
        if (sample < -CLIP) sample = -CLIP;
        if (sample > CLIP) sample = CLIP;
        let sign = (sample < 0) ? 0x80 : 0;
        sample = (sample < 0) ? -sample : sample;
        sample += BIAS;
        let exponent = 7;
        for (let exp = 0; exp < 8; exp++) {
            if (sample < (1 << (exp + 5))) { exponent = exp; break; }
        }
        let mantissa = (sample >> (exponent + 3)) & 0x0F;
        linearToMuLaw[i] = ~(sign | (exponent << 4) | mantissa);
    }
})();

wss.on('connection', (ws) => {
    console.log("[TWILIO] Client Connected");
    
    let elevenLabsWs = null;
    let streamSid = null;
    
    // AI Audio Buffer (Simple Array, Shift/Push)
    // We use a simple array for packets to avoid Buffer.concat memory leaks
    let aiPacketQueue = []; 
    
    // User Audio State
    let inputBuffer = Buffer.alloc(0);
    let lastInputSample = 0;

    // Background State
    let bgIndex = 0;

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                // 1. Connect to ElevenLabs (Standard 8k u-law)
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        // Store chunks in a queue. DO NOT CONCAT.
                        const chunk = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                        aiPacketQueue.push(chunk);
                    }
                });

                elevenLabsWs.on('close', () => console.log("[11LABS] Closed"));
                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e));

            } else if (msg.event === 'media') {
                // *** THE CLOCK *** // Twilio sent us 20ms of audio. We MUST send 20ms back right now.
                
                // 1. Process Input (Boost Mic -> 11Labs)
                const twilioData = Buffer.from(msg.media.payload, 'base64');
                
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    // Quick Upsample 8k -> 16k for Scribe
                    const pcm16k = Buffer.alloc(twilioData.length * 4);
                    for (let i = 0; i < twilioData.length; i++) {
                        let sample = muLawToLinear[twilioData[i]];
                        sample = Math.max(-32768, Math.min(32767, sample * MIC_BOOST)); // Boost
                        
                        // Linear Interpolation
                        pcm16k.writeInt16LE(Math.floor((lastInputSample + sample) / 2), i * 4);
                        pcm16k.writeInt16LE(sample, i * 4 + 2);
                        lastInputSample = sample;
                    }
                    // Buffer slightly to avoid sending tiny packets
                    inputBuffer = Buffer.concat([inputBuffer, pcm16k]);
                    if (inputBuffer.length >= 3200) { // 100ms
                         elevenLabsWs.send(JSON.stringify({ user_audio_chunk: inputBuffer.toString('base64') }));
                         inputBuffer = Buffer.alloc(0);
                    }
                }

                // 2. Process Output (Mix AI + BG -> Twilio)
                // We need exactly 160 bytes (20ms @ 8k mu-law)
                const CHUNK_SIZE = 160;
                const outputBuffer = Buffer.alloc(CHUNK_SIZE);
                
                // Get AI Data (Pull from queue)
                let aiBuffer = null;
                if (aiPacketQueue.length > 0) {
                    aiBuffer = aiPacketQueue[0];
                    // If we used this packet up, remove it. 
                    // (Simplified logic: assuming 11labs sends roughly correct chunk sizes. 
                    // If 11labs sends large chunks, we need to slice them. 
                    // For robustness, we slice.)
                    if (aiBuffer.length > CHUNK_SIZE) {
                        aiPacketQueue[0] = aiBuffer.subarray(CHUNK_SIZE);
                        aiBuffer = aiBuffer.subarray(0, CHUNK_SIZE);
                    } else {
                        aiPacketQueue.shift(); // Remove empty/used chunk
                    }
                }

                // Mixing Loop
                for (let i = 0; i < CHUNK_SIZE; i++) {
                    let mixedSample = 0;

                    // Add Background
                    if (GLOBAL_BG_BUFFER) {
                        if (bgIndex >= GLOBAL_BG_BUFFER.length - 2) bgIndex = 0;
                        const bgSample = GLOBAL_BG_BUFFER.readInt16LE(bgIndex);
                        bgIndex += 2;
                        mixedSample += bgSample * BG_VOLUME;
                    }

                    // Add AI
                    if (aiBuffer && i < aiBuffer.length) {
                        const aiSample = muLawToLinear[aiBuffer[i]];
                        mixedSample += aiSample * AI_VOLUME;
                    }

                    // Clamp
                    mixedSample = Math.max(-32768, Math.min(32767, mixedSample));

                    // Encode
                    const tableIdx = Math.floor(mixedSample) + 32768;
                    outputBuffer[i] = linearToMuLaw[tableIdx];
                }

                // Send back to Twilio immediately
                if (streamSid) {
                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: outputBuffer.toString('base64') }
                    }));
                }
            } else if (msg.event === 'stop') {
                if (elevenLabsWs) elevenLabsWs.close();
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => {
        if (elevenLabsWs) elevenLabsWs.close();
    });
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));
