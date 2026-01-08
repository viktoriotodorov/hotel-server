const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ==================== SETTINGS ====================
const BG_VOLUME = 0.08;     // 8% Volume (Applied during load)
const AI_VOLUME = 1.0;      // 100% AI Volume
const MIC_BOOST = 5.0;      // Boost user input so AI hears you

// Global Background Audio Buffer
let BACKGROUND_PCM = null;

// ==================== G.711 Mu-Law TABLES ====================
const muLawToLinearTable = new Int16Array(256);
const linearToMuLawTable = new Uint8Array(65536);
const BIAS = 0x84;
const CLIP = 32635;

// Generate Mu-Law to Linear Table
for (let i = 0; i < 256; i++) {
    let mu = ~i;
    let sign = (mu & 0x80) >> 7;
    let exponent = (mu & 0x70) >> 4;
    let mantissa = mu & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    muLawToLinearTable[i] = sign === 0 ? -sample : sample;
}

// Generate Linear to Mu-Law Table
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
    linearToMuLawTable[i] = ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// ==================== HELPER FUNCTIONS (NOW INCLUDED) ====================
function muLawToLinear(buffer) {
    const pcm = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
        pcm[i] = muLawToLinearTable[buffer[i]];
    }
    return pcm;
}

function linearToMuLaw(pcmBuffer) {
    const muLaw = new Uint8Array(pcmBuffer.length);
    for (let i = 0; i < pcmBuffer.length; i++) {
        let sample = pcmBuffer[i];
        let index = sample + 32768;
        if (index < 0) index = 0;
        if (index > 65535) index = 65535;
        muLaw[i] = linearToMuLawTable[index];
    }
    return muLaw;
}

function upsample8kTo16k(pcm8k) {
    const length = pcm8k.length;
    const pcm16k = new Int16Array(length * 2);
    for (let i = 0; i < length; i++) {
        pcm16k[i * 2] = pcm8k[i];
        pcm16k[i * 2 + 1] = pcm8k[i];
    }
    return pcm16k;
}

function boostAudio(pcmSamples) {
    const length = pcmSamples.length;
    const boosted = new Int16Array(length);
    for (let i = 0; i < length; i++) {
        let sample = pcmSamples[i] * MIC_BOOST;
        if (sample > 32767) sample = 32767;
        if (sample < -32768) sample = -32768;
        boosted[i] = sample;
    }
    return boosted;
}

function mixAudio(aiPcm, bgPcm, bgPosition) {
    const length = aiPcm.length;
    const mixed = new Int16Array(length);
    for (let i = 0; i < length; i++) {
        const bgIndex = (bgPosition + i) % bgPcm.length;
        // Mix AI (Boosted) + Background (Pre-Scaled)
        let mixedSample = (aiPcm[i] * AI_VOLUME) + bgPcm[bgIndex];
        
        // Clamp
        if (mixedSample > 32767) mixedSample = 32767;
        if (mixedSample < -32768) mixedSample = -32768;
        mixed[i] = mixedSample;
    }
    return mixed;
}

// ==================== BACKGROUND LOADER ====================
async function loadBackgroundSound() {
    return new Promise((resolve, reject) => {
        console.log('[SYSTEM] Loading RAW background audio...');
        // Using the .raw file which is headerless 16-bit PCM
        const req = https.get(
            "https://raw.githubusercontent.com/viktoriotodorov/hotel-server/main/backgroundn.raw",
            (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    try {
                        const buffer = Buffer.concat(chunks);
                        if (buffer.length < 1000) {
                            console.error("[ERROR] File too small.");
                            resolve(); return;
                        }

                        const sampleCount = buffer.length / 2;
                        const pcmData = new Int16Array(sampleCount);
                        
                        // PRE-SCALE VOLUME (Optimization)
                        for (let i = 0; i < sampleCount; i++) {
                            pcmData[i] = buffer.readInt16LE(i * 2) * BG_VOLUME;
                        }
                        
                        BACKGROUND_PCM = pcmData;
                        console.log(`[SYSTEM] Background loaded: ${pcmData.length} samples`);
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                });
            }
        );
        req.on('error', reject);
    });
}

// ==================== SERVER ROUTES ====================
app.use(express.urlencoded({ extended: true }));

