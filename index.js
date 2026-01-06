// index.js (Final Cloud: Golden Master Mixer)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Server Online: Golden Master Mixer Active"));

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

// --- PERFECT LEVELS ---
// We keep the AI at 100% (1.0) and the Background at 10% (0.1).
// This guarantees no distortion (Clipping).
const BG_VOLUME = 0.10;
const AI_VOLUME = 1.0; 
const MIC_BOOST = 3.0; // Boost YOUR voice for Scribe, not the AI output.

// --- 1. DECODER (Mu-Law -> Linear PCM) ---
const muLawToLinearTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
    let muLawByte = ~i;
    let sign = (muLawByte & 0x80) >> 7;
    let exponent = (muLawByte & 0x70) >> 4;
    let mantissa = muLawByte & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    sample = sign === 0 ? -sample : sample;
    muLawToLinearTable[i] = sample;
}

// --- 2. ENCODER (Linear PCM -> Mu-Law) ---
const linearToMuLawTable = new Uint8Array(65536);
const BIAS = 0x84;
const CLIP = 32635;
for (let i = 0; i < 65536; i++) {
    let sample = i - 32768;
    if (sample < -CLIP) sample = -CLIP;
    if (sample > CLIP) sample = CLIP;
    const sign = (sample < 0) ? 0x80 : 0;
    sample = (sample < 0) ? -sample : sample;
    sample += BIAS;
    let exponent = 7;
    let exponent_bits = 0;
    for (let exp = 0; exp < 8; exp++) {
        if (sample < (1 << (exp + 5))) { exponent = exp; break; }
    }
    if (sample > 32767) sample = 32767;
    if (sample >= 32768) exponent_bits = 7;
    else if (sample >= 16384) exponent_bits = 6;
    else if (sample >= 8192) exponent_bits = 5;
    else if (sample >= 4096) exponent_bits = 4;
    else if (sample >= 2048) exponent_bits = 3;
    else if (sample >= 1024) exponent_bits = 2;
    else if (sample >= 512) exponent_bits = 1;
    else exponent_bits = 0;
    const mantissa_bits = (sample >> (exponent_bits + 3)) & 0x0F;
    linearToMuLawTable[i] = ~(sign | (exponent_bits << 4) | mantissa_bits) & 0xFF;
}

// --- BACKGROUND LOADER (16-bit PCM Storage) ---
let backgroundBuffer = Buffer.alloc(0);
console.log("[SYSTEM] Downloading Background Sound...");
https.get("https://raw.githubusercontent.com/viktoriotodorov/hotel-server/main/lobby.wav", (res) => {
    const data = [];
    res.on('data', chunk => data.push(chunk));
    res.on('end', () => {
        const fullFile = Buffer.concat(data);
        if (fullFile.length > 100) {
            // We strip the first 44 bytes (WAV Header) so we don't play a "click" sound
            backgroundBuffer = fullFile.subarray(44);
            console.log(`[SYSTEM] Background Sound Loaded! (${backgroundBuffer.length} bytes)`);
        }
    });
}).on('error', err => console.log("[SYSTEM] No Background Sound found."));


