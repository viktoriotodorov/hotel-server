// index.js (Final Cloud: Studio-Grade Soft Limiter + Auto-Ducking)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Server Online: Studio DSP Active"));

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
const AI_VOL_MULTIPLIER = 1.5; // Boost AI (Safe level)
const INPUT_BOOST = 5.0;       // Boost User (For Scribe)
const DUCK_ATTACK = 0.2;       // How fast music fades OUT (0.0 to 1.0)
const DUCK_RELEASE = 0.05;     // How fast music fades IN (0.0 to 1.0)
const MUSIC_VOL_MAX = 0.15;    // Max Music Volume
const MUSIC_VOL_MIN = 0.02;    // Dimmed Music Volume

// --- DSP: SOFT LIMITER (The Anti-Distortion Filter) ---
// Instead of chopping off the top of the wave, we curve it smoothly.
function softLimit(sample) {
    // Normalize to -1.0 to 1.0 range
    const x = sample / 32768.0;
    
    // Apply Soft Clip (Hyperbolic Tangent)
    // This squashes loud sounds smoothly like analog tape
    const limit = Math.tanh(x);
    
    // Scale back to 16-bit
    return limit * 32768.0;
}

// --- TABLES ---
const muLawToLinearTable_Input = new Int16Array(256); // For Scribe
const muLawToLinearTable_Output = new Int16Array(256); // For User

for (let i = 0; i < 256; i++) {
    let muLawByte = ~i; 
    let sign = (muLawByte & 0x80) >> 7;
    let exponent = (muLawByte & 0x70) >> 4;
    let mantissa = muLawByte & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    sample = sign === 0 ? -sample : sample;

    // Table 1: Input (Boosted 500% for Scribe)
    let inSample = sample * INPUT_BOOST;
    if (inSample > 32767) inSample = 32767;
    if (inSample < -32768) inSample = -32768;
    muLawToLinearTable_Input[i] = inSample;

    // Table 2: Output (Clean for User)
    // We do NOT boost here. We let the Soft Limiter handle loudness later.
    muLawToLinearTable_Output[i] = sample;
}

// Encoder Table
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
let backgroundBuffer = Buffer.alloc(0);
console.log("[SYSTEM] Downloading Background Sound...");
https.get("https://raw.githubusercontent.com/viktoriotodorov/hotel-server/main/lobby.wav", (res) => {
    const data = [];
    res.on('data', chunk => data.push(chunk));
    res.on('end', () => {
        const fullFile = Buffer.concat(data);
        if (fullFile.length > 100) {
            backgroundBuffer = fullFile.subarray(44); 
            console.log(`[SYSTEM] Background Sound Loaded! (${backgroundBuffer.length} bytes)`);
        }
    });
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
    
    // Ducking State (Smooth Fader)
    let currentMusicGain = MUSIC_VOL_MAX;

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
                    if (!outputIntervalId) {
                        outputIntervalId = setInterval(streamAudioToTwilio, 20);
                    }
                });
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    
                    let chunkData = null;
                    if (aiMsg.audio_event) {
                        if (aiMsg.audio_event.audio_base64_chunk) {
                            chunkData = aiMsg.audio_event.audio_base64_chunk;
                        } else if (aiMsg.audio_event.audio) chunkData = aiMsg.audio_event.audio;
                        else {
                            const keys = Object.keys(aiMsg.audio_event);
                            for (const key of keys) {
                                const val = aiMsg.audio_event[key];
                                if (typeof val === 'string' && val.length > 100) {
                                    chunkData = val;
                                    break;
                                }
                            }
                        }
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
                    // INPUT: User -> Scribe (Boosted)
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); 

                    for (let i = 0; i < twilioChunk.length; i++) {
                        const currentSample = muLawToLinearTable_Input[twilioChunk[i]];
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
                clearInterval(outputIntervalId);
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => clearInterval(outputIntervalId));

    // --- STUDIO MIXER ---
    function streamAudioToTwilio() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        
        const CHUNK_SIZE = 160; 
        const mixedBuffer = Buffer.alloc(CHUNK_SIZE);
        let hasBackground = (backgroundBuffer.length > 0);
        let aiChunk = null;

        // Check availability
        if (audioQueue.length >= CHUNK_SIZE) {
            aiChunk = audioQueue.subarray(0, CHUNK_SIZE);
            audioQueue = audioQueue.subarray(CHUNK_SIZE);
        }

        // --- SMOOTH AUTO-DUCKING ---
        // Target is what we WANT the volume to be.
        // Current is what the volume ACTUALLY is.
        // We gently slide Current towards Target.
        const targetGain = aiChunk ? MUSIC_VOL_MIN : MUSIC_VOL_MAX;
        
        if (currentMusicGain > targetGain) {
            // Fade OUT (Attack)
            currentMusicGain -= DUCK_ATTACK * (currentMusicGain - targetGain);
        } else {
            // Fade IN (Release)
            currentMusicGain += DUCK_RELEASE * (targetGain - currentMusicGain);
        }

        for (let i = 0; i < CHUNK_SIZE; i++) {
            let finalSample = 0;

            // 1. Add Background
            if (hasBackground) {
                if (bgIndex >= backgroundBuffer.length - 2) bgIndex = 0;
                const bgSample = backgroundBuffer.readInt16LE(bgIndex);
                bgIndex += 2;
                finalSample += (bgSample * currentMusicGain);
            }

            // 2. Add AI Voice (with moderate multiplier)
            if (aiChunk) {
                const aiSample = muLawToLinearTable_Output[aiChunk[i]];
                finalSample += (aiSample * AI_VOL_MULTIPLIER);
            }

            // 3. SOFT LIMITER (The Magic Fix)
            // Curves the audio so it never "cracks", even if volume is 200%
            finalSample = softLimit(finalSample);

            // 4. Convert to Mu-Law
            // Offset to positive for array index lookup
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
