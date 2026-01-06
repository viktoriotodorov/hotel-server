// index.js (Parallel Stream Architecture)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const BG_VOLUME = 0.05; 

// --- LOAD BACKGROUND AUDIO ---
let bgBuffer = null;
try {
    const filePath = path.join(__dirname, 'background.wav');
    const fileData = fs.readFileSync(filePath);
    bgBuffer = new Int16Array(fileData.buffer, fileData.byteOffset + 44, (fileData.length - 44) / 2);
} catch (err) {
    console.error("[SYSTEM] Background Error:", err.message);
}

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

const app = express();
app.use(express.urlencoded({ extended: true }));
app.get('/', (req, res) => res.send("Parallel Stream Server Online"));

app.post('/incoming-call', (req, res) => {
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
      <Response><Connect><Stream url="wss://${req.headers.host}/media-stream" /></Connect></Response>`);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    let elevenLabsWs = null;
    let streamSid = null;
    let aiBuffer = []; 
    let bgIndex = 0;
    let lastInputSample = 0;

    ws.on('message', (message) => {
        const msg = JSON.parse(message);

        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;
            const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
            elevenLabsWs = new WebSocket(url, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });

            elevenLabsWs.on('message', (data) => {
                const aiMsg = JSON.parse(data);
                if (aiMsg.audio_event?.audio_base64_chunk) {
                    const b = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                    for (let i = 0; i < b.length; i++) aiBuffer.push(muLawToLinear(b[i]));
                }
            });
        } 
        
        else if (msg.event === 'media') {
            // 1. INPUT: To ElevenLabs (Fixed Upsampling)
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const tw = Buffer.from(msg.media.payload, 'base64');
                const pcm = Buffer.alloc(tw.length * 4);
                for (let i = 0; i < tw.length; i++) {
                    let s = muLawToLinear(tw[i]) * 5.0; // Input Boost
                    if (s > 32767) s = 32767; if (s < -32768) s = -32768;
                    pcm.writeInt16LE(Math.floor((lastInputSample + s) / 2), i * 4);
                    pcm.writeInt16LE(s, i * 4 + 2);
                    lastInputSample = s;
                }
                elevenLabsWs.send(JSON.stringify({ user_audio_chunk: pcm.toString('base64') }));
            }

            // 2. OUTPUT: The "Double-Layer" Mix
            const len = Buffer.from(msg.media.payload, 'base64').length;
            const out = Buffer.alloc(len);

            for (let i = 0; i < len; i++) {
                const bgS = bgBuffer ? bgBuffer[bgIndex] * BG_VOLUME : 0;
                if (bgBuffer) bgIndex = (bgIndex + 1) % bgBuffer.length;

                // Priority: AI Audio
                const aiS = aiBuffer.length > 0 ? aiBuffer.shift() : 0;

                let m = bgS + aiS;
                if (m > 32767) m = 32767; if (m < -32768) m = -32768;
                out[i] = linearToMuLaw(m);
            }
            
            ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: out.toString('base64') } }));
        }
    });
});

server.listen(PORT);
