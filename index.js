// index.js (Final Cloud: HD Upsampling 16kHz)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Server Online: 16kHz Upsampling Active"));

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

// --- MU-LAW DECODING LOGIC ---
const muLawToLinear = (muLawByte) => {
    const BIAS = 0x84;
    let sign = (muLawByte & 0x80) >> 7;
    let exponent = (muLawByte & 0x70) >> 4;
    let mantissa = muLawByte & 0x0F;
    let sample = (2 * (mantissa) + 33) * (1 << exponent);
    sample -= BIAS;
    return sign === 0 ? sample : -sample;
};

wss.on('connection', (ws) => {
    console.log("[TWILIO] Client Connected");
    
    let elevenLabsWs = null;
    let streamSid = null;
    let audioQueue = Buffer.alloc(0); 
    let isPlaying = false;
    let outputIntervalId = null;
    let pcmInputQueue = Buffer.alloc(0);

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream Started!`);

                // Connect to ElevenLabs
                // Output is still ulaw_8000 (Phone standard)
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    
                    // OUTPUT LOGIC (Smart Finder)
                    let chunkData = null;
                    if (aiMsg.audio_event) {
                        if (aiMsg.audio_event.audio_base64_chunk) {
                            chunkData = aiMsg.audio_event.audio_base64_chunk;
                        } else if (aiMsg.audio_event.audio) {
                            chunkData = aiMsg.audio_event.audio;
                        } else {
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
                        const newChunk = Buffer.from(chunkData, 'base64');
                        audioQueue = Buffer.concat([audioQueue, newChunk]);

                        if (!isPlaying && audioQueue.length >= 4000) { 
                            isPlaying = true;
                            outputIntervalId = setInterval(streamAudioToTwilio, 20);
                        }
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    // *** 16kHz UPSAMPLING LOGIC ***
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    
                    // We need 4 bytes output for every 1 byte input
                    // (1 byte -> 1 sample (2 bytes) -> Double it (4 bytes))
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); 

                    for (let i = 0; i < twilioChunk.length; i++) {
                        const pcmSample = muLawToLinear(twilioChunk[i]);
                        // Write the sample TWICE to upsample 8k -> 16k
                        const offset = i * 4;
                        pcmChunk.writeInt16LE(pcmSample, offset);
                        pcmChunk.writeInt16LE(pcmSample, offset + 2);
                    }

                    pcmInputQueue = Buffer.concat([pcmInputQueue, pcmChunk]);

                    // Send chunks of approx 100ms (16kHz * 2 bytes * 0.1s = 3200 bytes)
                    const INPUT_THRESHOLD = 3200; 

                    if (pcmInputQueue.length >= INPUT_THRESHOLD) {
                        elevenLabsWs.send(JSON.stringify({ 
                            user_audio_chunk: pcmInputQueue.toString('base64') 
                        }));
                        pcmInputQueue = Buffer.alloc(0);
                    }
                }
            } else if (msg.event === 'stop') {
                if (elevenLabsWs) elevenLabsWs.close();
                clearInterval(outputIntervalId);
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => clearInterval(outputIntervalId));

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
