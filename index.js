const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const mulaw = require('mu-law');

const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const MIC_BOOST = 5.0; // 500% Volume Boost for the user's voice
const BG_VOLUME = 0.2; // 20% Volume for the background noise
const CHUNK_SIZE = 160; // 20ms of audio at 8000Hz

// Validate Environment Variables
if (!process.env.ELEVENLABS_API_KEY || !process.env.AGENT_ID) {
    console.error("[SYSTEM] ERROR: Missing Environment Variables");
    process.exit(1);
}

// --- LOAD BACKGROUND AUDIO ---
let bgBuffer = null;
try {
    const filePath = path.join(__dirname, 'background.wav');
    // Read the file
    const fileData = fs.readFileSync(filePath);
    
    // WAV Header Removal:
    // A standard WAV header is 44 bytes. We remove it to get raw audio samples.
    // If we don't do this, the header plays as a loud "POP" or static at the start.
    const rawBuffer = fileData.subarray(44); 
    
    // Convert bytes to 16-bit integers (Linear PCM)
    bgBuffer = new Int16Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.length / 2);
    
    console.log(`[SYSTEM] Background audio loaded: ${bgBuffer.length} samples`);
} catch (err) {
    console.error("[SYSTEM] Failed to load background.wav. Please upload it to GitHub.", err.message);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.get('/', (req, res) => res.send('Split-Reality Server is Online'));

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

wss.on('connection', (ws) => {
    console.log("[TWILIO] Client Connected");
    let elevenLabsWs = null;
    let streamSid = null;
    let mixerInterval = null;
    
    let aiAudioQueue = []; 
    let bgIndex = 0;

    // Helper: Send audio to Twilio
    const sendAudioToTwilio = (audioData) => {
        if (!streamSid) return;
        const payload = {
            event: 'media',
            streamSid: streamSid,
            media: { payload: audioData }
        };
        ws.send(JSON.stringify(payload));
    };

    // --- HEARTBEAT MIXER (20ms Loop) ---
    // This runs constantly to mix Background + AI
    const startMixer = () => {
        if (mixerInterval) clearInterval(mixerInterval);
        
        mixerInterval = setInterval(() => {
            if (!streamSid || !bgBuffer) return;

            // 1. Prepare output buffer for 20ms
            const outputSamples = new Int16Array(CHUNK_SIZE);
            
            // 2. Get samples from AI Queue (if any)
            const aiSamples = aiAudioQueue.splice(0, CHUNK_SIZE);

            // 3. Mix Loop
            for (let i = 0; i < CHUNK_SIZE; i++) {
                // Background Sample
                const bgSample = bgBuffer[bgIndex] * BG_VOLUME;
                bgIndex = (bgIndex + 1) % bgBuffer.length; // Loop audio

                // AI Sample (or 0 if silent)
                const aiSample = i < aiSamples.length ? aiSamples[i] : 0;

                // MIX
                let mixed = aiSample + bgSample;

                // CLAMP (Prevent distortion)
                mixed = Math.max(-32768, Math.min(32767, mixed));

                outputSamples[i] = mixed;
            }

            // 4. Encode to Mu-Law for Twilio
            const muLawBuffer = mulaw.encode(outputSamples);
            const base64String = Buffer.from(muLawBuffer.buffer).toString('base64');

            sendAudioToTwilio(base64String);

        }, 20); // 20ms tick
    };

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream Started! SID: ${streamSid}`);
                
                // Start the Mixer immediately
                startMixer();

                // Connect to ElevenLabs (Outputting u-law 8000Hz)
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                });

                elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        // DECODE Mu-Law -> Linear PCM for mixing
                        const rawAudio = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                        const pcmSamples = mulaw.decode(rawAudio);
                        
                        // Add to Queue
                        for (let i = 0; i < pcmSamples.length; i++) {
                            aiAudioQueue.push(pcmSamples[i]);
                        }
                    }
                });
                
                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    // --- INPUT BOOST (The Silence Fix) ---
                    // 1. Decode Twilio Mu-Law -> Linear PCM
                    const inputBuffer = Buffer.from(msg.media.payload, 'base64');
                    const inputSamples = mulaw.decode(inputBuffer);

                    // 2. Boost Volume
                    for (let i = 0; i < inputSamples.length; i++) {
                        let boosted = inputSamples[i] * MIC_BOOST;
                        inputSamples[i] = Math.max(-32768, Math.min(32767, boosted));
                    }

                    // 3. Re-encode to Mu-Law for ElevenLabs
                    const boostedMuLaw = mulaw.encode(inputSamples);
                    const boostedBase64 = Buffer.from(boostedMuLaw.buffer).toString('base64');

                    elevenLabsWs.send(JSON.stringify({ user_audio_chunk: boostedBase64 }));
                }
            } else if (msg.event === 'stop') {
                if (elevenLabsWs) elevenLabsWs.close();
                if (mixerInterval) clearInterval(mixerInterval);
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => {
        if (elevenLabsWs) elevenLabsWs.close();
        if (mixerInterval) clearInterval(mixerInterval);
    });
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));
