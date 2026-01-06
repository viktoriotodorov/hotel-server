// index.js (Final Cloud: Input Decoding + Output Buffering)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Server Online: Audio Transcoding Active"));

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
// We convert 8-bit Mu-Law (Telephone) to 16-bit PCM (Computer)
// This fixes the "Weak/Distorted" voice issue.
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
    
    // OUTPUT BUFFER (AI -> Phone)
    let audioQueue = Buffer.alloc(0); 
    let isPlaying = false;
    let outputIntervalId = null;

    // INPUT BUFFER (Phone -> AI)
    let pcmInputQueue = Buffer.alloc(0);

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream Started!`);

                // 1. Connect to ElevenLabs
                // We KEEP output as ulaw_8000 because Twilio handles that fine.
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    
                    // OUTPUT LOGIC (Keep exactly what worked)
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
                    // *** 2. DECODE TWILIO AUDIO ***
                    // Twilio sends Mu-Law (base64). We decode it to raw PCM.
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 2); // PCM is 16-bit (2 bytes) per sample

                    for (let i = 0; i < twilioChunk.length; i++) {
                        const pcmSample = muLawToLinear(twilioChunk[i]);
                        pcmChunk.writeInt16LE(pcmSample, i * 2);
                    }

                    // Buffer the PCM data
                    pcmInputQueue = Buffer.concat([pcmInputQueue, pcmChunk]);

                    // Send 100ms chunks (PCM 8000Hz 16-bit = 1600 bytes per 100ms)
                    const INPUT_THRESHOLD = 1600; 

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
