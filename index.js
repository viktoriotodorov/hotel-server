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

// 2. Incoming Call Webhook
app.post('/incoming-call', (req, res) => {
    const musicUrl = `https://${req.headers.host}/public/lobby-quiet.mp3`;
    console.log(`\n[CALL START] Incoming call from ${req.body.From}`);
    console.log(`[SETUP] Music URL: ${musicUrl}`);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Start>
            <Stream url="wss://${req.headers.host}/media-stream" track="inbound_track" />
        </Start>
        <Play loop="0">${musicUrl}</Play>
    </Response>`;

    res.type('text/xml').send(twiml);
});

// --- SERVER CREATION ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 3. WebSocket Handler (The Debugger)
wss.on('connection', (ws) => {
    console.log("[ws] Twilio connected to server");
    
    let streamSid = null;
    let elevenLabsWs = null;
    let audioQueue = []; 

    // Connect to ElevenLabs
    const elevenLabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&output_format=ulaw_8000`;
    console.log(`[11Labs] Connecting to: ...${AGENT_ID.slice(-5)}`);
    
    try {
        elevenLabsWs = new WebSocket(elevenLabsUrl, {
            headers: { 'xi-api-key': API_KEY }
        });
    } catch (err) {
        console.error('[FATAL] 11Labs socket creation failed:', err);
        return;
    }

    elevenLabsWs.on('open', () => console.log("[11Labs] Socket OPEN"));
    elevenLabsWs.on('close', (code, reason) => console.log(`[11Labs] Socket CLOSED. Code: ${code}, Reason: ${reason}`));
    elevenLabsWs.on('error', (error) => console.error('[11Labs] Socket ERROR:', error));

    // --- AI -> PHONE (Downstream) ---
    elevenLabsWs.on('message', (data) => {
        try {
            const msgStr = data.toString();
            const msg = JSON.parse(msgStr);

            // LOG NON-AUDIO EVENTS (Helps detect errors/interruption)
            if (msg.type === 'ping') { 
                // Ignore pings to keep logs clean
            } else if (!msg.audio_event) {
                console.log(`[11Labs Event] ${JSON.stringify(msg)}`); 
            }

            // HANDLE AUDIO
            if (msg.audio_event?.audio_base64_chunk) {
                const chunk = msg.audio_event.audio_base64_chunk;
                
                const audioPayload = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: chunk }
                };

                if (streamSid === null) {
                    // DEBUG: Log that we are buffering
                    console.log(`[BUFFER] Queuing AI audio chunk (${chunk.length} bytes) - No StreamSid yet.`);
                    audioQueue.push(audioPayload);
                } else {
                    // DEBUG: Log that we are sending
                    // console.log(`[Sending] AI Audio -> Twilio (${chunk.length} bytes)`); 
                    ws.send(JSON.stringify(audioPayload));
                }
            }
        } catch (e) { 
            console.log('[11Labs Parsing Error]', e); 
        }
    });

    // --- PHONE -> AI (Upstream) ---
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`\n[Twilio] STREAM STARTED. StreamSid: ${streamSid}`);

                // FLUSH QUEUE
                if (audioQueue.length > 0) {
                    console.log(`[BUFFER] !!! FLUSHING ${audioQueue.length} CHUNKS TO TWILIO !!!`);
                    audioQueue.forEach(chunk => {
                        chunk.streamSid = streamSid;
                        ws.send(JSON.stringify(chunk));
                    });
                    audioQueue = [];
                }

            } else if (msg.event === 'media') {
                if (elevenLabsWs.readyState === WebSocket.OPEN) {
                    // Log only every 50th packet to avoid flooding console, but prove it works
                    // if (Math.random() < 0.05) console.log(`[Upstream] Sending User Audio -> AI`);
                    
                    const aiInput = {
                        user_audio_chunk: msg.media.payload
                    };
                    elevenLabsWs.send(JSON.stringify(aiInput));
                }
            } else if (msg.event === 'stop') {
                console.log(`[Twilio] Stream Stopped.`);
                if (elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
            }
        } catch (e) { console.log('[Twilio Parsing Error]', e); }
    });

    ws.on('close', () => {
        console.log('[ws] Twilio disconnected');
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
