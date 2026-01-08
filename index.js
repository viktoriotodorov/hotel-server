// index.js - The Conference Architecture
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const Twilio = require('twilio');

// 1. Load Environment Variables
const PORT = process.env.PORT || 3000;
const AGENT_ID = process.env.AGENT_ID;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// Twilio Auth (Required for injecting the AI leg)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER; 

// Initialize Twilio Client
const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const app = express();
app.use(express.urlencoded({ extended: true }));

// Serve static files (Your music)
app.use('/public', express.static(path.join(__dirname, 'public')));

// =========================================================================
// ROUTE 1: THE INCOMING CALL (The Guest)
// =========================================================================
app.post('/incoming-call', async (req, res) => {
    const callSid = req.body.CallSid;
    const conferenceName = `Room_${callSid}`; // Unique room
    const host = req.headers.host;
    const musicUrl = `https://${host}/public/lobby-quiet.mp3`;

    console.log(`\n[CALL START] Guest joining conference: ${conferenceName}`);

    // 1. INJECT THE AI GHOST LEG (Asynchronously)
    // We call *ourselves* to spawn the AI leg
    const aiUrl = `https://${host}/join-ai-leg?room=${conferenceName}`;
    
    try {
        await client.calls.create({
            to: TWILIO_PHONE_NUMBER, // Dialing our own number creates a loopback leg
            from: TWILIO_PHONE_NUMBER,
            url: aiUrl
        });
        console.log("[INJECT] AI Leg dispatched.");
    } catch (err) {
        console.error("[ERROR] Failed to inject AI:", err);
    }

    // 2. PUT THE GUEST IN THE CONFERENCE
    // waitUrl plays music while they wait for the AI. 
    // startConferenceOnEnter=true ensures the room opens immediately.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Dial>
            <Conference 
                waitUrl="${musicUrl}" 
                startConferenceOnEnter="true" 
                endConferenceOnExit="true">
                ${conferenceName}
            </Conference>
        </Dial>
    </Response>`;

    res.type('text/xml').send(twiml);
});

// =========================================================================
// ROUTE 2: THE AI GHOST LEG (Internal)
// =========================================================================
app.post('/join-ai-leg', (req, res) => {
    const room = req.query.room;
    console.log(`[AI LEG] Joining room: ${room}`);

    // TwiML Strategy:
    // 1. <Start><Stream>: Forks audio to/from ElevenLabs.
    // 2. <Dial><Conference>: Puts this leg into the room so the Human can hear it.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Start>
            <Stream url="wss://${req.headers.host}/media-stream" />
        </Start>
        <Dial>
            <Conference>${room}</Conference>
        </Dial>
    </Response>`;

    res.type('text/xml').send(twiml);
});

// =========================================================================
// WEBSOCKET HANDLER (The Brain)
// =========================================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// DSP: Volume Boost Table (AI needs loud audio to understand)
const muLawToLinearTable = new Int16Array(256);
const VOLUME_BOOST = 5.0; 
for (let i = 0; i < 256; i++) {
    let muLawByte = ~i;
    let sample = ((muLawByte & 0x0F) * 2 + 33) * (1 << ((muLawByte & 0x70) >> 4)) - 33;
    if ((muLawByte & 0x80) === 0) sample = -sample;
    muLawToLinearTable[i] = sample * VOLUME_BOOST;
}

wss.on('connection', (ws) => {
    console.log("[ws] AI Leg Connected");
    
    let streamSid = null;
    let elevenLabsWs = null;

    // --- THE BUFFERING SYSTEM (Fixes the "2 second block" crash) ---
    let audioQueue = Buffer.alloc(0);
    let isPlaying = false;
    let outputIntervalId = null;
    let pcmInputQueue = Buffer.alloc(0);
    let lastInputSample = 0;

    const elevenLabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&output_format=ulaw_8000`;
    
    try {
        elevenLabsWs = new WebSocket(elevenLabsUrl, { headers: { 'xi-api-key': ELEVENLABS_API_KEY } });
    } catch (err) { console.error('[FATAL]', err); return; }

    elevenLabsWs.on('open', () => console.log("[11Labs] Socket OPEN"));

    // --- AI -> CONFERENCE (Output) ---
    elevenLabsWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            let chunkData = null;

            // Key Search Strategy (Handles API variations)
            if (msg.audio_event) {
                if (msg.audio_event.audio_base_64) chunkData = msg.audio_event.audio_base_64;
                else if (msg.audio_event.audio_base64_chunk) chunkData = msg.audio_event.audio_base64_chunk;
                else if (msg.audio_event.audio) chunkData = msg.audio_event.audio;
            }

            if (chunkData) {
                const newChunk = Buffer.from(chunkData, 'base64');
                audioQueue = Buffer.concat([audioQueue, newChunk]);

                // The Pacer: Wait for buffer to fill, then drip-feed
                if (!isPlaying && audioQueue.length >= 4800) { 
                    isPlaying = true;
                    outputIntervalId = setInterval(streamAudioToTwilio, 20);
                }
            }
        } catch (e) { }
    });

    // --- CONFERENCE -> AI (Input) ---
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
            } else if (msg.event === 'media') {
                if (elevenLabsWs.readyState === WebSocket.OPEN) {
                    // Upsample 8k -> 16k
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4);
                    for (let i = 0; i < twilioChunk.length; i++) {
                        const currentSample = muLawToLinearTable[twilioChunk[i]];
                        const midPoint = Math.floor((lastInputSample + currentSample) / 2);
                        pcmChunk.writeInt16LE(midPoint, i * 4);
                        pcmChunk.writeInt16LE(currentSample, i * 4 + 2);
                        lastInputSample = currentSample;
                    }
                    pcmInputQueue = Buffer.concat([pcmInputQueue, pcmChunk]);
                    
                    if (pcmInputQueue.length >= 1600) {
                        elevenLabsWs.send(JSON.stringify({ user_audio_chunk: pcmInputQueue.toString('base64') }));
                        pcmInputQueue = Buffer.alloc(0);
                    }
                }
            } else if (msg.event === 'stop') {
                if (elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
                clearInterval(outputIntervalId);
            }
        } catch (e) { }
    });

    ws.on('close', () => {
        clearInterval(outputIntervalId);
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });

    function streamAudioToTwilio() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        const CHUNK_SIZE = 160; 
        if (audioQueue.length >= CHUNK_SIZE) {
            const chunkToSend = audioQueue.subarray(0, CHUNK_SIZE);
            audioQueue = audioQueue.subarray(CHUNK_SIZE);
            ws.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: { payload: chunkToSend.toString('base64') }
            }));
        }
    }
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
