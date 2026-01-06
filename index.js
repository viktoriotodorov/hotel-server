// index.js (The "Sherlock Holmes" Logger)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Logger Online"));

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
                console.log(`[TWILIO] Stream Started! SID: ${streamSid}`);

                // Connect to ElevenLabs
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));
                
                elevenLabsWs.on('message', (data) => {
                    // *** DIAGNOSTIC LOGGING ***
                    // We will print the KEYS of the message to see the structure
                    try {
                        const aiMsg = JSON.parse(data);
                        const keys = Object.keys(aiMsg);
                        console.log(`[11LABS MSG] Type: ${aiMsg.type} | Keys: ${JSON.stringify(keys)}`);
                        
                        // If there is an 'audio_event', inspect it deeper
                        if (aiMsg.audio_event) {
                             console.log(`[11LABS AUDIO] Chunk Size: ${aiMsg.audio_event.audio_base64_chunk ? aiMsg.audio_event.audio_base64_chunk.length : 'NULL'}`);
                        }

                        // Try to find audio ANYWHERE and send it
                        let chunk = null;
                        if (aiMsg.audio_event?.audio_base64_chunk) {
                            chunk = aiMsg.audio_event.audio_base64_chunk;
                        } else if (aiMsg.audio) {
                            chunk = aiMsg.audio;
                        }

                        if (chunk) {
                            const payload = {
                                event: 'media',
                                streamSid: streamSid,
                                media: { payload: chunk }
                            };
                            ws.send(JSON.stringify(payload));
                        }
                    } catch (err) {
                        console.log(`[11LABS RAW] Not JSON: ${data.toString().substring(0, 50)}...`);
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
