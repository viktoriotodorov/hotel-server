// index.js (Final: Diagnostic Safety Mixer)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Server Online: Safety Mixer Active"));

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

// --- SETTINGS ---
const BG_VOLUME = 0.05;   // 5% Volume (Safe Level)
const AI_VOLUME = 2.0;    // 200% AI Volume
const MIC_BOOST = 3.0;    // 300% Mic Boost

// --- BACKGROUND LOADER (WITH SAFETY CHECK) ---
let GLOBAL_BG_BUFFER = null;

function loadBackgroundSound() {
    console.log("[SYSTEM] Downloading Background Sound...");
    // Ensure this URL points to the RAW bytes, not an HTML page
    https.get("https://raw.githubusercontent.com/viktoriotodorov/hotel-server/main/lobby.wav", (res) => {
        const data = [];
        res.on('data', chunk => data.push(chunk));
        res.on('end', () => {
            const fullFile = Buffer.concat(data);
            
            // --- DIAGNOSTIC CHECK ---
            // 1. Check File Size
            if (fullFile.length < 1000) {
                console.error(`[ERROR] File too small (${fullFile.length} bytes). Likely HTML/Text. Music DISABLED.`);
                return;
            }
            
            // 2. Check Magic Header (RIFF)
            const header = fullFile.subarray(0, 4).toString('ascii');
            if (header !== 'RIFF') {
                console.error(`[ERROR] Invalid Header: '${header}'. Expected 'RIFF'. Music DISABLED.`);
                console.error("Make sure the file on GitHub is a standard WAV, not LFS or HTML.");
                return;
            }

            // 3. Success -> Load Audio
            // Strip 44-byte WAV header
            GLOBAL_BG_BUFFER = fullFile.subarray(44); 
            console.log(`[SYSTEM] Background Loaded Successfully: ${GLOBAL_BG_BUFFER.length} bytes`);
        });
    }).on('error', err => console.error("[SYSTEM] BG Download Error:", err.message));
}
loadBackgroundSound();

// --- TABLES ---
const muLawToLinear = new Int16Array(256);
const linearToMuLaw = new Uint8Array(65536);

(() => {
    const BIAS = 0x84;
    const CLIP = 32635;
    for (let i = 0; i < 256; i++) {
        let muLawByte = ~i;
        let sign = (muLawByte & 0x80) >> 7;
        let exponent = (muLawByte & 0x70) >> 4;
        let mantissa = muLawByte & 0x0F;
        let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
        muLawToLinear[i] = sign === 0 ? -sample : sample;
    }
    for (let i = 0; i < 65536; i++) {
        let sample = i - 32768;
        if (sample < -CLIP) sample = -CLIP;
        if (sample > CLIP) sample = CLIP;
        const sign = (sample < 0) ? 0x80 : 0;
        sample = (sample < 0) ? -sample : sample;
        sample += BIAS;
        let exponent = 7;
        for (let exp = 0; exp < 8; exp++) {
            if (sample < (1 << (exp + 5))) { exponent = exp; break; }
        }
        let mantissa = (sample >> (exponent + 3)) & 0x0F;
        linearToMuLaw[i] = ~(sign | (exponent << 4) | mantissa);
    }
})();

wss.on('connection', (ws) => {
    console.log("[TWILIO] Client Connected");
    
    let elevenLabsWs = null;
    let streamSid = null;
    let aiChunkList = []; 
    let inputBuffer = Buffer.alloc(0);
    let lastInputSample = 0;
    let bgIndex = 0;

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        const chunk = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                        aiChunkList.push(chunk);
                    }
                });
                elevenLabsWs.on('close', () => console.log("[11LABS] Closed"));
                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e));

            } else if (msg.event === 'media') {
                const twilioData = Buffer.from(msg.media.payload, 'base64');
                
                // 1. INPUT
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    const pcm16k = Buffer.alloc(twilioData.length * 4);
                    for (let i = 0; i < twilioData.length; i++) {
                        let sample = muLawToLinear[twilioData[i]];
                        sample = Math.max(-32768, Math.min(32767, sample * MIC_BOOST)); 
                        pcm16k.writeInt16LE(Math.floor((lastInputSample + sample) / 2), i * 4);
                        pcm16k.writeInt16LE(sample, i * 4 + 2);
                        lastInputSample = sample;
                    }
                    inputBuffer = Buffer.concat([inputBuffer, pcm16k]);
                    if (inputBuffer.length >= 3200) { 
                         elevenLabsWs.send(JSON.stringify({ user_audio_chunk: inputBuffer.toString('base64') }));
                         inputBuffer = Buffer.alloc(0);
                    }
                }

                // 2. OUTPUT
                const CHUNK_SIZE = 160;
                const outputBuffer = Buffer.alloc(CHUNK_SIZE);
                
                let aiBuffer = null;
                if (aiChunkList.length > 0) {
                    aiBuffer = aiChunkList[0];
                    if (aiBuffer.length > CHUNK_SIZE) {
                        aiChunkList[0] = aiBuffer.subarray(CHUNK_SIZE);
                        aiBuffer = aiBuffer.subarray(0, CHUNK_SIZE);
                    } else {
                        aiChunkList.shift(); 
                    }
                }

                for (let i = 0; i < CHUNK_SIZE; i++) {
                    let mixedSample = 0;

                    // A. Add Background (ONLY if valid)
                    if (GLOBAL_BG_BUFFER && GLOBAL_BG_BUFFER.length > 0) {
                        if (bgIndex >= GLOBAL_BG_BUFFER.length - 2) bgIndex = 0;
                        const bgSample = GLOBAL_BG_BUFFER.readInt16LE(bgIndex);
                        bgIndex += 2;
                        mixedSample += bgSample * BG_VOLUME;
                    }

                    // B. Add AI
                    if (aiBuffer && i < aiBuffer.length) {
                        const aiSample = muLawToLinear[aiBuffer[i]];
                        mixedSample += aiSample * AI_VOLUME;
                    }

                    if (mixedSample > 32767) mixedSample = 32767;
                    if (mixedSample < -32768) mixedSample = -32768;

                    const tableIdx = Math.floor(mixedSample) + 32768;
                    outputBuffer[i] = linearToMuLaw[tableIdx];
                }

                if (streamSid) {
                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: outputBuffer.toString('base64') }
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
