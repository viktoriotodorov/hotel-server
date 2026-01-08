// index.js (Output Booster Edition)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Environment Variables
const PORT = process.env.PORT || 3000;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

// Audio Settings
const AI_BOOST = 3.0; // Multiplies AI Volume by 3x

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== DSP ENGINE (Output Booster) ====================
// Tables for G.711 (Mu-Law) conversion
const muLawToLinearTable = new Int16Array(256);
const linearToMuLawTable = new Uint8Array(65536);
const BIAS = 0x84;
const CLIP = 32635;

// Generate Decode Table
for (let i = 0; i < 256; i++) {
    let mu = ~i;
    let sign = (mu & 0x80) >> 7;
    let exponent = (mu & 0x70) >> 4;
    let mantissa = mu & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    muLawToLinearTable[i] = sign === 0 ? -sample : sample;
}

// Generate Encode Table
for (let i = 0; i < 65536; i++) {
    let sample = i - 32768;
    let sign = (sample < 0) ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exponent = 7;
    for (let exp = 0; exp < 8; exp++) {
        if (sample < (1 << (exp + 5))) { exponent = exp; break; }
    }
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    linearToMuLawTable[i] = ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// Function: Boost Volume of Mu-Law Audio
function boostOutput(buffer) {
    const length = buffer.length;
    const processed = new Uint8Array(length);
    
    for (let i = 0; i < length; i++) {
        // 1. Decode
        let pcm = muLawToLinearTable[buffer[i]];
        
        // 2. Boost
        pcm = pcm * AI_BOOST;
        
        // 3. Clamp
        if (pcm > 32767) pcm = 32767;
        if (pcm < -32768) pcm = -32768;
        
        // 4. Encode
        let index = pcm + 32768;
        if (index < 0) index = 0; 
        if (index > 65535) index = 65535;
        processed[i] = linearToMuLawTable[index];
    }
    return processed;
}

// ==================== 1. INCOMING CALL ====================
app.post('/incoming-call', (req, res) => {
    const host = req.headers.host;
    const musicUrl = `https://${host}/lobby-quiet.mp3`;

    console.log(`[Twilio] Call incoming from ${req.body.From}`);

    // CHANGE: Removed track="inbound_track" so audio can travel BOTH ways.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Start>
            <Stream url="wss://${host}/media-stream" />
        </Start>
        <Play loop="0">${musicUrl}</Play>
    </Response>`;

    res.type('text/xml');
    res.send(twiml);
});

// ==================== 2. WEBSOCKET BRIDGE ====================
wss.on('connection', (ws) => {
    console.log('[Connection] Stream connected');
    let streamSid = null;
    let elevenLabsWs = null;

    const elevenLabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&output_format=ulaw_8000`;
    
    try {
        elevenLabsWs = new WebSocket(elevenLabsUrl, {
            headers: { 'xi-api-key': ELEVENLABS_API_KEY }
        });
    } catch (err) {
        console.error('[Error] Setup failed:', err);
        return;
    }

    elevenLabsWs.on('open', () => console.log('[11Labs] Connected'));

    // AI SPEAKING -> BOOST -> PHONE
    elevenLabsWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.audio_event?.audio_base64_chunk) {
                // 1. Get Audio from AI
                const rawAudio = Buffer.from(msg.audio_event.audio_base64_chunk, 'base64');
                
                // 2. BOOST IT!
                const boostedAudio = boostOutput(rawAudio);

                // 3. Send to Twilio
                const payload = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: Buffer.from(boostedAudio).toString('base64') }
                };
                
                if (streamSid && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(payload));
                }
            }
        } catch (error) {
            console.log('[11Labs] Parse Error:', error);
        }
    });

    // USER SPEAKING -> AI (Passthrough - No processing needed per your finding)
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            switch (data.event) {
                case 'start':
                    streamSid = data.start.streamSid;
                    console.log(`[Twilio] Stream started: ${streamSid}`);
                    break;

                case 'media':
                    if (elevenLabsWs.readyState === WebSocket.OPEN) {
                        const aiMsg = {
                            user_audio_chunk: data.media.payload
                        };
                        elevenLabsWs.send(JSON.stringify(aiMsg));
                    }
                    break;

                case 'stop':
                    if (elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
                    break;
            }
        } catch (error) {
            console.log('[Twilio] Message Error:', error);
        }
    });

    ws.on('close', () => {
        console.log('[Connection] Closed');
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
