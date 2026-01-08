const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

// 1. Load Environment Variables
const PORT = process.env.PORT || 3000;
const AGENT_ID = process.env.AGENT_ID;
const API_KEY = process.env.ELEVENLABS_API_KEY;

const app = express();
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use('/public', express.static(path.join(__dirname, 'public')));

// --- DSP ENGINE (Volume Booster) ---
// This ensures the user is loud enough for the AI to understand
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
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;
    muLawToLinearTable[i] = sample;
}

// 2. Incoming Call Webhook
app.post('/incoming-call', (req, res) => {
    console.log(`\n[CALL START] Incoming from ${req.body.From}`);

    // CRITICAL FIX: We switch from <Start> (Background) to <Connect> (Foreground).
    // This gives the AI full control of the audio, ensuring it can be heard.
    // The <Play> music is removed because it blocks the AI.
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

// 3. WebSocket Handler
wss.on('connection', (ws) => {
    console.log("[ws] Twilio connected");
    
    let streamSid = null;
    let elevenLabsWs = null;

    // Buffers
    let audioQueue = Buffer.alloc(0);
    let isPlaying = false;
    let outputIntervalId = null;
    let pcmInputQueue = Buffer.alloc(0);
    let lastInputSample = 0;

    // Connect to ElevenLabs
    const elevenLabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&output_format=ulaw_8000`;
    
    try {
        elevenLabsWs = new WebSocket(elevenLabsUrl, {
            headers: { 'xi-api-key': API_KEY }
        });
    } catch (err) {
        console.error('[FATAL] 11Labs socket failed:', err);
        return;
    }

    elevenLabsWs.on('open', () => console.log("[11Labs] Connected"));

    // --- AI -> PHONE (Output) ---
    elevenLabsWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            let chunkData = null;

            // Key Search Strategy
            if (msg.audio_event) {
                if (msg.audio_event.audio_base_64) chunkData = msg.audio_event.audio_base_64;
                else if (msg.audio_event.audio_base64_chunk) chunkData = msg.audio_event.audio_base64_chunk;
                else if (msg.audio_event.audio) chunkData = msg.audio_event.audio;
            }

            if (chunkData) {
                const newChunk = Buffer.from(chunkData, 'base64');
                audioQueue = Buffer.concat([audioQueue, newChunk]);

                if (!isPlaying && audioQueue.length >= 4800) { // Buffer ~0.6s to prevent stutter
                    isPlaying = true;
                    outputIntervalId = setInterval(streamAudioToTwilio, 20);
                }
            }
        } catch (e) { console.log('[Parsing Error]', e); }
    });

    // --- PHONE -> AI (Input) ---
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[Twilio] Stream Started: ${streamSid}`);
            } else if (msg.event === 'media') {
                if (elevenLabsWs.readyState === WebSocket.OPEN) {
                    // DSP: Upsample 8k -> 16k + Volume Boost
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

                    // Send to AI
                    if (pcmInputQueue.length >= 1600) {
                        elevenLabsWs.send(JSON.stringify({
                            user_audio_chunk: pcmInputQueue.toString('base64')
                        }));
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

    // --- HELPER: The Heartbeat ---
    function streamAudioToTwilio() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;

        const CHUNK_SIZE = 160; // 20ms of audio

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
