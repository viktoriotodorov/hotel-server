// index.js (Mu-Law Native Mixer - Fixes "Siren" Issue)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const BG_VOLUME = 0.1; // 10% Volume

// --- LOAD BACKGROUND AUDIO ---
let bgBuffer = null;
try {
    const filePath = path.join(__dirname, 'background.wav');
    const fileData = fs.readFileSync(filePath);
    const rawBuffer = fileData.subarray(44); 
    // Load as Int16 Little Endian
    bgBuffer = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2);
    console.log(`[SYSTEM] Background audio loaded: ${bgBuffer.length} samples`);
} catch (err) {
    console.error("[SYSTEM] Failed to load background.wav", err.message);
}

// --- TABLES ---
const muLawToLinearTable = new Int16Array(256);
const linearToMuLawTable = new Int8Array(65536);
const INPUT_BOOST = 5.0; // Boost only for input to AI

// Decode Table
for (let i = 0; i < 256; i++) {
    let muLawByte = ~i; 
    let sign = (muLawByte & 0x80) >> 7;
    let exponent = (muLawByte & 0x70) >> 4;
    let mantissa = muLawByte & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    sample = sign === 0 ? -sample : sample;
    muLawToLinearTable[i] = sample; 
}

// Encode Table
for (let i = -32768; i < 32768; i++) {
    let sample = (i < 0) ? -i : i;
    let sign = (i < 0) ? 0x80 : 0;
    sample += 33;
    if (sample > 8192) sample = 8192;
    let exponent = Math.floor(Math.log(sample) / Math.log(2)) - 5;
    if (exponent < 0) exponent = 0;
    let mantissa = (sample >> (exponent + 1)) & 0x0F;
    let muLawByte = ~(sign | (exponent << 4) | mantissa);
    linearToMuLawTable[i + 32768] = muLawByte;
}

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Fixed Mixer Server"));

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
                        const uLawChunk = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                        for (let i = 0; i < uLawChunk.length; i++) {
                            // Decode normal (no boost)
                            aiLinearQueue.push(muLawToLinearTable[uLawChunk[i]]);
                        }
                    }
                });
                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                if (!bgBuffer) return;

                // 1. INPUT (User -> AI) - Upsampling Logic
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); 

                    for (let i = 0; i < twilioChunk.length; i++) {
                        let sample = muLawToLinearTable[twilioChunk[i]];
                        // Apply Input Boost Here
                        sample = sample * INPUT_BOOST;
                        if (sample > 32767) sample = 32767;
                        if (sample < -32768) sample = -32768;

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

                // 2. OUTPUT (Music + AI -> User)
                const inputLength = Buffer.from(msg.media.payload, 'base64').length; 
                const outputMuLawBuffer = Buffer.alloc(inputLength);

                for (let i = 0; i < inputLength; i++) {
                    // Background
                    const bgSample = bgBuffer[bgIndex] * BG_VOLUME;
                    bgIndex = (bgIndex + 1) % bgBuffer.length;

                    // AI
                    let aiSample = 0;
                    if (aiLinearQueue.length > 0) aiSample = aiLinearQueue.shift();

                    // Mix
                    let mixed = bgSample + aiSample;

                    // CLAMP (Safety)
                    if (mixed > 32767) mixed = 32767;
                    if (mixed < -32768) mixed = -32768;

                    // Re-Encode
                    outputMuLawBuffer[i] = linearToMuLawTable[Math.floor(mixed) + 32768];
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
