/**
 * Title: Split Reality AI Engine (Production Fix)
 * Description: Uses Express for stable routing and Buffers for clean audio mixing.
 */

require('dotenv').config();
const express = require('express'); // Added Express back to fix res.send error
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 8080;

// --- CONFIGURATION ---
const AI_VOLUME = 1.0; 
const BG_VOLUME = 0.02; // 2% volume for subtle ambience
const BG_URL = "https://raw.githubusercontent.com/viktoriotodorov/hotel-server/main/background.raw"; 

const app = express();
// Handle Twilio Form Data
app.use(express.urlencoded({ extended: true }));

// 1. Root Route (Health Check)
app.get('/', (req, res) => {
    res.send("Audio Server Online");
});

// 2. Twilio Incoming Call Route (CRITICAL)
// Without this, the call drops immediately because Twilio doesn't know what to do.
app.post('/incoming-call', (req, res) => {
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

// ============================================================================
// PART 1: G.711 MU-LAW DSP ENGINE (LUT)
// ============================================================================
class MuLawCoder {
    constructor() {
        this.mu2linear = new Int16Array(256);
        this.linear2mu = new Uint8Array(65536);
        this.generateTables();
    }

    generateTables() {
        const BIAS = 0x84;
        const CLIP = 32635;

        // Decode Table (uLaw -> Linear)
        for (let i = 0; i < 256; i++) {
            let mu = ~i;
            let sign = (mu & 0x80) >> 7;
            let exponent = (mu & 0x70) >> 4;
            let mantissa = mu & 0x0F;
            let sample = ((mantissa << 3) + 0x84) << exponent;
            sample -= 0x84;
            if (sign) sample = -sample;
            this.mu2linear[i] = sample;
        }

        // Encode Table (Linear -> uLaw)
        const encodeSample = (sample) => {
            sample = (sample < -CLIP) ? -CLIP : (sample > CLIP) ? CLIP : sample;
            const sign = (sample < 0) ? 0x80 : 0;
            sample = (sample < 0) ? -sample : sample;
            sample += BIAS;
            let exponent = 7;
            for (let exp = 0; exp < 8; exp++) {
                if (sample < (1 << (exp + 5))) {
                    exponent = exp;
                    break;
                }
            }
            const mantissa = (sample >> (exponent + 3)) & 0x0F;
            return ~(sign | (exponent << 4) | mantissa) & 0xFF;
        };

        for (let i = -32768; i <= 32767; i++) {
            this.linear2mu[i + 32768] = encodeSample(i);
        }
    }

    decode(muByte) {
        return this.mu2linear[muByte];
    }

    encode(linearSample) {
        return this.linear2mu[linearSample + 32768];
    }
}

const g711 = new MuLawCoder();

// ============================================================================
// PART 2: BACKGROUND LOADER
// ============================================================================
let backgroundBuffer = Buffer.alloc(0);

console.log(`[SYSTEM] Downloading Background Raw Audio...`);
https.get(BG_URL, (res) => {
    const data = [];
    res.on('data', chunk => data.push(chunk));
    res.on('end', () => {
        backgroundBuffer = Buffer.concat(data);
        console.log(`[SYSTEM] Background Loaded! ${backgroundBuffer.length} bytes.`);
    });
}).on('error', err => console.error("[ERROR] Failed to download background:", err.message));


// ============================================================================
// PART 3: WEBSOCKET MIXER
// ============================================================================
wss.on('connection', (ws) => {
    console.log('[TWILIO] Stream Connected');
    
    let elevenLabsWs = null;
    let streamSid = null;
    let audioQueue = Buffer.alloc(0);
    let bgIndex = 0;
    let mixerInterval = null;

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream Started: ${streamSid}`);

                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => {
                    console.log("[11LABS] Connected");
                    if (!mixerInterval) mixerInterval = setInterval(mixAndStream, 20);
                });
                
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
                // --- INPUT: Caller -> AI (Clean) ---
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    const twilioData = Buffer.from(msg.media.payload, 'base64');
                    // Convert uLaw to Linear PCM for 11Labs
                    const pcmData = Buffer.alloc(twilioData.length * 2);
                    for (let i = 0; i < twilioData.length; i++) {
                        const linearSample = g711.decode(twilioData[i]);
                        pcmData.writeInt16LE(linearSample, i * 2);
                    }
                    elevenLabsWs.send(JSON.stringify({ 
                        user_audio_chunk: pcmData.toString('base64') 
                    }));
                }
            } else if (msg.event === 'stop') {
                console.log(`[TWILIO] Stream Stopped`);
                if (elevenLabsWs) elevenLabsWs.close();
                clearInterval(mixerInterval);
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => {
        clearInterval(mixerInterval);
        console.log('[TWILIO] Client Disconnected');
    });

    // --- MIXER LOOP ---
    function mixAndStream() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        
        const SAMPLES_PER_CHUNK = 160; 
        const mixedBuffer = Buffer.alloc(SAMPLES_PER_CHUNK); 

        // Get AI Audio
        let aiChunk = null;
        if (audioQueue.length >= SAMPLES_PER_CHUNK) {
            aiChunk = audioQueue.subarray(0, SAMPLES_PER_CHUNK);
            audioQueue = audioQueue.subarray(SAMPLES_PER_CHUNK);
        }

        for (let i = 0; i < SAMPLES_PER_CHUNK; i++) {
            let sampleSum = 0;

            // 1. Background Layer
            if (backgroundBuffer.length > 0) {
                if (bgIndex >= backgroundBuffer.length - 2) bgIndex = 0; 
                const bgSample = backgroundBuffer.readInt16LE(bgIndex);
                bgIndex += 2;
                sampleSum += (bgSample * BG_VOLUME);
            }

            // 2. AI Layer
            if (aiChunk) {
                const aiSample = g711.decode(aiChunk[i]);
                sampleSum += (aiSample * AI_VOLUME);
            }

            // 3. Hard Clip
            if (sampleSum > 32767) sampleSum = 32767;
            if (sampleSum < -32768) sampleSum = -32768;

            // 4. Encode Output
            mixedBuffer[i] = g711.encode(Math.floor(sampleSum));
        }

        ws.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: mixedBuffer.toString('base64') }
        }));
    }
});

server.listen(PORT, () => {
    console.log(`[SYSTEM] Server listening on port ${PORT}`);
});
