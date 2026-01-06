// index.js (Cloud: Smart-Finder & Safety Dam)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Server Online: Smart-Finder Active"));

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
    let audioQueue = Buffer.alloc(0); 
    let isPlaying = false;
    let intervalId = null;

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream Started!`);

                // 1. Connect to ElevenLabs
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    
                    // *** SMART FINDER LOGIC ***
                    // We don't know the exact key name, so we look for it.
                    let chunkData = null;

                    if (aiMsg.audio_event) {
                        // Log the keys so we can see the real name for next time
                        // console.log(`[DEBUG] Keys in audio_event: ${Object.keys(aiMsg.audio_event)}`);

                        // Check common names
                        if (aiMsg.audio_event.audio_base64_chunk) {
                            chunkData = aiMsg.audio_event.audio_base64_chunk;
                        } else if (aiMsg.audio_event.audio) {
                            chunkData = aiMsg.audio_event.audio;
                        } else {
                            // Brute Force: Find any value that is a long string (audio data)
                            const keys = Object.keys(aiMsg.audio_event);
                            for (const key of keys) {
                                const val = aiMsg.audio_event[key];
                                if (typeof val === 'string' && val.length > 100) {
                                    chunkData = val;
                                    break;
                                }
                            }
                        }
                    }

                    if (chunkData) {
                        // 2. FILL THE DAM
                        const newChunk = Buffer.from(chunkData, 'base64');
                        audioQueue = Buffer.concat([audioQueue, newChunk]);

                        // 3. OPEN THE FLOODGATES (Buffer 0.5s to prevent silence)
                        if (!isPlaying && audioQueue.length >= 4000) {
                            console.log("[SYSTEM] Dam Full - Playing Audio!");
                            isPlaying = true;
                            intervalId = setInterval(streamAudioToTwilio, 20);
                        }
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => {
                    console.log("[11LABS] Disconnected");
                });

            } else if (msg.event === 'media') {
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    elevenLabsWs.send(JSON.stringify({ user_audio_chunk: msg.media.payload }));
                }
            } else if (msg.event === 'stop') {
                if (elevenLabsWs) elevenLabsWs.close();
                clearInterval(intervalId);
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => clearInterval(intervalId));

    // THE STREAMER
    function streamAudioToTwilio() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;

        const CHUNK_SIZE = 160; 

        if (audioQueue.length >= CHUNK_SIZE) {
            const chunkToSend = audioQueue.subarray(0, CHUNK_SIZE);
            audioQueue = audioQueue.subarray(CHUNK_SIZE);

            ws.send(JSON.stringify({
                event: 'media',
                streamSid: streamSid,
                media: { payload: chunkToSend.toString('base64') }
            }));
        }
    }
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));
