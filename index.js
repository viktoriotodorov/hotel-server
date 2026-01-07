// index.js (Final Cloud: Constant Ambience + Turbo Mode + Soft Limiter)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Server Online: Optimized Ambience Mode"));

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

// --- 1. MU-LAW TO LINEAR TABLE (DECODER) ---
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
    // Basic hard clamping for the table generation
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;
    muLawToLinearTable[i] = sample;
}

// --- 2. LINEAR TO MU-LAW TABLE (ENCODER) ---
// Pre-calculating this table makes the server 100x faster during calls
const linearToMuLawTable = new Uint8Array(65536);

const generateMuLaw = (sample) => {
    const BIAS = 0x84;
    const CLIP = 32635;
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

// Fill the table (Maps -32768..32767 to 0..65535)
for (let i = -32768; i <= 32767; i++) {
    linearToMuLawTable[i + 32768] = generateMuLaw(i);
}


// --- 3. BACKGROUND LOADER ---
let backgroundBuffer = Buffer.alloc(0);
console.log("[SYSTEM] Downloading Background Sound...");
https.get("https://raw.githubusercontent.com/viktoriotodorov/hotel-server/main/backgroundn.raw", (res) => {
    const data = [];
    res.on('data', chunk => data.push(chunk));
    res.on('end', () => {
        const fullFile = Buffer.concat(data);
        if (fullFile.length > 100) {
            // Skip 44 bytes for WAV header. 
            // Ensure your file is 8000Hz, Mono, 16-bit PCM!
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
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    // We only need basic decoding here for the AI input
                    // We can reuse the muLawToLinearTable we created above
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); 

                    for (let i = 0; i < twilioChunk.length; i++) {
                        // Note: Our table has VOLUME_BOOST applied. 
                        // For input to AI, we technically might want raw audio, 
                        // but 11Labs usually handles hot levels fine. 
                        // If AI struggles to hear, we might need a raw table.
                        // For now, using existing table is efficient.
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
                clearInterval(outputIntervalId);
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => clearInterval(outputIntervalId));

    // --- 4. OPTIMIZED MIXER ---
    function streamAudioToTwilio() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        
        const CHUNK_SIZE = 160; 
        const mixedBuffer = Buffer.alloc(CHUNK_SIZE);

        let hasBackground = backgroundBuffer.length > 0;
        
        // Get AI Audio
        let aiChunk = null;
        if (audioQueue.length >= CHUNK_SIZE) {
            aiChunk = audioQueue.subarray(0, CHUNK_SIZE);
            audioQueue = audioQueue.subarray(CHUNK_SIZE);
        }

        for (let i = 0; i < CHUNK_SIZE; i++) {
            let sample = 0;

            // Add Background
            if (hasBackground) {
                if (bgIndex >= backgroundBuffer.length - 2) bgIndex = 0;
                const bgSample = backgroundBuffer.readInt16LE(bgIndex);
                bgIndex += 2;
                sample += (bgSample * 0.05); // 5% Volume (Adjust this if needed)
            }

            // Add AI Voice
            if (aiChunk) {
                // Decode AI (using the pre-calculated table)
                const aiSample = muLawToLinearTable[aiChunk[i]];
                sample += aiSample;
            }

            // SOFT LIMITER (Prevents crackling)
            if (sample > 32000) sample = 32000 + Math.tanh((sample - 32000) / 1000) * 1000;
            if (sample < -32000) sample = -32000 + Math.tanh((sample + 32000) / 1000) * 1000;

            // Hard clamp final safety
            if (sample > 32767) sample = 32767;
            if (sample < -32768) sample = -32768;

            // Encode using the FAST Lookup Table
            // +32768 shifts the index to be positive (0-65535)
            mixedBuffer[i] = linearToMuLawTable[Math.floor(sample) + 32768];
        }

        ws.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: mixedBuffer.toString('base64') }
        }));
    }
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));
