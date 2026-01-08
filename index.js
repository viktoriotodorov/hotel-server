const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

// 1. Load Environment Variables (Using your exact names)
const PORT = process.env.PORT || 3000;
const AGENT_ID = process.env.AGENT_ID;                 // <--- Updated
const API_KEY = process.env.ELEVENLABS_API_KEY;        // <--- Updated

const app = express();
app.use(express.urlencoded({ extended: true }));

// Serve static files from the 'public' folder
// This allows Twilio to download 'lobby-quiet.mp3' from your server
app.use('/public', express.static(path.join(__dirname, 'public')));

// 2. Incoming Call Webhook
app.post('/incoming-call', (req, res) => {
    // Construct the URL for your specific music file
    const musicUrl = `https://${req.headers.host}/public/lobby-quiet.mp3`;

    console.log(`[Twilio] Call incoming from ${req.body.From}`);

    // TwiML Strategy:
    // <Start>: Forks the USER audio to the AI (background)
    // <Play>: Plays the MUSIC to the user (foreground)
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Start>
            <Stream url="wss://${req.headers.host}/media-stream" track="inbound_track" />
        </Start>
        <Play loop="0">${musicUrl}</Play>
    </Response>`;

    res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 3. WebSocket Handler
wss.on('connection', (ws) => {
    console.log("[SYSTEM] Twilio connected");
    
    let streamSid = null;
    let elevenLabsWs = null;

    // *** CRITICAL FIX ***
    // We MUST ask for 'ulaw_8000'. If we don't, 11Labs sends 16k audio 
    // which sounds like loud static on the phone.
    const elevenLabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&output_format=ulaw_8000`;
    
    try {
        elevenLabsWs = new WebSocket(elevenLabsUrl, {
            headers: { 'xi-api-key': API_KEY }
        });
    } catch (err) {
        console.error('[Error] Setup failed:', err);
        return;
    }

    elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));

    // Handle AI Speaking (AI -> Twilio)
    elevenLabsWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.audio_event?.audio_base64_chunk) {
                ws.send(JSON.stringify({
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: msg.audio_event.audio_base64_chunk }
                }));
            }
        } catch (e) { console.log(e); }
    });

    // Handle Human Speaking (Twilio -> AI)
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log("[TWILIO] Stream started:", streamSid);
            } else if (msg.event === 'media') {
                if (elevenLabsWs.readyState === WebSocket.OPEN) {
                    // Send raw telephony audio directly to 11Labs
                    const aiInput = {
                        user_audio_chunk: msg.media.payload
                    };
                    elevenLabsWs.send(JSON.stringify(aiInput));
                }
            } else if (msg.event === 'stop') {
                if (elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
            }
        } catch (e) { console.log(e); }
    });

    ws.on('close', () => {
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
