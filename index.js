// index.js
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

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 1. INCOMING CALL ROUTE
app.post('/incoming-call', (req, res) => {
    const host = req.headers.host;
    const musicUrl = `https://${host}/lobby-quiet.mp3`;

    console.log(`[Twilio] Call incoming from ${req.body.From}`);

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

    // HANDLE MESSAGES FROM ELEVENLABS (AI SPEAKING)
    elevenLabsWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.audio_event?.audio_base64_chunk) {
                const payload = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: msg.audio_event.audio_base64_chunk }
                };
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(payload));
                }
            }
        } catch (error) {
            console.log('[11Labs] Parse Error:', error);
        }
    });

    // HANDLE MESSAGES FROM TWILIO (USER SPEAKING)
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            switch (data.event) {
                case 'start':
                    streamSid = data.start.streamSid;
                    console.log(`[Twilio] Stream started: ${streamSid}`);
                    break;

                case 'media':
                    // *** FIX IMPLEMENTED HERE ***
                    // We are using the EXACT payload structure from your old working code.
                    if (elevenLabsWs.readyState === WebSocket.OPEN) {
                        const aiMsg = {
                            type: 'user_audio_chunk',
                            audio_base64_chunk: data.media.payload
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
