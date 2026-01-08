const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 3000;
const AGENT_ID = process.env.AGENT_ID;
const API_KEY = process.env.ELEVENLABS_API_KEY;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.post('/incoming-call', (req, res) => {
    console.log(`\n[CALL START] Incoming from ${req.body.From}`);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Start>
            <Stream url="wss://${req.headers.host}/media-stream" track="inbound_track" />
        </Start>
        <Say>X-Ray Debugger Started.</Say>
        <Pause length="100" />
    </Response>`;
    res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log("[ws] Twilio connected");
    let streamSid = null;
    let elevenLabsWs = null;
    let hasLoggedStructure = false; // Flag to log only the first packet

    const elevenLabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&output_format=ulaw_8000`;
    
    try {
        elevenLabsWs = new WebSocket(elevenLabsUrl, { headers: { 'xi-api-key': API_KEY } });
    } catch (err) { console.error('[FATAL]', err); return; }

    elevenLabsWs.on('open', () => console.log("[11Labs] Socket OPEN"));

    elevenLabsWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            // --- THE X-RAY: INSPECT THE PACKET ---
            if (msg.audio_event) {
                // 1. Log the KEYS inside the audio event
                if (!hasLoggedStructure) {
                    console.log(`\n🔎 [X-RAY] Audio Event Keys: ${JSON.stringify(Object.keys(msg.audio_event))}`);
                    hasLoggedStructure = true;
                }

                // 2. Extract Data (Try both keys)
                const chunk = msg.audio_event.audio_base_64 || msg.audio_event.audio_base64_chunk;

                if (chunk) {
                    // 3. Log the SIZE (Critical: Is it 0?)
                    console.log(`✅ [SENDING] Chunk Size: ${chunk.length} chars`);
                    
                    if (streamSid) {
                        ws.send(JSON.stringify({
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: chunk }
                        }));
                    }
                } else {
                    console.log("❌ [ERROR] Audio event received, but both keys are NULL!");
                }
            }
            // Log text to ensure AI is thinking
            if (msg.agent_response_event) {
                console.log(`🗣️ [AI]: "${msg.agent_response_event.agent_response}"`);
            }

        } catch (e) { console.log('[Parsing Error]', e); }
    });

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[Twilio] Stream Started: ${streamSid}`);
            } else if (msg.event === 'media' && elevenLabsWs.readyState === WebSocket.OPEN) {
                elevenLabsWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
            }
        } catch (e) { }
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
