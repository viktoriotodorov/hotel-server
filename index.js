// index.js (Manual Mixing + Twilio Sync + Upsampling Input)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const BG_VOLUME = 0.01; // 1% Volume (Start extremely low to test)

// --- LOAD BACKGROUND AUDIO ---
let bgBuffer = null;
try {
    const filePath = path.join(__dirname, 'background.wav');
    const fileData = fs.readFileSync(filePath);
    // Remove 44-byte Header
    const rawBuffer = fileData.subarray(44); 
    bgBuffer = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2);
    console.log(`[SYSTEM] Background audio loaded: ${bgBuffer.length} samples`);
} catch (err) {
    console.error("[SYSTEM] Failed to load background.wav", err.message);
}

// --- MANUAL LOOKUP TABLES (No Libraries) ---

// 1. Mu-Law to Linear (For Input & AI Decoding)
const muLawToLinearTable = new Int16Array(256);
const VOLUME_BOOST = 5.0; // Input boost for AI
for (let i = 0; i < 256; i++) {
    let muLawByte = ~i; 
    let sign = (muLawByte & 0x80) >> 7;
    let exponent = (muLawByte & 0x70) >> 4;
    let mantissa = muLawByte & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    sample = sign === 0 ? -sample : sample;
    // Note: We apply boost only when reading input, not here globally
    muLawToLinearTable[i] = sample; 
}

// 2. Linear to Mu-Law (For Output Encoding)
const linearToMuLawTable = new Int8Array(65536); // Maps -32768..32767 to mu-law byte
for (let i = -32768; i < 32768; i++) {
    let sample = i;
    let sign = (sample < 0) ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    sample = sample + 33;
    if (sample > 8192) sample = 8192;
    let exponent = Math.floor(Math.log(sample) / Math.log(2)) - 5;
    if (exponent < 0) exponent = 0;
    let mantissa = (sample >> (exponent + 1)) & 0x0F;
    let muLawByte = ~(sign | (exponent << 4) | mantissa);
    // Index offset by 32768 to handle negative array indices
    linearToMuLawTable[i + 32768] = muLawByte;
}

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Ultimate Sync Server Online"));

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
    
    // Audio State
    let aiLinearQueue = []; // Holds DECODED Linear PCM samples from AI
    let pcmInputQueue = Buffer.alloc(0); // For buffering input to AI
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
                        // 1. Receive u-law chunk
                        const uLawChunk = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                        
                        // 2. IMMEDIATELY Decode to Linear PCM and store
                        // This prevents any "u-law in the mixer" errors later
                        for (let i = 0; i < uLawChunk.length; i++) {
                            const uLawByte = uLawChunk[i];
                            const linearSample = muLawToLinearTable[uLawByte];
                            aiLinearQueue.push(linearSample);
                        }
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                if (!bgBuffer) return; // Wait for background file load

                // --- 1. HANDLE INPUT (User -> AI) ---
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    // Upsample 8k -> 16k + Boost
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); 
                    for (let i = 0; i < twilioChunk.length; i++) {
                        // Decode & Boost
                        let sample = muLawToLinearTable[twilioChunk[i]] * VOLUME_BOOST;
                        // Clamp
                        if (sample > 32767) sample = 32767;
                        if (sample < -32768) sample = -32768;
                        
                        // Upsample (Linear Interpolation)
                        const midPoint = Math.floor((lastInputSample + sample) / 2);
                        
                        pcmChunk.writeInt16LE(midPoint, i * 4);
                        pcmChunk.writeInt16LE(sample, i * 4 + 2);
                        lastInputSample = sample;
                    }
                    pcmInputQueue = Buffer.concat([pcmInputQueue, pcmChunk]);

                    // Send to AI (buffered)
                    if (pcmInputQueue.length >= 1600) {
                        elevenLabsWs.send(JSON.stringify({ 
                            user_audio_chunk: pcmInputQueue.toString('base64') 
                        }));
                        pcmInputQueue = Buffer.alloc(0);
                    }
                }

                // --- 2. HANDLE OUTPUT (AI + Music -> User) ---
                // We use the INPUT packet size to determine the OUTPUT packet size.
                // This keeps everything perfectly synchronized.
                const inputLength = Buffer.from(msg.media.payload, 'base64').length; 
                // In u-law 8000Hz, 1 byte = 1 sample.
                const neededSamples = inputLength; 

                const outputMuLawBuffer = Buffer.alloc(neededSamples);

                for (let i = 0; i < neededSamples; i++) {
                    // A. Get Background Sample
                    const bgSample = bgBuffer[bgIndex] * BG_VOLUME;
                    bgIndex = (bgIndex + 1) % bgBuffer.length;

                    // B. Get AI Sample (if available)
                    let aiSample = 0;
                    if (aiLinearQueue.length > 0) {
                        aiSample = aiLinearQueue.shift();
                    }

                    // C. Mix
                    let mixed = bgSample + aiSample;
                    // Clamp
                    if (mixed > 32767) mixed = 32767;
                    if (mixed < -32768) mixed = -32768;

                    // D. Encode to Mu-Law (Using Manual Table)
                    // Offset index by 32768 for the table lookup
                    outputMuLawBuffer[i] = linearToMuLawTable[Math.floor(mixed) + 32768];
                }

                // Send Response immediately
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
