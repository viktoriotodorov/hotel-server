// index.js (Production Mode: No .env file, Debug Logging)
// require('dotenv').config(); <--- REMOVED. We trust Render variables only.
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Environment Variables
const PORT = process.env.PORT || 3000;

// CRITICAL: We check multiple possible names for the ID to be safe
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID || process.env.AGENT_ID;

// ==================== SYSTEM CHECK (DEBUG) ====================
// This runs once when the server starts to tell us what is loaded.
console.log("--- SYSTEM CHECK ---");
if (!ELEVENLABS_API_KEY) {
    console.error("❌ CRITICAL ERROR: API Key is MISSING. Check Render Environment Variables.");
} else {
    console.log("✅ API Key loaded.");
}

if (!AGENT_ID) {
    console.error("❌ CRITICAL ERROR: Agent ID is MISSING. Check Render Environment Variables.");
} else {
    console.log(`✅ Agent ID loaded: ${AGENT_ID.substring(0, 4)}... (Hidden)`);
}
console.log("--------------------");
// =============================================================

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

    if (!AGENT_ID || !ELEVENLABS_API_KEY) {
        console.error("[Error] Missing Credentials. Cannot connect to AI.");
        ws.close();
        return;
    }

    // Connect to ElevenLabs (Format: ulaw_8000)
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

    // Handle AI Speaking
    elevenLabsWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.audio_event?.audio_base64_chunk) {
                const payload = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: msg.audio_event.audio_base64_chunk }
                };
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
            }
        } catch (error) {
            console.log('[11Labs] Parse Error:', error);
        }
    });

    // Handle Errors
    elevenLabsWs.on('error', (err) => console.error('[11Labs] Error:', err.message));
    elevenLabsWs.on('close', (code, reason) => console.log(`[11Labs] Closed: ${code} ${reason}`));

    // Handle User Speaking (Passthrough)
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            switch (data.event) {
                case 'start':
                    streamSid = data.start.streamSid;
                    console.log(`[Twilio] Stream started: ${streamSid}`);
                    break;

                case 'media':
                    if (elevenLabsWs.readyState === WebSocket.OPEN) {
                        const audioMessage = {
                            user_audio_chunk: data.media.payload
                        };
                        elevenLabsWs.send(JSON.stringify(audioMessage));
                    }
                    break;

                case 'stop':
                    if (elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
                    break;
            }
        } catch (error) {
            console.log('[Twilio] Message Error:', error);
        }
    });

    ws.on('close', () => {
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
