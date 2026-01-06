// index.js (Hybrid: Old Input Logic + Background Music Mixer)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const alawmulaw = require('alawmulaw'); 

const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const BG_VOLUME = 0.1; // 10% Background Volume
const CHUNK_SIZE = 160; // Twilio expects 160 bytes (20ms)

// --- LOAD BACKGROUND AUDIO ---
let bgBuffer = null;
try {
    const filePath = path.join(__dirname, 'background.wav');
    const fileData = fs.readFileSync(filePath);
    // Remove 44-byte Header to avoid "Pop"
    const rawBuffer = fileData.subarray(44); 
    bgBuffer = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2);
    console.log(`[SYSTEM] Background audio loaded: ${bgBuffer.length} samples`);
} catch (err) {
    console.error("[SYSTEM] Failed to load background.wav", err.message);
}

// --- YOUR OLD MANUAL LOOKUP TABLE (Restored) ---
// This ensures the AI hears you loudly and clearly.
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
    // Clamp
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;
    muLawToLinearTable[i] = sample;
}

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Hybrid Server Online"));

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
    let audioQueue = Buffer.alloc(0); // AI Audio (u-law)
    let pcmInputQueue = Buffer.alloc(0); // Mic Input (Linear)
    let lastInputSample = 0;
    
    // Mixer State
    let bgIndex = 0;
    let mixerInterval = null;

    // --- MIXER FUNCTION ---
    // Runs every 20ms. Plays Music + AI (if available)
    const tickMixer = () => {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        if (!bgBuffer) return;

        // 1. Get Background Music Samples (Linear PCM)
        const outputSamples = new Int16Array(CHUNK_SIZE);
        for (let i = 0; i < CHUNK_SIZE; i++) {
            outputSamples[i] = bgBuffer[bgIndex] * BG_VOLUME;
            bgIndex = (bgIndex + 1) % bgBuffer.length;
        }

        // 2. Mix with AI Audio (if we have enough data)
        if (audioQueue.length >= CHUNK_SIZE) {
            // Extract chunk
            const aiChunk = audioQueue.subarray(0, CHUNK_SIZE);
            audioQueue = audioQueue.subarray(CHUNK_SIZE);

            // Decode u-law -> Linear PCM (Using library for simplicity here)
            const aiLinear = alawmulaw.mulaw.decode(aiChunk);

            // Add to background
            for (let i = 0; i < CHUNK_SIZE; i++) {
                let mixed = outputSamples[i] + aiLinear[i];
                // Clamp
                outputSamples[i] = Math.max(-32768, Math.min(32767, mixed));
            }
        }

        // 3. Encode to u-law and Send to Twilio
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
                
                // Start the heartbeat mixer immediately (Music starts now)
                mixerInterval = setInterval(tickMixer, 20);

                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        const newChunk = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                        audioQueue = Buffer.concat([audioQueue, newChunk]);
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    // --- RESTORED: YOUR EXACT UPSAMPLING LOGIC ---
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); 

                    for (let i = 0; i < twilioChunk.length; i++) {
                        // 1. Decode using your boosted table
                        const currentSample = muLawToLinearTable[twilioChunk[i]];
                        
                        // 2. Interpolate (Upsample 8k -> 16k)
                        const midPoint = Math.floor((lastInputSample + currentSample) / 2);
                        
                        // 3. Write two samples
                        pcmChunk.writeInt16LE(midPoint, i * 4);
                        pcmChunk.writeInt16LE(currentSample, i * 4 + 2);
                        
                        lastInputSample = currentSample;
                    }

                    pcmInputQueue = Buffer.concat([pcmInputQueue, pcmChunk]);

                    // Send to ElevenLabs (1600 bytes = 50ms of 16k audio)
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
