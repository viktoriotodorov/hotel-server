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

    // --- AI -> PHONE (With "The Chunker") ---
    elevenLabsWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.audio_event) {
                // Get the base64 string
                const base64Audio = msg.audio_event.audio_base_64 || msg.audio_event.audio_base64_chunk;
                
                if (base64Audio && streamSid) {
                    // Send to the chunker function
                    streamToTwilio(ws, streamSid, base64Audio);
                }
            }
        } catch (e) { console.log('[Parsing Error]', e); }
    });

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
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });
});

// --- HELPER: Cut the big audio blob into small sips ---
function streamToTwilio(ws, streamSid, base64Audio) {
    // 1. Calculate safe chunk size (Twilio likes 160 bytes = 20ms of audio)
    // Base64 is 4 chars for 3 bytes. So ~220 chars is roughly 160 bytes.
    // We can go slightly larger for safety, e.g., 500 chars per message.
    const CHUNK_SIZE = 500; 
    
    let index = 0;
    
    // 2. Loop through the giant string and send it in pieces
    while (index < base64Audio.length) {
        const chunk = base64Audio.slice(index, index + CHUNK_SIZE);
        index += CHUNK_SIZE;

        // 3. Send the small sip to Twilio
        ws.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: chunk }
        }));
    }
}

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