app.post('/incoming-call', (req, res) => {
    console.log(`[TWILIO] Incoming call: ${req.body.CallSid}`);
    // <Connect> keeps the call open. No <Pause> needed.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Please wait while we connect you to the assistant.</Say>
    <Connect>
        <Stream url="wss://${req.headers.host}/media" />
    </Connect>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
});

// ==================== WEBSOCKET ====================
wss.on('connection', (ws, req) => {
    if (req.url !== '/media') { ws.close(); return; }
    
    console.log('[TWILIO] Media Socket connected');
    
    let elevenLabsWs = null;
    let streamSid = null;
    let aiAudioQueue = [];
    let bgAudioIndex = 0;
    const MAX_QUEUE_SIZE = 50;
    
    function connectToElevenLabs() {
        // Output format: u-law 8000Hz (matches Phone)
        const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
        elevenLabsWs = new WebSocket(url, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
        
        elevenLabsWs.on('open', () => {
            console.log('[11LABS] Connected');
        });
        
        elevenLabsWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                if (msg.audio_event?.audio_base64_chunk) {
                    const audioChunk = Buffer.from(msg.audio_event.audio_base64_chunk, 'base64');
                    if (aiAudioQueue.length < MAX_QUEUE_SIZE) {
                        aiAudioQueue.push(audioChunk);
                    }
                }
            } catch (err) { console.error('[11LABS] Parse Error:', err); }
        });
        
        elevenLabsWs.on('error', (err) => console.error('[11LABS] Error:', err.message));
        elevenLabsWs.on('close', () => console.log('[11LABS] Disconnected'));
    }
    
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        
        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;
            console.log(`[TWILIO] Stream started: ${streamSid}`);
            connectToElevenLabs();
            
        } else if (msg.event === 'media' && BACKGROUND_PCM) {
            // A. INPUT: User -> AI
            const userAudioMuLaw = Buffer.from(msg.media.payload, 'base64');
            const userAudioPCM = muLawToLinear(userAudioMuLaw);
            const boostedPCM = boostAudio(userAudioPCM);
            const audioForAI = upsample8kTo16k(boostedPCM);
            
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const pcmBuffer = Buffer.from(audioForAI.buffer);
                // Correct Message Type
                elevenLabsWs.send(JSON.stringify({
                    type: 'user_audio_chunk',
                    audio_base64_chunk: pcmBuffer.toString('base64')
                }));
            }
            
            // B. OUTPUT: AI + BG -> User
            let finalAudioPCM;
            if (aiAudioQueue.length > 0) {
                // AI is speaking: Mix AI + BG
                const aiAudioMuLaw = aiAudioQueue.shift();
                const aiAudioPCM = muLawToLinear(aiAudioMuLaw);
                finalAudioPCM = mixAudio(aiAudioPCM, BACKGROUND_PCM, bgAudioIndex);
                bgAudioIndex = (bgAudioIndex + aiAudioPCM.length) % BACKGROUND_PCM.length;
            } else {
                // AI is silent: Play BG only
                const chunkSize = 160;
                finalAudioPCM = new Int16Array(chunkSize);
                for (let i = 0; i < chunkSize; i++) {
                    finalAudioPCM[i] = BACKGROUND_PCM[(bgAudioIndex + i) % BACKGROUND_PCM.length];
                }
                bgAudioIndex = (bgAudioIndex + chunkSize) % BACKGROUND_PCM.length;
            }
            
            const finalAudioMuLaw = linearToMuLaw(finalAudioPCM);
            const response = {
                streamSid: streamSid,
                event: 'media',
                media: { payload: Buffer.from(finalAudioMuLaw).toString('base64') }
            };
            ws.send(JSON.stringify(response));
            
        } else if (msg.event === 'stop') {
            console.log(`[TWILIO] Stream ended: ${streamSid}`);
            if (elevenLabsWs) elevenLabsWs.close();
        }
    });
    
    ws.on('close', () => {
        console.log('[TWILIO] Socket closed');
        if (elevenLabsWs) elevenLabsWs.close();
    });
});

server.listen(PORT, async () => {
    console.log(`[SYSTEM] Server running on port ${PORT}`);
    try {
        await loadBackgroundSound();
        console.log('[SYSTEM] Ready.');
    } catch (err) {
        console.error('[SYSTEM] Init Failed:', err);
    }
});
