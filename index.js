// index.js (Final Hybrid: Music + Input Booster)
require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Environment Variables
const PORT = process.env.PORT || 3000;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

// Audio Settings
const MIC_BOOST = 5.0; // Boosts your voice 500% so AI hears you

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== DSP HELPERS (The "Hearing Aid") ====================
// These functions convert the low-quality phone audio into loud, clear AI audio
const muLawToLinearTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
    let mu = ~i;
    let sign = (mu & 0x80) >> 7;
    let exponent = (mu & 0x70) >> 4;
    let mantissa = mu & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    muLawToLinearTable[i] = sign === 0 ? -sample : sample;
}

function muLawToLinear(buffer) {
    const pcm = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
        pcm[i] = muLawToLinearTable[buffer[i]];
    }
    return pcm;
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

// 1. INCOMING CALL ROUTE
app.post('/incoming-call', (req, res) => {
    const host = req.headers.host;
    const musicUrl = `https://${host}/lobby-quiet.mp3`;

    console.log(`[Twilio] Call incoming from ${req.body.From}`);

    // <Start>: Opens clean audio line to AI
    // <Play>: Plays music to User
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Start>
            <Stream url="wss://${host}/media-stream" track="inbound_track" />
        </Start>
        <Play loop="0">${musicUrl}</Play>
    </Response>`;

    res.type('text/xml');
    res.send(twiml);
});

// 2. WEBSOCKET ROUTE
wss.on('connection', (ws) => {
    console.log('[Connection] Twilio Stream connected');
    let streamSid = null;
    let elevenLabsWs = null;
    let audioQueue = [];

    // Connect to ElevenLabs
    const elevenLabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&output_format=ulaw_8000`;
    
    try {
        elevenLabsWs = new WebSocket(elevenLabsUrl, {
            headers: { 'xi-api-key': ELEVENLABS_API_KEY }
        });
    } catch (err) {
        console.error('[Error] Setup failed:', err);
        return;
    }

    elevenLabsWs.on('open', () => console.log('[11Labs] Connected to AI Agent'));

    // FROM AI -> TO USER
    elevenLabsWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.audio_event?.audio_base64_chunk) {
                const payload = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: msg.audio_event.audio_base64_chunk }
                };
                
                if (streamSid) {
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
                } else {
                    audioQueue.push(payload);
                }
            }
        } catch (error) {
            console.log('[11Labs] Parse Error:', error);
        }
    });

    // FROM USER -> TO AI (Now with BOOST!)
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            switch (data.event) {
                case 'start':
                    streamSid = data.start.streamSid;
                    console.log(`[Twilio] Stream started: ${streamSid}`);
                    // Flush buffer
                    if (audioQueue.length > 0) {
                        audioQueue.forEach(p => { p.streamSid = streamSid; ws.send(JSON.stringify(p)); });
                        audioQueue = [];
                    }
                    break;

                case 'media':
                    if (elevenLabsWs.readyState === WebSocket.OPEN) {
                        // 1. Decode (Phone Format -> PCM)
                        const rawMuLaw = Buffer.from(data.media.payload, 'base64');
                        const pcm8k = muLawToLinear(rawMuLaw);
                        
                        // 2. Boost (Make it 5x louder)
                        const boostedPcm = boostAudio(pcm8k);
                        
                        // 3. Upsample (Make it High Quality for AI)
                        const pcm16k = upsample8kTo16k(boostedPcm);

                        // 4. Send to AI
                        const pcmBuffer = Buffer.from(pcm16k.buffer);
                        const aiMsg = {
                            type: 'user_audio_chunk',
                            audio_base64_chunk: pcmBuffer.toString('base64')
                        };
                        elevenLabsWs.send(JSON.stringify(aiMsg));
                    }
                    break;

                case 'stop':
                    console.log('[Twilio] Call ended');
                    if (elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
                    break;
            }
        } catch (error) {
            console.log('[Twilio] Message Error:', error);
        }
    });

    ws.on('close', () => {
        console.log('[Connection] Closed');
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
