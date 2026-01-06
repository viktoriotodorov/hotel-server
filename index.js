// index.js (Final Cloud: Linear PCM High-Fidelity Mixer)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Server Online: Linear PCM Mixer Active"));

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

// --- CONFIGURATION ---
const BG_VOLUME = 0.10;   // Background Volume (10%)
const AI_VOLUME = 1.0;    // AI Volume (100% - No Boost needed for PCM)
const INPUT_BOOST = 3.0;  // Microphone Boost (300% for Scribe)

// --- 1. TABLES (For Input Processing Only) ---
// We only need MuLaw decoder for YOUR voice. 
// The AI will now send us RAW PCM, so we don't need to decode it.
const muLawToLinearTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
    let muLawByte = ~i; 
    let sign = (muLawByte & 0x80) >> 7;
    let exponent = (muLawByte & 0x70) >> 4;
    let mantissa = muLawByte & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    sample = sign === 0 ? -sample : sample;
    
    // Apply Input Boost here
    let boosted = sample * INPUT_BOOST;
    if (boosted > 32767) boosted = 32767;
    if (boosted < -32768) boosted = -32768;
    muLawToLinearTable[i] = boosted;
}

// --- 2. ENCODER (Linear -> MuLaw) ---
// Used for the final mix sent to Twilio
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

// --- BACKGROUND LOADER ---
// Must be S16LE 8000Hz Mono WAV
let backgroundBuffer = Buffer.alloc(0);
console.log("[SYSTEM] Downloading Background Sound...");
https.get("https://raw.githubusercontent.com/viktoriotodorov/hotel-server/main/lobby.wav", (res) => {
    const data = [];
    res.on('data', chunk => data.push(chunk));
    res.on('end', () => {
        const fullFile = Buffer.concat(data);
        if (fullFile.length > 100) {
            backgroundBuffer = fullFile.subarray(44); // Skip WAV Header
            console.log(`[SYSTEM] Background Sound Loaded! (${backgroundBuffer.length} bytes)`);
        }
    });
}).on('error', err => console.log("[SYSTEM] No Background Sound found."));


wss.on('connection', (ws) => {
    console.log("[TWILIO] Client Connected");
    
    let elevenLabsWs = null;
    let streamSid = null;
    
    // Buffers
    let aiPcmQueue = Buffer.alloc(0);     // 16kHz PCM from AI
    let inputPcmQueue = Buffer.alloc(0);  // 16kHz PCM to Scribe
    
    let lastInputSample = 0;
    let bgIndex = 0;
    let outputIntervalId = null;

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream Started!`);

                // *** CRITICAL CHANGE: Request PCM 16000Hz ***
                // We ask for Raw Audio (PCM), not Telephone Audio (MuLaw)
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=pcm_16000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => {
                    console.log("[11LABS] Connected");
                    // Start the Mix Timer immediately (20ms)
                    if (!outputIntervalId) {
                        outputIntervalId = setInterval(streamAudioToTwilio, 20);
                    }
                });
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    
                    let chunkData = null;
                    // Handle various JSON structures
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        chunkData = aiMsg.audio_event.audio_base64_chunk;
                    } else if (aiMsg.audio_event?.audio) {
                         chunkData = aiMsg.audio_event.audio;
                    }

                    if (chunkData) {
                        // This is now PCM 16000Hz (Raw Audio)
                        const newChunk = Buffer.from(chunkData, 'base64');
                        aiPcmQueue = Buffer.concat([aiPcmQueue, newChunk]);
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    // *** INPUT: USER -> SCRIBE ***
                    // 1. Decode Twilio MuLaw -> Linear
                    // 2. Upsample 8k -> 16k
                    // 3. Send to Scribe
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); 

                    for (let i = 0; i < twilioChunk.length; i++) {
                        const currentSample = muLawToLinearTable[twilioChunk[i]];
                        const midPoint = Math.floor((lastInputSample + currentSample) / 2);
                        
                        pcmChunk.writeInt16LE(midPoint, i * 4);
                        pcmChunk.writeInt16LE(currentSample, i * 4 + 2);
                        lastInputSample = currentSample;
                    }

                    inputPcmQueue = Buffer.concat([inputPcmQueue, pcmChunk]);
                    
                    if (inputPcmQueue.length >= 3200) { // 100ms buffer
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

    // --- THE MIXER (PCM 16k -> PCM 8k + BG -> MuLaw) ---
    function streamAudioToTwilio() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        
        // We need 160 samples (20ms @ 8000Hz)
        const OUTPUT_SIZE = 160; 
        const mixedBuffer = Buffer.alloc(OUTPUT_SIZE);
        
        let hasBackground = (backgroundBuffer.length > 0);
        
        // Calculate needed AI samples: 20ms @ 16000Hz = 320 samples (640 bytes)
        const AI_NEEDED_BYTES = 640; 
        let aiChunk = null;

        if (aiPcmQueue.length >= AI_NEEDED_BYTES) {
            aiChunk = aiPcmQueue.subarray(0, AI_NEEDED_BYTES);
            aiPcmQueue = aiPcmQueue.subarray(AI_NEEDED_BYTES);
        }

        for (let i = 0; i < OUTPUT_SIZE; i++) {
            let finalSample = 0;

            // 1. MIX BACKGROUND (PCM 8000Hz)
            if (hasBackground) {
                if (bgIndex >= backgroundBuffer.length - 2) bgIndex = 0;
                const bgSample = backgroundBuffer.readInt16LE(bgIndex);
                bgIndex += 2;
                finalSample += (bgSample * BG_VOLUME);
            }

            // 2. MIX AI (Downsample 16k -> 8k)
            if (aiChunk) {
                // To get 8k from 16k, we take every 2nd sample (Decimation)
                // 16k Index: 0, 2, 4, 6...
                const aiIndex = i * 4; // 2 bytes * 2 steps
                const aiSample = aiChunk.readInt16LE(aiIndex);
                
                finalSample += (aiSample * AI_VOLUME);
            }

            // 3. CLAMP (Hard Limit)
            if (finalSample > 32767) finalSample = 32767;
            if (finalSample < -32768) finalSample = -32768;

            // 4. ENCODE TO MULAW
            let tableIndex = Math.floor(finalSample) + 32768;
            if (tableIndex < 0) tableIndex = 0;
            if (tableIndex > 65535) tableIndex = 65535;
            
            mixedBuffer[i] = linearToMuLawTable[tableIndex];
        }

        ws.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: mixedBuffer.toString('base64') }
        }));
    }
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));
