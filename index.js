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
    // TwiML: NO MUSIC - Pure AI Connection for Debugging
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Start>
            <Stream url="wss://${req.headers.host}/media-stream" track="inbound_track" />
        </Start>
        <Say>Debugger active. Connecting now.</Say>
        <Pause length="100" />
    </Response>`;
    res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 3. WebSocket Handler (The Ultimate Debugger)
wss.on('connection', (ws) => {
    console.log("[ws] Twilio connected");
    
    let streamSid = null;
    let elevenLabsWs = null;
    let packetCount = 0;

    // Connect to ElevenLabs
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
    elevenLabsWs.on('close', (code, reason) => console.log(`[11Labs] CLOSED. Code: ${code}, Reason: ${reason}`));
    elevenLabsWs.on('error', (e) => console.error(`[11Labs] ERROR: ${e}`));

    // --- AI -> PHONE (The Inspection Zone) ---
    elevenLabsWs.on('message', (data, isBinary) => {
        try {
            // 1. Log the Data Type
            if (isBinary) {
                console.log(`[11Labs] RECEIVED BINARY FRAME (${data.length} bytes)`);
                // If it's binary, it might be raw audio. Let's see if we can send it.
                // (Usually ConvAI sends JSON, but if they changed it, this catches it)
                return; 
            }

            // 2. Parse JSON
            const msgStr = data.toString();
            const msg = JSON.parse(msgStr);

            // 3. Log the "Event Type" to see what they are actually sending
            if (msg.type) {
                // Ignore Pings to keep logs readable
                if (msg.type !== 'ping') {
                    console.log(`[11Labs MSG] Type: "${msg.type}" | Keys: ${Object.keys(msg)}`);
                }
            } else {
                console.log(`[11Labs MSG] NO TYPE! Keys: ${Object.keys(msg)}`);
            }

            // 4. Check for Audio specifically
            if (msg.audio_event) {
                const chunk = msg.audio_event.audio_base64_chunk;
                if (chunk) {
                    console.log(`✅ [AUDIO FOUND] Chunk size: ${chunk.length}`);
                    
                    if (streamSid) {
                        const audioPayload = {
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: chunk }
                        };
                        ws.send(JSON.stringify(audioPayload));
                    } else {
                        console.log(`⚠️ [BUFFER] Audio received but StreamSid is null.`);
                    }
                } else {
                    console.log(`❌ [AUDIO EVENT EMPTY] 'audio_base64_chunk' is missing!`);
                }
            } 
            
            // 5. Catch "Agent Response" (Text) but no Audio
            if (msg.agent_response_event) {
                console.log(`🗣️ [AI TEXT]: "${msg.agent_response_event.agent_response}"`);
            }

        } catch (e) { 
            console.log('[PARSING ERROR]', e);
            console.log('Raw Data was:', data.toString());
        }
    });

    // --- PHONE -> AI ---
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[Twilio] Stream Started: ${streamSid}`);
            } else if (msg.event === 'media') {
                if (elevenLabsWs.readyState === WebSocket.OPEN) {
                    const aiInput = { user_audio_chunk: msg.media.payload };
                    elevenLabsWs.send(JSON.stringify(aiInput));
                }
            }
        } catch (e) { console.log('[Twilio Error]', e); }
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
