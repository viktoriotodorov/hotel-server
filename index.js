const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const wav = require('wav');

const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
// 1. BASE VOLUME: 0.4% (5x quieter than before)
const BG_VOLUME_NORMAL = 0.004; 
// 2. DUCKED VOLUME: 0.1% (When AI is talking, music effectively disappears)
const BG_VOLUME_DUCKED = 0.001; 
// 3. INPUT BOOST: 5.0 (Helps AI hear you)
const INPUT_BOOST = 5.0;

// --- G.711 UTILITIES ---
function muLawToLinear(m) {
    m = ~m;
    let s = (m & 0x80) >> 7;
    let e = (m & 0x70) >> 4;
    let n = m & 0x0F;
    let sample = (n * 2 + 33) * (1 << e) - 33;
    return s === 0 ? -sample : sample;
}

function linearToMuLaw(sample) {
    let s = (sample >> 8) & 0x80;
    if (s !== 0) sample = -sample;
    if (sample > 32635) sample = 32635;
    sample += 0x84;
    let e = 7;
    for (let m = 0x4000; e !== 0 && (sample & m) === 0; e--, m >>= 1);
    let n = (sample >> (e + 3)) & 0x0F;
    return ~(s | (e << 4) | n);
}

// --- LOAD BACKGROUND AUDIO ---
let bgBuffer = null;
const fileStream = fs.createReadStream(path.join(__dirname, 'background.wav'));
const reader = new wav.Reader();

reader.on('format', function (format) {
    console.log(`[SYSTEM] WAV Format: ${format.sampleRate}Hz ${format.bitDepth}-bit`);
    reader.on('data', function (chunk) {
        if (!bgBuffer) bgBuffer = chunk;
        else bgBuffer = Buffer.concat([bgBuffer, chunk]);
    });
    reader.on('end', function () {
        // Convert to Int16Array
        const temp = new Int16Array(bgBuffer.buffer, bgBuffer.byteOffset, bgBuffer.length / 2);
        bgBuffer = temp;
        console.log(`[SYSTEM] Background Audio Ready: ${bgBuffer.length} samples`);
    });
});
fileStream.pipe(reader);


const app = express();
app.use(express.urlencoded({ extended: true }));
app.get('/', (req, res) => res.send("Ducking Server Online"));
app.post('/incoming-call', (req, res) => {
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${req.headers.host}/media-stream" /></Connect></Response>`);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log("[TWILIO] Client Connected");
    let elevenLabsWs = null;
    let streamSid = null;
    let aiQueue = []; 
    let bgIndex = 0;
    let lastInputSample = 0;
    let outputInterval = null;

    ws.on('message', (message) => {
        const msg = JSON.parse(message);

        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;
            // ElevenLabs Connection
            const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
            elevenLabsWs = new WebSocket(url, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });

            elevenLabsWs.on('open', () => {
                console.log("[11LABS] Connected");
                if (!outputInterval) outputInterval = setInterval(sendMixedAudio, 20);
            });

            elevenLabsWs.on('message', (data) => {
                const aiMsg = JSON.parse(data);
                if (aiMsg.audio_event?.audio_base64_chunk) {
                    const chunk = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                    // Decode AI audio immediately
                    for (let i = 0; i < chunk.length; i++) {
                        aiQueue.push(muLawToLinear(chunk[i]));
                    }
                }
            });
        } 
        
        else if (msg.event === 'media') {
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                // INPUT: Turbo Mode (Upsample 8k -> 16k + Boost)
                const twilioData = Buffer.from(msg.media.payload, 'base64');
                const pcm = Buffer.alloc(twilioData.length * 4);
                
                for (let i = 0; i < twilioData.length; i++) {
                    let s = muLawToLinear(twilioData[i]) * INPUT_BOOST;
                    if (s > 32767) s = 32767; if (s < -32768) s = -32768;
                    
                    pcm.writeInt16LE(Math.floor((lastInputSample + s) / 2), i * 4);
                    pcm.writeInt16LE(s, i * 4 + 2);
                    lastInputSample = s;
                }
                elevenLabsWs.send(JSON.stringify({ user_audio_chunk: pcm.toString('base64') }));
            }
        }
        
        else if (msg.event === 'stop') {
            if (elevenLabsWs) elevenLabsWs.close();
            if (outputInterval) clearInterval(outputInterval);
        }
    });

    ws.on('close', () => {
        if (elevenLabsWs) elevenLabsWs.close();
        if (outputInterval) clearInterval(outputInterval);
    });

    // --- THE DUCKING MIXER ---
    function sendMixedAudio() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;

        const CHUNK_SIZE = 160; 
        const outputBuffer = Buffer.alloc(CHUNK_SIZE);

        // CHECK: Is AI Talking?
        // If queue has data, we are in "Speaking Mode"
        const isAiTalking = (aiQueue.length > 0);
        
        // SELECT VOLUME: If talking, drop music to almost zero.
        const currentBgVolume = isAiTalking ? BG_VOLUME_DUCKED : BG_VOLUME_NORMAL;

        for (let i = 0; i < CHUNK_SIZE; i++) {
            let mixed = 0;

            // 1. Add Background (With Dynamic Volume)
            if (bgBuffer && bgBuffer.length > 0) {
                mixed += bgBuffer[bgIndex] * currentBgVolume;
                bgIndex = (bgIndex + 1) % bgBuffer.length;
            }

            // 2. Add AI Voice (Priority)
            if (aiQueue.length > 0) {
                mixed += aiQueue.shift();
            }

            // 3. Clamp
            if (mixed > 32767) mixed = 32767;
            if (mixed < -32768) mixed = -32768;

            outputBuffer[i] = linearToMuLaw(mixed);
        }

        ws.send(JSON.stringify({ 
            event: 'media', 
            streamSid: streamSid, 
            media: { payload: outputBuffer.toString('base64') } 
        }));
    }
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));
