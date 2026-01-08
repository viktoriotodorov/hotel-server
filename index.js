const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 3000;
const AGENT_ID = process.env.AGENT_ID;
const API_KEY = process.env.ELEVENLABS_API_KEY;

const app = express();
app.use(express.urlencoded({ extended: true }));

// This line allows Twilio to download the mp3 directly from your Render server
app.use('/public', express.static(path.join(__dirname, 'public')));

app.post('/incoming-call', (req, res) => {
    // We dynamically create the URL pointing to YOUR server
    const musicUrl = `https://${req.headers.host}/public/background.mp3`;
    
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

wss.on('connection', (ws) => {
    console.log("[SYSTEM] Twilio connected");
    
    let streamSid = null;
    // ConvAI requires this specific URL structure
    const elevenLabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}`;
    
    const elevenLabsWs = new WebSocket(elevenLabsUrl, {
        headers: { 'xi-api-key': API_KEY }
    });

    elevenLabsWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            // ElevenLabs ConvAI sends audio in msg.audio_event.audio_base64_chunk
            if (msg.audio_event?.audio_base64_chunk) {
                ws.send(JSON.stringify({
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: msg.audio_event.audio_base64_chunk }
                }));
            }
        } catch (e) { console.error("11Labs Parse Error", e); }
    });

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
            } else if (msg.event === 'media') {
                if (elevenLabsWs.readyState === WebSocket.OPEN) {
                    // FIXED MESSAGE TYPE FOR CONVAI
                    const aiInput = {
                        user_audio_chunk: msg.media.payload 
                    };
                    elevenLabsWs.send(JSON.stringify(aiInput));
                }
            }
        } catch (e) { console.error("Twilio Parse Error", e); }
    });

    ws.on('close', () => {
        if (elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
