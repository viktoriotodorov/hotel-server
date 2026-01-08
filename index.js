const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const AGENT_ID = process.env.AGENT_ID;
const API_KEY = process.env.ELEVENLABS_API_KEY;

// IMPORTANT: Use a quiet version of your MP3 (-20dB). 
// If the music is too loud, you won't hear the AI.
const MUSIC_URL = "https://your-github-raw-url.com/background.mp3"; 

const app = express();
app.use(express.urlencoded({ extended: true }));

// 1. Incoming Call Webhook
app.post('/incoming-call', (req, res) => {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Start>
            <Stream url="wss://${req.headers.host}/media-stream" track="inbound_track" />
        </Start>
        <Play loop="0">${MUSIC_URL}</Play>
    </Response>`;
    res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log("[SYSTEM] Twilio connected");
    
    let streamSid = null;
    // 8000Hz is standard for telephony. 11Labs handles the upsampling internally 
    // if you use the Conversational AI endpoint correctly.
    const elevenLabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}`;
    
    const elevenLabsWs = new WebSocket(elevenLabsUrl, {
        headers: { 'xi-api-key': API_KEY }
    });

    // Handle AI Speaking (AI -> Twilio)
    elevenLabsWs.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.audio_event?.audio_base64_chunk) {
            ws.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: { payload: msg.audio_event.audio_base64_chunk }
            }));
        }
    });

    // Handle Human Speaking (Twilio -> AI)
    ws.on('message', (message) => {
        const msg = JSON.parse(message);
        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;
            console.log("[TWILIO] Stream started:", streamSid);
        } else if (msg.event === 'media') {
            if (elevenLabsWs.readyState === WebSocket.OPEN) {
                // Send raw telephony audio directly to 11Labs
                const aiInput = {
                    type: 'user_audio_chunk',
                    audio_base64_chunk: msg.media.payload
                };
                elevenLabsWs.send(JSON.stringify(aiInput));
            }
        }
    });

    ws.on('close', () => elevenLabsWs.close());
});

server.listen(PORT, () => console.log(`Server on port ${PORT}`));
