// index.js (Perfected: Split-Path Audio + Pro WAV Parsing)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const wav = require('wav'); // Helper for clean audio

const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const BG_VOLUME = 0.10; // 10% Background Volume
const INPUT_BOOST = 5.0; // Boost Mic ONLY

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Server Online: Split-Path Mode"));

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

// --- TABLE 1: INPUT DECODER (BOOSTED) ---
// We use this ONLY for audio going TO the AI (Microphone)
const inputTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
    let muLawByte = ~i; 
    let sign = (muLawByte & 0x80) >> 7;
    let exponent = (muLawByte & 0x70) >> 4;
    let mantissa = muLawByte & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    sample = sign === 0 ? -sample : sample;
    
    // APPLY BOOST HERE
    sample = sample * INPUT_BOOST;
    
    // Clamp
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;
    inputTable[i] = sample;
}

// --- TABLE 2: OUTPUT DECODER (NORMAL) ---
// We use this for audio coming FROM the AI (Speaker)
// This prevents the "Double Boost" distortion bug
const outputTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
    let muLawByte = ~i; 
    let sign = (muLawByte & 0x80) >> 7;
    let exponent = (muLawByte & 0x70) >> 4;
    let mantissa = muLawByte & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    sample = sign === 0 ? -sample : sample;
    // NO BOOST applied here
    outputTable[i] = sample;
}

// --- ENCODER: LINEAR TO MU-LAW ---
const linearToMuLaw = (sample) => {
    const BIAS = 0x84;
    const CLIP = 32635;
    sample = (sample < -CLIP) ? -CLIP : (sample > CLIP) ? CLIP : sample;
    const sign = (sample < 0) ? 0x80 : 0;
    sample = (sample < 0) ? -sample : sample;
    sample += BIAS;
    let exponent = 7;
    let exponent_bits = 0;
    for (let exp = 0; exp < 8; exp++) {
        if (sample < (1 << (exp + 5))) {
            exponent = exp;
            break;
        }
    }
    const mantissa_bits = (sample >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa_bits) & 0xFF;
};

// --- BACKGROUND LOADER (Robust WAV Parser) ---
let backgroundBuffer = Buffer.alloc(0);
console.log("[SYSTEM] Downloading Background Sound...");
https.get("https://raw.githubusercontent.com/viktoriotodorov/hotel-server/main/background.wav", (res) => {
    const reader = new wav.Reader();
    
    reader.on('format', (format) => {
        console.log(`[SYSTEM] WAV Format: ${format.sampleRate}Hz ${format.bitDepth}-bit`);
        reader.on('data', (chunk) => {
            backgroundBuffer = Buffer.concat([backgroundBuffer, chunk]);
        });
        reader.on('end', () => {
            // Convert to Int16Array for faster mixing math
            const temp = new Int16Array(backgroundBuffer.buffer, backgroundBuffer.byteOffset, backgroundBuffer.length / 2);
            // Re-assign to a Buffer-like structure for the mixer logic
            // Or just keep it as a buffer of bytes? 
            // Let's keep your logic: buffer of bytes, readInt16LE
            console.log(`[SYSTEM] Background Sound Loaded! (${backgroundBuffer.length} bytes)`);
        });
    });

    res.pipe(reader); // Pipe the download directly into the parser
}).on('error', err => console.log("[SYSTEM] No Background Sound found."));


wss.on('connection', (ws) => {
    console.log("[TWILIO] Client Connected");
    
    let elevenLabsWs = null;
    let streamSid = null;
    let audioQueue = Buffer.alloc(0); 
    let pcmInputQueue = Buffer.alloc(0);
    let lastInputSample = 0;
    let bgIndex = 0;
    let outputIntervalId = null;

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream Started!`);

                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => {
                    console.log("[11LABS] Connected");
                    // Start Heartbeat
                    if (!outputIntervalId) {
                        outputIntervalId = setInterval(streamAudioToTwilio, 20);
                    }
                });
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    let chunkData = null;
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        chunkData = aiMsg.audio_event.audio_base64_chunk;
                    }
                    if (chunkData) {
                        const newChunk = Buffer.from(chunkData, 'base64');
                        audioQueue = Buffer.concat([audioQueue, newChunk]);
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    // --- INPUT PROCESSING (Mic -> AI) ---
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); 

                    for (let i = 0; i < twilioChunk.length; i++) {
                        // 1. USE INPUT TABLE (BOOSTED)
                        const currentSample = inputTable[twilioChunk[i]];
                        
                        // 2. Upsample 8k -> 16k
                        const midPoint = Math.floor((lastInputSample + currentSample) / 2);
                        pcmChunk.writeInt16LE(midPoint, i * 4);
                        pcmChunk.writeInt16LE(currentSample, i * 4 + 2);
                        lastInputSample = currentSample;
                    }

                    pcmInputQueue = Buffer.concat([pcmInputQueue, pcmChunk]);

                    // Send 50ms chunks to ElevenLabs
                    if (pcmInputQueue.length >= 1600) {
                        elevenLabsWs.send(JSON.stringify({ 
                            user_audio_chunk: pcmInputQueue.toString('base64') 
                        }));
                        pcmInputQueue = Buffer.alloc(0);
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

    // --- HEARTBEAT MIXER (Output to Speaker) ---
    function streamAudioToTwilio() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        
        const CHUNK_SIZE = 160; 
        const mixedBuffer = Buffer.alloc(CHUNK_SIZE);

        // 1. Get Background Sound (Cleanly parsed)
        let hasBackground = (backgroundBuffer.length > 0);

        // 2. Get AI Audio
        let aiChunk = null;
        if (audioQueue.length >= CHUNK_SIZE) {
            aiChunk = audioQueue.subarray(0, CHUNK_SIZE);
            audioQueue = audioQueue.subarray(CHUNK_SIZE);
        }

        // 3. Mix Loop
        for (let i = 0; i < CHUNK_SIZE; i++) {
            let sample = 0;

            // Add Background
            if (hasBackground) {
                if (bgIndex >= backgroundBuffer.length - 2) bgIndex = 0;
                const bgSample = backgroundBuffer.readInt16LE(bgIndex);
                bgIndex += 2;
                sample += (bgSample * BG_VOLUME);
            }

            // Add AI Voice
            if (aiChunk) {
                // USE OUTPUT TABLE (NORMAL VOLUME)
                // This fixes the distortion!
                const aiSample = outputTable[aiChunk[i]];
                sample += aiSample;
            }

            // Encode & Send
            mixedBuffer[i] = linearToMuLaw(sample);
        }

        ws.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: mixedBuffer.toString('base64') }
        }));
    }
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));
