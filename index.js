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
app.use('/public', express.static(path.join(__dirname, 'public')));

// 2. Incoming Call Webhook
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

// 3. WebSocket Handler
wss.on('connection', (ws) => {
    console.log("[ws] Twilio connected");
    
    let streamSid = null;
    let elevenLabsWs = null;

    // --- THE PACER BUFFERS ---
    // We use a raw Buffer to hold the audio bytes safely
    let audioBuffer = Buffer.alloc(0);
    let packetInterval = null;

    const elevenLabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&output_format=ulaw_8000`;
    
    try {
        elevenLabsWs = new WebSocket(elevenLabsUrl, {
            headers: { 'xi-api-key': API_KEY }
        });
    } catch (err) {
        console.error('[FATAL] 11Labs socket failed:', err);
        return;
    }

    elevenLabsWs.on('open', () => console.log("[11Labs] Socket OPEN"));

    // --- AI -> PHONE (With The Pacer) ---
    elevenLabsWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.audio_event) {
                // Check both keys (just to be safe)
                const base64Audio = msg.audio_event.audio_base_64 || msg.audio_event.audio_base64_chunk;
                
                if (base64Audio) {
                    // 1. Convert Base64 to Raw Bytes
                    const newAudio = Buffer.from(base64Audio, 'base64');
                    
                    // 2. Add to our Global Buffer (Don't send yet!)
                    audioBuffer = Buffer.concat([audioBuffer, newAudio]);
                    // console.log(`[Buffer] Added ${newAudio.length} bytes. Total: ${audioBuffer.length}`);
                }
            }
        } catch (e) { console.log('[Parsing Error]', e); }
    });

    // --- THE HEARTBEAT (Sends audio every 20ms) ---
    // Twilio expects 160 bytes of audio every 20 milliseconds (8000Hz u-law).
    packetInterval = setInterval(() => {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;

        const CHUNK_SIZE = 160; // 20ms of audio

        // If we have enough data for a packet, send it
        if (audioBuffer.length >= CHUNK_SIZE) {
            // Slice the first 160 bytes
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            // Send to Twilio
            ws.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: { payload: chunk.toString('base64') }
            }));
        }
    }, 20); // Run this every 20ms

    // --- PHONE -> AI ---
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[Twilio] Stream Started: ${streamSid}`);
            } else if (msg.event === 'media' && elevenLabsWs.readyState === WebSocket.OPEN) {
                elevenLabsWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
            } else if (msg.event === 'stop') {
                if (elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
            }
        } catch (e) { }
    });

    ws.on('close', () => {
        // Stop the heartbeat when call ends
        clearInterval(packetInterval);
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
