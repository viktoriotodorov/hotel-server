// index.js (Cloud: Wake-Up Protocol)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Server Online: Wake-Up Protocol Active"));

app.post('/incoming-call', (req, res) => {
    const callerId = req.body.From || "Unknown";
    console.log(`[TWILIO] Call from: ${callerId}`);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${req.headers.host}/media-stream" />
        </Connect>
      </Response>`;
    res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log("[TWILIO] Client Connected");
    let elevenLabsWs = null;
    let streamSid = null;

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream Started! Sending Wake-Up Silence...`);

                // 1. THE DOOR OPENER: Send 200ms of Silence immediately
                // This forces Twilio's audio engine to engage before the AI speaks.
                const silencePayload = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: "ff".repeat(160) } // Simple silence pattern for u-law
                };
                ws.send(JSON.stringify(silencePayload));
                ws.send(JSON.stringify(silencePayload));
                ws.send(JSON.stringify(silencePayload));

                // 2. Connect to ElevenLabs
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        // 3. Clean the Data (Trim whitespace/newlines)
                        const chunk = aiMsg.audio_event.audio_base64_chunk.trim();
                        
                        // Pass directly to Twilio
                        const payload = {
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: chunk }
                        };
                        ws.send(JSON.stringify(payload));
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    elevenLabsWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
                }
            } else if (msg.event === 'stop') {
                if (elevenLabsWs) elevenLabsWs.close();
            }
        } catch (e) {
            console.error(e);
        }
    });
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));
