// index.js (Final Hybrid: Turbo Upsampler + Background Music)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ==================== CONFIGURATION ====================
const PORT = process.env.PORT || 3000;
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const API_KEY = process.env.ELEVENLABS_API_KEY;

// ==================== DSP ENGINE (The Upsampler) ====================
// This converts Twilio's low-res 8kHz audio into crispy 16kHz audio
const muLawToLinearTable = new Int16Array(256);
const VOLUME_BOOST = 5.0; 

// Generate Lookup Table
for (let i = 0; i < 256; i++) {
    let muLawByte = ~i; 
    let sign = (muLawByte & 0x80) >> 7;
    let exponent = (muLawByte & 0x70) >> 4;
    let mantissa = muLawByte & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    sample = sign === 0 ? -sample : sample;
    sample = sample * VOLUME_BOOST;
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;
    muLawToLinearTable[i] = sample;
}

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== 1. INCOMING CALL ROUTE ====================
app.post('/incoming-call', (req, res) => {
    const host = req.headers.host;
    // Ensure your lobby-quiet.mp3 is in the 'public' folder!
    const musicUrl = `https://${host}/lobby-quiet.mp3`; 

    console.log(`[TWILIO] Call incoming from: ${req.body.From}`);

    // MAGIC: We use <Start> instead of <Connect>.
    // This allows <Play> (Music) to run at the same time.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Start>
          <Stream url="wss://${host}/media-stream" track="inbound_track" />
        </Start>
        <Play loop="0">${musicUrl}</Play>
      </Response>`;

    res.type('text/xml').send(twiml);
});

// ==================== 2. WEBSOCKET ROUTE ====================
wss.on('connection', (ws) => {
    console.log("[TWILIO] Stream Connected");
    
    let elevenLabsWs = null;
    let streamSid = null;
    
    // Your Custom Buffers (Preserved for Turbo Speed)
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
                console.log(`[TWILIO] Stream Started: ${streamSid}`);
                
                // Connect to ElevenLabs
                // Note: We use ulaw_8000 for OUTPUT (Phone line limit)
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&output_format=ulaw_8000`;
                elevenLabsWs = new WebSocket(url, {
                    headers: { 'xi-api-key': API_KEY }
                });

                elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));
                
                // HANDLE AUDIO FROM AI -> TWILIO
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    
                    let chunkData = null;
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        chunkData = aiMsg.audio_event.audio_base64_chunk;
                    }
                    
                    if (chunkData) {
                        const newChunk = Buffer.from(chunkData, 'base64');
                        audioQueue = Buffer.concat([audioQueue, newChunk]);
                        
                        // Your Turbo Logic: Play after 0.1s buffer
                        if (!isPlaying && audioQueue.length >= 800) { 
                            isPlaying = true;
                            outputIntervalId = setInterval(streamAudioToTwilio, 20);
                        }
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                // HANDLE AUDIO FROM USER -> AI
                // We use your DSP logic to Upsample 8kHz -> 16kHz
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); 

                    for (let i = 0; i < twilioChunk.length; i++) {
                        const currentSample = muLawToLinearTable[twilioChunk[i]];
                        // Interpolation (The "Crispy" Math)
                        const midPoint = Math.floor((lastInputSample + currentSample) / 2);
                        
                        pcmChunk.writeInt16LE(midPoint, i * 4);
                        pcmChunk.writeInt16LE(currentSample, i * 4 + 2);
                        lastInputSample = currentSample;
                    }

                    pcmInputQueue = Buffer.concat([pcmInputQueue, pcmChunk]);
                    
                    // Send every 50ms (Turbo Speed)
                    if (pcmInputQueue.length >= 1600) {
                        elevenLabsWs.send(JSON.stringify({ 
                            user_audio_chunk: pcmInputQueue.toString('base64') 
                        }));
                        pcmInputQueue = Buffer.alloc(0);
                    }
                }
            } else if (msg.event === 'stop') {
                console.log("[TWILIO] Call Ended");
                if (elevenLabsWs) elevenLabsWs.close();
                clearInterval(outputIntervalId);
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => clearInterval(outputIntervalId));

    // Your Custom Streamer Function
    function streamAudioToTwilio() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        
        // Send small chunks (20ms) for low latency
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
