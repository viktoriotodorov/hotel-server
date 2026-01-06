const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const alawmulaw = require('alawmulaw'); 

const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const BG_VOLUME = 0.1; // 10% Volume (Safe for phone lines)

// Validate Environment Variables
if (!process.env.ELEVENLABS_API_KEY || !process.env.AGENT_ID) {
    console.error("[SYSTEM] ERROR: Missing Environment Variables");
    process.exit(1);
}

// --- LOAD BACKGROUND AUDIO ---
let bgBuffer = null;
try {
    const filePath = path.join(__dirname, 'background.wav');
    const fileData = fs.readFileSync(filePath);
    // Skip 44-byte WAV header
    const rawBuffer = fileData.subarray(44); 
    bgBuffer = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2);
    console.log(`[SYSTEM] Background audio loaded: ${bgBuffer.length} samples`);
} catch (err) {
    console.error("[SYSTEM] Failed to load background.wav", err.message);
}

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send('Server is Online'));

app.post('/incoming-call', (req, res) => {
    const callerId = req.body.From || "Unknown";
    console.log(`[TWILIO] Call from: ${callerId}`);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${req.headers.host}/media-stream">
            <Parameter name="caller_id" value="${callerId}" />
          </Stream>
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
    let aiAudioQueue = []; 
    let bgIndex = 0;

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
                
                // Handle Audio from AI
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        // Decode AI audio (u-law -> PCM) and add to queue
                        const rawAudio = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                        const pcmSamples = alawmulaw.mulaw.decode(rawAudio);
                        for (let i = 0; i < pcmSamples.length; i++) aiAudioQueue.push(pcmSamples[i]);
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                // 1. INPUT: Send Audio to ElevenLabs (PASS-THROUGH)
                // We send it exactly as received. No decoding. No boosting. No Static.
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    elevenLabsWs.send(JSON.stringify({ 
                        user_audio_chunk: msg.media.payload 
                    }));
                }

                // 2. OUTPUT: Synchronized Mixing
                // We use the incoming packet size to determine how much music to send back.
                // This keeps the music perfectly synced with the phone line.
                if (streamSid && bgBuffer) {
                    const rawInput = Buffer.from(msg.media.payload, 'base64');
                    // In u-law, 1 byte = 1 sample. So we need exactly this many samples of music.
                    const neededSamples = rawInput.length; 

                    const outputSamples = new Int16Array(neededSamples);
                    
                    // Get AI samples from queue
                    const aiSamples = aiAudioQueue.splice(0, neededSamples);

                    for (let i = 0; i < neededSamples; i++) {
                        // Get Background Sample
                        const bgSample = bgBuffer[bgIndex] * BG_VOLUME;
                        bgIndex = (bgIndex + 1) % bgBuffer.length;

                        // Get AI Sample (or 0 if silent)
                        const aiSample = i < aiSamples.length ? aiSamples[i] : 0;

                        // MIX
                        let mixed = aiSample + bgSample;

                        // CLAMP (Safety against loud distortion)
                        outputSamples[i] = Math.max(-32768, Math.min(32767, mixed));
                    }

                    // Encode and Send to Phone
                    const muLawResponse = alawmulaw.mulaw.encode(outputSamples);
                    const responseBase64 = Buffer.from(muLawResponse).toString('base64');

                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: responseBase64 }
                    }));
                }

            } else if (msg.event === 'stop') {
                if (elevenLabsWs) elevenLabsWs.close();
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => {
        if (elevenLabsWs) elevenLabsWs.close();
    });
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));
