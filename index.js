const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const Twilio = require('twilio');

// 1. Load Environment Variables
const PORT = process.env.PORT || 3000;
const AGENT_ID = process.env.AGENT_ID;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER; 

// Initialize Twilio
const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const app = express();
app.use(express.urlencoded({ extended: true }));

// =========================================================================
// ROUTE 1: INCOMING CALL (The Human)
// =========================================================================
app.post('/incoming-call', async (req, res) => {
    const callSid = req.body.CallSid;
    const roomName = `Room_${callSid}`;
    const host = req.headers.host;

    console.log(`[INCOMING] Human joining: ${roomName}`);

    // 1. INJECT THE AI (The Ghost Leg)
    // We try to add the AI. If your keys are wrong, this will log an error.
    try {
        await client.calls.create({
            to: 'client:AI_BOT', // Internal routing name
            from: TWILIO_PHONE_NUMBER,
            url: `https://${host}/join-ai-leg?room=${roomName}`
        });
        console.log("[INJECT] AI Bot dispatched.");
    } catch (e) { 
        console.error("[ERROR] AI Bot Injection Failed:", e.message); 
    }

    // 2. PLACE HUMAN IN CONFERENCE
    // We REMOVED 'waitUrl' to stop the 404 Crash.
    // You will hear silence (or default music) until the AI joins.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Dial>
            <Conference startConferenceOnEnter="true" endConferenceOnExit="true">
                ${roomName}
            </Conference>
        </Dial>
    </Response>`;
    res.type('text/xml').send(twiml);
});

// =========================================================================
// ROUTE 2: THE AI LEG (The Ghost)
// =========================================================================
app.post('/join-ai-leg', (req, res) => {
    const room = req.query.room;
    console.log(`[AI LEG] Joining Conference: ${room}`);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Connect>
            <Stream url="wss://${req.headers.host}/media-stream" />
        </Connect>
        <Dial>
            <Conference>${room}</Conference>
        </Dial>
    </Response>`;
    res.type('text/xml').send(twiml);
});

// =========================================================================
// WEBSOCKET HANDLER (AI Audio Processing)
// =========================================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Volume Boost Table (Makes user louder for AI)
const muLawToLinearTable = new Int16Array(256);
const VOLUME_BOOST = 5.0; 
for (let i = 0; i < 256; i++) {
    let muLawByte = ~i;
    let sample = ((muLawByte & 0x0F) * 2 + 33) * (1 << ((muLawByte & 0x70) >> 4)) - 33;
    if ((muLawByte & 0x80) === 0) sample = -sample;
    muLawToLinearTable[i] = sample * VOLUME_BOOST;
}

wss.on('connection', (ws) => {
    console.log("[ws] AI Connected");
    
    let streamSid = null;
    let elevenLabsWs = null;
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

    // AI -> Conference
    elevenLabsWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            let chunkData = null;
            if (msg.audio_event) {
                if (msg.audio_event.audio_base_64) chunkData = msg.audio_event.audio_base_64;
                else if (msg.audio_event.audio_base64_chunk) chunkData = msg.audio_event.audio_base64_chunk;
            }
            if (chunkData) {
                const newChunk = Buffer.from(chunkData, 'base64');
                audioQueue = Buffer.concat([audioQueue, newChunk]);
                if (!isPlaying && audioQueue.length >= 4800) {
                    isPlaying = true;
                    outputIntervalId = setInterval(streamAudioToTwilio, 20);
                }
            }
        } catch (e) { }
    });

    // Conference -> AI
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
            } else if (msg.event === 'media') {
                if (elevenLabsWs.readyState === WebSocket.OPEN) {
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
