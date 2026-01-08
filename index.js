const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 3000;
const AGENT_ID = process.env.AGENT_ID;
const API_KEY = process.env.ELEVENLABS_API_KEY;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));

// 1. WEBHOOK: Music + AI Background Connection
app.post('/incoming-call', (req, res) => {
    console.log(`\n[CALL START] Incoming from ${req.body.From}`);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Start>
            <Stream url="wss://${req.headers.host}/media-stream" track="inbound_track" />
        </Start>
        <Say>Hotel Alpha online.</Say>
        <Pause length="100" />
    </Response>`;
    res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 2. DSP: Simple lookup table for volume boosting (Optional but good)
const muLawToLinearTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
    let muLawByte = ~i;
    let sample = ((muLawByte & 0x0F) * 2 + 33) * (1 << ((muLawByte & 0x70) >> 4)) - 33;
    if ((muLawByte & 0x80) === 0) sample = -sample;
    muLawToLinearTable[i] = sample;
}

wss.on('connection', (ws) => {
    console.log("[ws] Twilio connected");

    let streamSid = null;
    let elevenLabsWs = null;

    // --- THE BUFFERING SYSTEM (From Code B) ---
    let audioQueue = Buffer.alloc(0);
    let isPlaying = false;
    let outputIntervalId = null;

    // Connect to ElevenLabs
    const elevenLabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&output_format=ulaw_8000`;
    try {
        elevenLabsWs = new WebSocket(elevenLabsUrl, { headers: { 'xi-api-key': API_KEY } });
    } catch (err) { console.error('[FATAL]', err); return; }

    elevenLabsWs.on('open', () => console.log("[11Labs] Socket OPEN"));

    // --- AI -> PHONE (The "Dam" Logic) ---
    elevenLabsWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.audio_event) {
                // Brute force check for the audio key (like Code B)
                const base64Audio = msg.audio_event.audio_base_64 || msg.audio_event.audio_base64_chunk;

                if (base64Audio) {
                    // 1. Add to the pool
                    const newChunk = Buffer.from(base64Audio, 'base64');
                    audioQueue = Buffer.concat([audioQueue, newChunk]);

                    // 2. Start the heartbeat if we have enough water in the dam
                    if (!isPlaying && audioQueue.length >= 800) { // Wait for 0.1s of audio
                        isPlaying = true;
                        // Start the drip-feed
                        outputIntervalId = setInterval(streamAudioToTwilio, 20);
                    }
                }
            }
        } catch (e) { }
    });

    // --- PHONE -> AI ---
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[Twilio] Stream Started: ${streamSid}`);
            } else if (msg.event === 'media' && elevenLabsWs.readyState === WebSocket.OPEN) {
                // Simple Pass-Through (We trust ElevenLabs to handle the 8k upsampling)
                elevenLabsWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
            } else if (msg.event === 'stop') {
                if (elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
                clearInterval(outputIntervalId);
            }
        } catch (e) { }
    });

    ws.on('close', () => clearInterval(outputIntervalId));

    // --- THE HEARTBEAT FUNCTION ---
    function streamAudioToTwilio() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;

        const CHUNK_SIZE = 160; // 160 bytes = 20ms of audio (Standard)

        if (audioQueue.length >= CHUNK_SIZE) {
            // Cut a slice
            const chunkToSend = audioQueue.subarray(0, CHUNK_SIZE);
            audioQueue = audioQueue.subarray(CHUNK_SIZE);

            // Send the slice
            ws.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: { payload: chunkToSend.toString('base64') }
            }));
        }
    }
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
