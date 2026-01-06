// index.js (Algorithmic Mixer: No Lookup Tables, No Beeps)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const BG_VOLUME = 0.05; // 5% Volume

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

// --- AUDIO UTILITIES (The "No-Table" Math) ---

// 1. Decode Mu-Law -> Linear (Standard G.711)
function muLawToLinear(muLawByte) {
    muLawByte = ~muLawByte;
    let sign = (muLawByte & 0x80) >> 7;
    let exponent = (muLawByte & 0x70) >> 4;
    let mantissa = muLawByte & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    return sign === 0 ? -sample : sample;
}

// 2. Encode Linear -> Mu-Law (The Fix: Calculated on fly)
const BIAS = 0x84;
const CLIP = 32635;
function linearToMuLaw(sample) {
    let sign = (sample >> 8) & 0x80;
    if (sign !== 0) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample = sample + BIAS;
    let exponent = 7;
    let mask = 0x4000;
    for (; exponent !== 0; exponent--, mask >>= 1) {
        if ((sample & mask) !== 0) break;
    }
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa);
}

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Algorithmic Server Online"));

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
    let aiLinearQueue = []; 
    let pcmInputQueue = Buffer.alloc(0);
    let lastInputSample = 0;
    let bgIndex = 0;
    
    // Input Boost Setting
    const INPUT_BOOST = 5.0;

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

                elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        // Decode AI Audio (Mu-Law -> Linear)
                        const uLawChunk = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                        for (let i = 0; i < uLawChunk.length; i++) {
                            aiLinearQueue.push(muLawToLinear(uLawChunk[i]));
                        }
                    }
                });
                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                if (!bgBuffer) return;

                // --- 1. HANDLE INPUT (User -> AI) ---
                // Verified Upsampling Logic
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); 

                    for (let i = 0; i < twilioChunk.length; i++) {
                        let sample = muLawToLinear(twilioChunk[i]);
                        
                        // Apply Boost
                        sample = sample * INPUT_BOOST;
                        if (sample > 32767) sample = 32767;
                        if (sample < -32768) sample = -32768;

                        // Upsample 8k -> 16k
                        const midPoint = Math.floor((lastInputSample + sample) / 2);
                        
                        pcmChunk.writeInt16LE(midPoint, i * 4);
                        pcmChunk.writeInt16LE(sample, i * 4 + 2);
                        lastInputSample = sample;
                    }
                    pcmInputQueue = Buffer.concat([pcmInputQueue, pcmChunk]);

                    if (pcmInputQueue.length >= 1600) {
                        elevenLabsWs.send(JSON.stringify({ 
                            user_audio_chunk: pcmInputQueue.toString('base64') 
                        }));
                        pcmInputQueue = Buffer.alloc(0);
                    }
                }

                // --- 2. HANDLE OUTPUT (Music + AI -> User) ---
                const inputLength = Buffer.from(msg.media.payload, 'base64').length; 
                const outputMuLawBuffer = Buffer.alloc(inputLength);

                for (let i = 0; i < inputLength; i++) {
                    // A. Background Music
                    const bgSample = bgBuffer[bgIndex] * BG_VOLUME;
                    bgIndex = (bgIndex + 1) % bgBuffer.length;

                    // B. AI Voice
                    let aiSample = 0;
                    if (aiLinearQueue.length > 0) {
                        aiSample = aiLinearQueue.shift();
                    }

                    // C. Mix
                    let mixed = bgSample + aiSample;

                    // D. CLAMP
                    if (mixed > 32767) mixed = 32767;
                    if (mixed < -32768) mixed = -32768;

                    // E. Encode (Using Algorithm, not Table)
                    // This function handles the sign and magnitude perfectly
                    outputMuLawBuffer[i] = linearToMuLaw(mixed);
                }

                if (streamSid) {
                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: outputMuLawBuffer.toString('base64') }
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