wss.on('connection', (ws) => {
    console.log("[TWILIO] Client Connected");
    
    let elevenLabsWs = null;
    let streamSid = null;
    
    // Audio Buffers
    let aiAudioQueue = Buffer.alloc(0);     // AI Audio (Mu-Law)
    let inputPcmQueue = Buffer.alloc(0);    // User Audio (PCM 16k)
    let lastInputSample = 0;
    
    // Mixer State
    let bgIndex = 0;
    let outputIntervalId = null;

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream Started!`);

                // 1. Connect to ElevenLabs (Standard 8k)
                // This ensures the AI voice format matches the phone line perfectly.
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => {
                    console.log("[11LABS] Connected");
                    // 2. Start the Heartbeat (20ms)
                    // This runs forever, ensuring background music never pauses.
                    if (!outputIntervalId) {
                        outputIntervalId = setInterval(streamAudioToTwilio, 20);
                    }
                });
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    // SMART FINDER: Locates audio data wherever it hides
                    let chunkData = null;
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        chunkData = aiMsg.audio_event.audio_base64_chunk;
                    } else if (aiMsg.audio_event?.audio) {
                         chunkData = aiMsg.audio_event.audio;
                    }
                    
                    if (chunkData) {
                        const newChunk = Buffer.from(chunkData, 'base64');
                        aiAudioQueue = Buffer.concat([aiAudioQueue, newChunk]);
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    // *** INPUT LOGIC (USER -> SCRIBE) ***
                    // We only boost YOUR voice. We do not touch the background/AI here.
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); // 8k -> 16k upsample

                    for (let i = 0; i < twilioChunk.length; i++) {
                        // Decode & Boost
                        let sample = muLawToLinearTable[twilioChunk[i]];
                        sample = sample * MIC_BOOST;
                        if (sample > 32767) sample = 32767;
                        if (sample < -32768) sample = -32768;

                        // Linear Interpolation (Smoothing)
                        const midPoint = Math.floor((lastInputSample + sample) / 2);
                        pcmChunk.writeInt16LE(midPoint, i * 4);
                        pcmChunk.writeInt16LE(sample, i * 4 + 2);
                        lastInputSample = sample;
                    }

                    inputPcmQueue = Buffer.concat([inputPcmQueue, pcmChunk]);
                    
                    // Send 100ms chunks to Scribe for stability
                    if (inputPcmQueue.length >= 1600) {
                        elevenLabsWs.send(JSON.stringify({ 
                            user_audio_chunk: inputPcmQueue.toString('base64') 
                        }));
                        inputPcmQueue = Buffer.alloc(0);
                    }
                }
            } else if (msg.event === 'stop') {
                if (elevenLabsWs) elevenLabsWs.close();
                clearInterval(outputIntervalId);
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => clearInterval(outputIntervalId));

    // --- THE GOLDEN MIXER ---
    function streamAudioToTwilio() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        
        // Twilio expects exactly 160 bytes (20ms of audio)
        const CHUNK_SIZE = 160; 
        const mixedBuffer = Buffer.alloc(CHUNK_SIZE);
        
        let hasBackground = (backgroundBuffer.length > 0);
        let aiChunk = null;

        // Fetch AI Audio (if available)
        if (aiAudioQueue.length >= CHUNK_SIZE) {
            aiChunk = aiAudioQueue.subarray(0, CHUNK_SIZE);
            aiAudioQueue = aiAudioQueue.subarray(CHUNK_SIZE);
        }

        for (let i = 0; i < CHUNK_SIZE; i++) {
            let finalSample = 0;

            // 1. Add Background
            if (hasBackground) {
                if (bgIndex >= backgroundBuffer.length - 2) bgIndex = 0; // Loop
                const bgSample = backgroundBuffer.readInt16LE(bgIndex);
                bgIndex += 2;
                finalSample += (bgSample * BG_VOLUME);
            }

            // 2. Add AI Voice
            if (aiChunk) {
                // Decode from Mu-Law
                const aiSample = muLawToLinearTable[aiChunk[i]];
                finalSample += (aiSample * AI_VOLUME);
            }

            // 3. Hard Clamp (Prevent Distortion)
            if (finalSample > 32767) finalSample = 32767;
            if (finalSample < -32768) finalSample = -32768;

            // 4. Encode to Mu-Law
            let tableIndex = Math.floor(finalSample) + 32768;
            if (tableIndex < 0) tableIndex = 0;
            if (tableIndex > 65535) tableIndex = 65535;
            
            mixedBuffer[i] = linearToMuLawTable[tableIndex];
        }

        // Send the perfect packet
        ws.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: mixedBuffer.toString('base64') }
        }));
    }
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));
