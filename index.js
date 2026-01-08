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

// Serve static files (The Music)
// Ensure you have a folder named 'public' with 'lobby-quiet.mp3' inside
app.use('/public', express.static(path.join(__dirname, 'public')));

// 2. Incoming Call Webhook
app.post('/incoming-call', (req, res) => {
    // Determine the public URL for the music file
    const musicUrl = `https://${req.headers.host}/public/lobby-quiet.mp3`;
    console.log(`[Twilio] Call incoming from ${req.body.From}`);

    // TwiML Strategy:
    // <Start> forks the audio to the AI (background)
    // <Play> plays the music to the user (foreground)
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Start>
            <Stream url="wss://${req.headers.host}/media-stream" track="inbound_track" />
        </Start>
        <Play loop="0">${musicUrl}</Play>
    </Response>`;

    res.type('text/xml').send(twiml);
});

// --- SERVER CREATION (This must come BEFORE the WebSocket handler) ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 3. WebSocket Handler (The Relay)
wss.on('connection', (ws) => {
    console.log("[SYSTEM] Twilio connected");
    
    let streamSid = null;
    let elevenLabsWs = null;
    let audioQueue = []; // Queue to handle the race condition

    // Connect to ElevenLabs with ulaw_8000 (Phone standard)
    const elevenLabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&output_format=ulaw_8000`;
    
    try {
        elevenLabsWs = new WebSocket(elevenLabsUrl, {
            headers: { 'xi-api-key': API_KEY }
        });
    } catch (err) {
        console.error('[Error] Setup failed:', err);
        return;
    }

    elevenLabsWs.on('open', () => console.log("[11LABS] Connected to AI"));

    // --- AI -> PHONE ---
    elevenLabsWs.on('message', (data) => {
        try {
            // Convert Buffer to String to avoid parsing errors
            const msgStr = data.toString();
            const msg = JSON.parse(msgStr);

            if (msg.audio_event?.audio_base64_chunk) {
                const chunk = msg.audio_event.audio_base64_chunk;
                
                const audioPayload = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: chunk }
                };

                // FIX: If we don't have the StreamSid yet, queue the audio!
                if (streamSid === null) {
                    audioQueue.push(audioPayload);
                    console.log("[Buffer] Queued chunk (Waiting for StreamSid)");
                } else {
                    ws.send(JSON.stringify(audioPayload));
                }
            }
        } catch (e) { 
            console.log('[11Labs Error] Parsing failed:', e); 
        }
    });

    // --- PHONE -> AI ---
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log("[TWILIO] Stream started. ID:", streamSid);

                // Flush Queue: Send any buffered AI audio to Twilio now
                if (audioQueue.length > 0) {
                    console.log(`[Buffer] Flushing ${audioQueue.length} chunks to phone.`);
                    audioQueue.forEach(chunk => {
                        chunk.streamSid = streamSid;
                        ws.send(JSON.stringify(chunk));
                    });
                    audioQueue = [];
                }

            } else if (msg.event === 'media') {
                if (elevenLabsWs.readyState === WebSocket.OPEN) {
                    // Send raw telephony audio to AI
                    const aiInput = {
                        user_audio_chunk: msg.media.payload
                    };
                    elevenLabsWs.send(JSON.stringify(aiInput));
                }
            } else if (msg.event === 'stop') {
                console.log("[TWILIO] Call ended");
                if (elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
            }
        } catch (e) { console.log('[Twilio Error]', e); }
    });

    ws.on('close', () => {
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
