// index.js (Final Cloud: 16kHz + 500% Volume Boost)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Server Online: Volume Boost Active"));

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

// --- MU-LAW LOOKUP TABLE WITH VOLUME BOOST ---
const muLawToLinearTable = new Int16Array(256);
const VOLUME_BOOST = 5.0; // Amplify audio 5x (500%)

for (let i = 0; i < 256; i++) {
    let muLawByte = ~i; // Invert inputs
    let sign = (muLawByte & 0x80) >> 7;
    let exponent = (muLawByte & 0x70) >> 4;
    let mantissa = muLawByte & 0x0F;
    
    // Standard conversion
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    
    // Apply sign
    sample = sign === 0 ? -sample : sample;

    // Apply Volume Boost
    sample = sample * VOLUME_BOOST;

    // "Clamp" the values so they don't distort (stay within 16-bit limits)
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;

    muLawToLinearTable[i] = sample;
}

wss.on('connection', (ws) => {
    console.log("[TWILIO] Client Connected");
    
    let elevenLabsWs = null;
    let streamSid = null;
    
    let audioQueue = Buffer.alloc(0); 
    let isPlaying = false;
    let outputIntervalId = null;
    
    let pcmInputQueue = Buffer.alloc(0);
    let lastInputSample = 0;

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream Started!`);

                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    
                    // OUTPUT LOGIC
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
                    // *** LINEAR INTERPOLATION + VOLUME BOOST ***
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); 

                    for (let i = 0; i < twilioChunk.length; i++) {
                        // The 'currentSample' is now 5x louder thanks to the table above
                        const currentSample = muLawToLinearTable[twilioChunk[i]];
                        
                        // Interpolate
                        const midPoint = Math.floor((lastInputSample + currentSample) / 2);
                        
                        pcmChunk.writeInt16LE(midPoint, i * 4);
                        pcmChunk.writeInt16LE(currentSample, i * 4 + 2);

                        lastInputSample = currentSample;
                    }

                    pcmInputQueue = Buffer.concat([pcmInputQueue, pcmChunk]);

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
