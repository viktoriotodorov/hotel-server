// index.js (Final Fix: Working Input + Correct Output Mixing)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const alawmulaw = require('alawmulaw'); 

const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const BG_VOLUME = 0.05; // Reduced to 5% (Much quieter)
const CHUNK_SIZE = 160; // 20ms of audio

// --- LOAD BACKGROUND AUDIO ---
let bgBuffer = null;
try {
    const filePath = path.join(__dirname, 'background.wav');
    const fileData = fs.readFileSync(filePath);
    const rawBuffer = fileData.subarray(44); 
    bgBuffer = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2);
    console.log(`[SYSTEM] Background audio loaded: ${bgBuffer.length} samples`);
} catch (err) {
    console.error("[SYSTEM] Failed to load background.wav", err.message);
}

// --- INPUT LOGIC (Keep this, it works!) ---
const muLawToLinearTable = new Int16Array(256);
const VOLUME_BOOST = 5.0; 
for (let i = 0; i < 256; i++) {
    let muLawByte = ~i; 
    let sign = (muLawByte & 0x80) >> 7;
    let exponent = (muLawByte & 0x70) >> 4;
    let mantissa = muLawByte & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    sample = sign === 0 ? -sample : sample;
    sample = sample * VOLUME_BOOST;
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;
    muLawToLinearTable[i] = sample;
}

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Server Online"));

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

wss.on('connection', (ws) => {
    console.log("[TWILIO] Client Connected");
    
    let elevenLabsWs = null;
    let streamSid = null;
    
    // Buffers
    let audioQueue = []; // Changed to Array for easier popping
    let pcmInputQueue = Buffer.alloc(0);
    let lastInputSample = 0;
    
    // Mixer State
    let bgIndex = 0;
    let mixerInterval = null;

    // --- MIXER FUNCTION (The Fix) ---
    const tickMixer = () => {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        if (!bgBuffer) return;

        // 1. Prepare Output Buffer (Linear PCM)
        const outputSamples = new Int16Array(CHUNK_SIZE);
        
        // 2. Decode enough AI audio for this tick (if available)
        let aiLinearChunk = null;
        if (audioQueue.length >= CHUNK_SIZE) {
            // Take exactly 160 bytes (samples) from the queue
            const aiChunkBytes = Buffer.from(audioQueue.splice(0, CHUNK_SIZE));
            // Decode u-law -> Linear PCM
            aiLinearChunk = alawmulaw.mulaw.decode(aiChunkBytes);
        }

        // 3. MIX LOOP
        for (let i = 0; i < CHUNK_SIZE; i++) {
            // Background Sample (Quieter)
            const bgSample = bgBuffer[bgIndex] * BG_VOLUME;
            bgIndex = (bgIndex + 1) % bgBuffer.length;

            // AI Sample (or 0 if not talking)
            const aiSample = aiLinearChunk ? aiLinearChunk[i] : 0;

            // Mix
            let mixed = bgSample + aiSample;

            // Clamp
            outputSamples[i] = Math.max(-32768, Math.min(32767, mixed));
        }

        // 4. Encode & Send
        const muLawResponse = alawmulaw.mulaw.encode(outputSamples);
        const payload = Buffer.from(muLawResponse).toString('base64');

        ws.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: payload }
        }));
    };

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream Started!`);
                
                // Start Mixer (20ms)
                mixerInterval = setInterval(tickMixer, 20);

                // Connect to ElevenLabs (Force u-law 8000Hz Output)
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        // Received audio from AI (u-law base64)
                        const newChunk = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                        // Push bytes into the array queue
                        for (let i = 0; i < newChunk.length; i++) {
                            audioQueue.push(newChunk[i]);
                        }
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    // --- INPUT LOGIC (Upsampling 8k -> 16k) ---
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); 

                    for (let i = 0; i < twilioChunk.length; i++) {
                        const currentSample = muLawToLinearTable[twilioChunk[i]];
                        const midPoint = Math.floor((lastInputSample + currentSample) / 2);
                        pcmChunk.writeInt16LE(midPoint, i * 4);
                        pcmChunk.writeInt16LE(currentSample, i * 4 + 2);
                        lastInputSample = currentSample;
                    }

                    pcmInputQueue = Buffer.concat([pcmInputQueue, pcmChunk]);

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
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => clearInterval(mixerInterval));
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));
