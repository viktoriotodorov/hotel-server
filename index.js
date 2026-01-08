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
    // const musicUrl = `https://${req.headers.host}/public/lobby-quiet.mp3`; 
    console.log(`\n[CALL START] Incoming from ${req.body.From}`);

    // TwiML: NO MUSIC - Pure AI Connection
    // This prevents the "Format Lock" issue.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Start>
            <Stream url="wss://${req.headers.host}/media-stream" track="inbound_track" />
        </Start>
        <Say>Connecting you to the hotel AI.</Say>
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
    let audioQueue = []; 

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

    // --- AI -> PHONE ---
    elevenLabsWs.on('message', (data) => {
        try {
            const msgStr = data.toString();
            const msg = JSON.parse(msgStr);

            // LOGGING: Prove we are receiving audio
            if (msg.audio_event?.audio_base64_chunk) {
                const chunk = msg.audio_event.audio_base64_chunk;
                
                // IMPORTANT LOG
                console.log(`[RECEIVED] AI Audio Chunk: ${chunk.length} bytes`);

                const audioPayload = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: chunk }
                };

                if (streamSid === null) {
                    audioQueue.push(audioPayload);
                } else {
                    ws.send(JSON.stringify(audioPayload));
                }
            }
        } catch (e) { 
            console.log('[11Labs Parsing Error]', e); 
        }
    });

    // --- PHONE -> AI ---
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[Twilio] Stream Started: ${streamSid}`);

                if (audioQueue.length > 0) {
                    audioQueue.forEach(chunk => {
                        chunk.streamSid = streamSid;
                        ws.send(JSON.stringify(chunk));
                    });
                    audioQueue = [];
                }
            } else if (msg.event === 'media') {
                if (elevenLabsWs.readyState === WebSocket.OPEN) {
                    const aiInput = { user_audio_chunk: msg.media.payload };
                    elevenLabsWs.send(JSON.stringify(aiInput));
                }
            } else if (msg.event === 'stop') {
                if (elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
            }
        } catch (e) { console.log('[Twilio Error]', e); }
    });

    ws.on('close', () => {
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
