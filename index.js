// index.js (Diagnostic Mode: Synthetic Tone + AI Mixer)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const alawmulaw = require('alawmulaw'); // Using the library for safety

const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const TONE_VOLUME = 0.05; // 5% Volume
const TONE_FREQ = 200;    // 200Hz Low Hum (Like a dial tone but lower)

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Diagnostic Server Online"));

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
    
    // Audio Buffers
    let aiLinearQueue = []; 
    let pcmInputQueue = Buffer.alloc(0);
    
    // Tone Generator State
    let phase = 0; 
    const phaseIncrement = (2 * Math.PI * TONE_FREQ) / 8000; // 8000Hz Sample Rate

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
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        // Decode AI (u-law -> Linear) immediately
                        const rawAudio = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                        const pcmSamples = alawmulaw.mulaw.decode(rawAudio);
                        
                        // Add to queue
                        for (let i = 0; i < pcmSamples.length; i++) {
                            aiLinearQueue.push(pcmSamples[i]);
                        }
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                // 1. INPUT (User -> AI) - Using Pass-Through to be safe
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    elevenLabsWs.send(JSON.stringify({ 
                        user_audio_chunk: msg.media.payload 
                    }));
                }

                // 2. OUTPUT (AI + Synthetic Tone -> User)
                const inputLength = Buffer.from(msg.media.payload, 'base64').length; 
                const neededSamples = inputLength; // Sync with input rate
                const outputSamples = new Int16Array(neededSamples);

                for (let i = 0; i < neededSamples; i++) {
                    // A. Generate Synthetic Tone (Math.sin)
                    // This creates a perfect, mathematical sound. No file reading errors possible.
                    const toneSample = Math.sin(phase) * 32767 * TONE_VOLUME;
                    phase += phaseIncrement;
                    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;

                    // B. Get AI Sample
                    let aiSample = 0;
                    if (aiLinearQueue.length > 0) {
                        aiSample = aiLinearQueue.shift();
                    }

                    // C. Mix
                    let mixed = toneSample + aiSample;
                    
                    // Clamp
                    outputSamples[i] = Math.max(-32768, Math.min(32767, mixed));
                }

                // Encode & Send
                if (streamSid) {
                    const muLawBuffer = alawmulaw.mulaw.encode(outputSamples);
                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(muLawBuffer).toString('base64') }
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

