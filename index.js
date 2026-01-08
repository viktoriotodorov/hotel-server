const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Settings - Tune these as needed
const BG_VOLUME = 0.08;
const AI_VOLUME = 1.0;
const MIC_BOOST = 8.0;

// Global Background Audio Buffer (Int16Array PCM, 8000Hz Mono)
let BACKGROUND_PCM = null;

// ==================== AUDIO FORMAT CONVERSION (G.711 Mu-Law) ====================
// (Include the exact muLawToLinearTable, linearToMuLawTable, muLawToLinear(), 
// linearToMuLaw(), upsample8kTo16k(), boostAudio(), and mixAudio() functions 
// from our previous, working version here. Do not change them.)
// ... [Paste all conversion and mixing functions from the last code that worked] ...

// ==================== LOAD BACKGROUND AUDIO (Raw PCM) ====================
async function loadBackgroundSound() {
    return new Promise((resolve, reject) => {
        console.log('Loading background audio...');
        const req = https.get(
            "https://raw.githubusercontent.com/viktoriotodorov/hotel-server/main/backgroundn.raw",
            (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    const sampleCount = buffer.length / 2;
                    const pcmData = new Int16Array(sampleCount);
                    for (let i = 0; i < sampleCount; i++) {
                        pcmData[i] = buffer.readInt16LE(i * 2) * BG_VOLUME;
                    }
                    BACKGROUND_PCM = pcmData;
                    console.log(`Background loaded: ${pcmData.length} samples`);
                    resolve();
                });
            }
        );
        req.on('error', reject);
    });
}

// ==================== EXPRESS SERVER (Twilio Webhooks) ====================
app.use(express.urlencoded({ extended: true }));

// Twilio calls this endpoint when the call is answered
app.post('/incoming-call', (req, res) => {
    console.log(`📞 Incoming call from ${req.body.From} (SID: ${req.body.CallSid})`);
    
    // Return TwiML using <Connect> for stable control
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Please wait while we connect you to the assistant.</Say>
    <Connect>
        <Stream url="wss://${req.headers.host}/media" />
    </Connect>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
});

// Optional: Status callback
app.post('/call-status', (req, res) => {
    console.log(`Call ${req.body.CallSid} status: ${req.body.CallStatus}`);
    res.sendStatus(200);
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', bgLoaded: !!BACKGROUND_PCM });
});

// ==================== MEDIA STREAM WEBSOCKET (/media) ====================
wss.on('connection', (ws, req) => {
    // This endpoint is for Twilio Media Streams only
    if (req.url !== '/media') {
        ws.close();
        return;
    }
    console.log('🔌 Media WebSocket connected');

    let elevenLabsWs = null;
    let streamSid = null;
    let aiAudioQueue = [];
    let bgAudioIndex = 0;
    const MAX_QUEUE_SIZE = 10; // Prevent memory buildup

    // 1. Set up ElevenLabs WebSocket (NO initial config message)
    function connectToElevenLabs() {
        const agentId = process.env.AGENT_ID;
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!agentId || !apiKey) {
            console.error('Missing ElevenLabs credentials.');
            return;
        }

        elevenLabsWs = new WebSocket(
            `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}&output_format=ulaw_8000`,
            { headers: { 'xi-api-key': apiKey } }
        );

        elevenLabsWs.on('open', () => {
            console.log('✅ Connected to ElevenLabs.');
            // DO NOT send any initial 'config' or 'session_config' message.
            // The 'output_format' in the URL is sufficient.
        });

        elevenLabsWs.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                if (msg.audio_event?.audio_base64_chunk) {
                    const audioChunk = Buffer.from(msg.audio_event.audio_base64_chunk, 'base64');
                    if (aiAudioQueue.length < MAX_QUEUE_SIZE) {
                        aiAudioQueue.push(audioChunk);
                    }
                }
            } catch (err) {
                console.error('Error parsing ElevenLabs message:', err);
            }
        });

        elevenLabsWs.on('error', (err) => {
            console.error('ElevenLabs WebSocket error:', err.message);
        });

        elevenLabsWs.on('close', () => {
            console.log('ElevenLabs connection closed.');
        });
    }

    // 2. Handle messages from Twilio Media Stream
    ws.on('message', (data) => {
        const msg = JSON.parse(data);

        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;
            console.log(`🎬 Stream started: ${streamSid}`);
            connectToElevenLabs(); // Connect to AI only when media stream is ready

        } else if (msg.event === 'media' && BACKGROUND_PCM) {
            // A. Process User Input (Twilio -> ElevenLabs)
            const userAudioMuLaw = Buffer.from(msg.media.payload, 'base64');
            const userAudioPCM = muLawToLinear(userAudioMuLaw); // 8kHz
            const boostedPCM = boostAudio(userAudioPCM);
            const audioForAI = upsample8kTo16k(boostedPCM); // 16kHz for ElevenLabs

            // Convert to base64 for ElevenLabs (as PCM bytes)
            const pcmBuffer = new ArrayBuffer(audioForAI.length * 2);
            const view = new Int16Array(pcmBuffer);
            view.set(audioForAI);
            const audioBase64 = Buffer.from(pcmBuffer).toString('base64');

            // Send to ElevenLabs with the CORRECT message type
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const aiMessage = {
                    type: 'user_audio_chunk', // <<< This is the correct type
                    audio_base64_chunk: audioBase64
                };
                elevenLabsWs.send(JSON.stringify(aiMessage));
            }

            // B. Process AI Output + Background (ElevenLabs -> Twilio)
            let finalAudioPCM;
            if (aiAudioQueue.length > 0) {
                const aiAudioMuLaw = aiAudioQueue.shift();
                const aiAudioPCM = muLawToLinear(aiAudioMuLaw);
                finalAudioPCM = mixAudio(aiAudioPCM, BACKGROUND_PCM, bgAudioIndex);
                bgAudioIndex = (bgAudioIndex + aiAudioPCM.length) % BACKGROUND_PCM.length;
            } else {
                // Send only background music if AI is silent
                const chunkSize = 160; // 20ms
                finalAudioPCM = new Int16Array(chunkSize);
                for (let i = 0; i < chunkSize; i++) {
                    finalAudioPCM[i] = BACKGROUND_PCM[(bgAudioIndex + i) % BACKGROUND_PCM.length];
                }
                bgAudioIndex = (bgAudioIndex + chunkSize) % BACKGROUND_PCM.length;
            }

            // Encode back to Mu-Law and send to Twilio
            const finalAudioMuLaw = linearToMuLaw(finalAudioPCM);
            const response = {
                streamSid: streamSid,
                event: 'media',
                media: { payload: finalAudioMuLaw.toString('base64') }
            };
            ws.send(JSON.stringify(response));

        } else if (msg.event === 'stop') {
            console.log(`🛑 Stream ended: ${streamSid}`);
            if (elevenLabsWs) elevenLabsWs.close();
        }
    });

    ws.on('close', () => {
        console.log('🔌 Media WebSocket closed.');
        if (elevenLabsWs) elevenLabsWs.close();
    });
});

// ==================== START SERVER ====================
server.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    try {
        await loadBackgroundSound();
    } catch (err) {
        console.error('Failed to load background audio:', err);
    }
});
