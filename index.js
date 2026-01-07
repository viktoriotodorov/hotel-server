/**
 * Title: Split Reality AI Engine (High-Fidelity)
 * Description: Connects Caller to ElevenLabs AI while mixing background audio.
 * Architecture: Packet-Clocked (Drift elimination)
 * DSP: Lookup Table based G.711 transcoding
 */

const WebSocket = require('ws');
const http = require('http');
const https = require('https'); // Added for downloading raw file
require('dotenv').config();

const PORT = process.env.PORT || 8080;

// --- CONFIGURATION ---
const AI_VOLUME = 1.0; 
const BG_VOLUME = 0.02; // Keep this low (2%) for a subtle effect
// Use your RAW file URL here
const BG_URL = "https://raw.githubusercontent.com/viktoriotodorov/hotel-server/main/background.raw"; 

// ============================================================================
// PART 1: G.711 MU-LAW DSP ENGINE (Corrected)
// ============================================================================
class MuLawCoder {
    constructor() {
        this.mu2linear = new Int16Array(256);
        this.linear2mu = new Uint8Array(65536); // Covers full 16-bit range for safety
        this.generateTables();
    }

    generateTables() {
        const BIAS = 0x84;
        const CLIP = 32635;

        // 1. Generate mu-law to Linear (Expansion)
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

        // 2. Generate Linear to mu-law (Compression)
        // Helper function for single sample
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

        // Fill LUT (Offset by 32768 to handle negative array indices)
        for (let i = -32768; i <= 32767; i++) {
            this.linear2mu[i + 32768] = encodeSample(i);
        }
    }

    // FIX: Now returns the value, not the array
    decode(muByte) {
        return this.mu2linear[muByte];
    }

    encode(linearSample) {
        return this.linear2mu[linearSample + 32768];
    }
}

const g711 = new MuLawCoder();

// ============================================================================
// PART 2: BACKGROUND LOADER (Network Driven)
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
// PART 3: SERVER & MIXER
// ============================================================================
const server = http.createServer((req, res) => res.send("Audio Server Online"));
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('[TWILIO] Stream Connected');
    
    let elevenLabsWs = null;
    let streamSid = null;
    let audioQueue = Buffer.alloc(0); // Queue for AI Audio
    let bgIndex = 0;
    let mixerInterval = null;

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream Started: ${streamSid}`);

                // Connect to ElevenLabs
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => {
                    console.log("[11LABS] Connected");
                    // Start Mixer immediately
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
                // --- INPUT LOGIC: Caller -> AI (Clean) ---
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    // 1. Decode Twilio u-law to Linear
                    const twilioData = Buffer.from(msg.media.payload, 'base64');
                    const pcmData = Buffer.alloc(twilioData.length * 2);

                    for (let i = 0; i < twilioData.length; i++) {
                        const linearSample = g711.decode(twilioData[i]);
                        pcmData.writeInt16LE(linearSample, i * 2);
                    }

                    // 2. Send Linear PCM to ElevenLabs
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

    // --- THE MIXER LOOP ---
    // Mixes AI Audio + Background -> Twilio
    function mixAndStream() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        
        const SAMPLES_PER_CHUNK = 160; 
        const mixedBuffer = Buffer.alloc(SAMPLES_PER_CHUNK); 

        // 1. Get AI Audio Chunk (if available)
        let aiChunk = null;
        if (audioQueue.length >= SAMPLES_PER_CHUNK) {
            aiChunk = audioQueue.subarray(0, SAMPLES_PER_CHUNK);
            audioQueue = audioQueue.subarray(SAMPLES_PER_CHUNK);
        }

        for (let i = 0; i < SAMPLES_PER_CHUNK; i++) {
            let sampleSum = 0;

            // A. Add Background
            if (backgroundBuffer.length > 0) {
                if (bgIndex >= backgroundBuffer.length - 2) bgIndex = 0; 
                const bgSample = backgroundBuffer.readInt16LE(bgIndex);
                bgIndex += 2;
                sampleSum += (bgSample * BG_VOLUME);
            }

            // B. Add AI Voice
            if (aiChunk) {
                const aiSample = g711.decode(aiChunk[i]); // Decode u-law AI
                sampleSum += (aiSample * AI_VOLUME);
            }

            // C. Hard Clip
            if (sampleSum > 32767) sampleSum = 32767;
            if (sampleSum < -32768) sampleSum = -32768;

            // D. Encode to u-law
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
    console.log(`[SYSTEM] Listening on port ${PORT}`);
});
