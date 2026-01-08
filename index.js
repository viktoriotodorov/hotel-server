const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

// 1. Load Environment Variables
const PORT = process.env.PORT || 3000;
const AGENT_ID = process.env.AGENT_ID;
const API_KEY = process.env.ELEVENLABS_API_KEY;

// ==================== DSP ENGINE (From your working code) ====================
// This logic boosts the User's volume and upsamples 8k -> 16k so the AI hears you clearly.
const muLawToLinearTable = new Int16Array(256);
const VOLUME_BOOST = 5.0; // Boosts user volume to AI

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

const app = express();
app.use(express.urlencoded({ extended: true }));

// Serve the 'public' folder for the MP3
app.use('/public', express.static(path.join(__dirname, 'public')));

// 2. INCOMING CALL ROUTE
app.post('/incoming-call', (req, res) => {
    const musicUrl = `https://${req.headers.host}/public/lobby-quiet.mp3`;
    console.log(`[TWILIO] Call incoming from ${req.body.From}`);

    // HYBRID ARCHITECTURE:
    // 1. <Start> with track="inbound_track" (AI hears User only)
    // 2. <Play> (User hears Music)
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Start>
            <Stream url="wss://${req.headers.host}/media-stream" track="inbound_track" />
        </Start>
        <Play loop="0">${musicUrl}</Play>
    </Response>`;

    res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 3. WEBSOCKET ROUTE
wss.on('connection', (ws) => {
    console.log("[SYSTEM] Twilio connected");
    
    let elevenLabsWs = null;
    let streamSid = null;
    
    // --- BUFFERS (The Magic Sauce) ---
    // These ensure audio is sent smoothly, not in bursts.
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
                // output_format=ulaw_8000 is CRITICAL for the phone line
                const elevenLabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&output_format=ulaw_8000`;
                
                elevenLabsWs = new WebSocket(elevenLabsUrl, {
                    headers: { 'xi-api-key': API_KEY }
                });

                elevenLabsWs.on('open', () => console.log("[11LABS] Connected"));
                
                // HANDLE AUDIO: AI -> USER
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    
                    // Extract the chunk (Logic from your working code)
                    let chunkData = null;
                    if (aiMsg.audio_event) {
                        if (aiMsg.audio_event.audio_base64_chunk) {
                            chunkData = aiMsg.audio_event.audio_base64_chunk;
                        } else if (aiMsg.audio_event.audio) {
                            chunkData = aiMsg.audio_event.audio;
                        }
                    }

                    if (chunkData) {
                        const newChunk = Buffer.from(chunkData, 'base64');
                        audioQueue = Buffer.concat([audioQueue, newChunk]);
                        
                        // BUFFER LOGIC: Wait until we have 0.1s of audio, then start streaming
                        if (!isPlaying && audioQueue.length >= 800) { 
                            isPlaying = true;
                            // Send a chunk every 20ms (Standard Telephony Rate)
                            outputIntervalId = setInterval(streamAudioToTwilio, 20);
                        }
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[11LABS] Error:", e.message));
                elevenLabsWs.on('close', () => console.log("[11LABS] Disconnected"));

            } else if (msg.event === 'media') {
                // HANDLE AUDIO: USER -> AI
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    const twilioChunk = Buffer.from(msg.media.payload, 'base64');
                    
                    // UPSAMPLING LOGIC (8k -> 16k)
                    // This makes your voice sound "crispy" to the AI
                    const pcmChunk = Buffer.alloc(twilioChunk.length * 4); 

                    for (let i = 0; i < twilioChunk.length; i++) {
                        const currentSample = muLawToLinearTable[twilioChunk[i]]; // Apply Volume Boost
                        const midPoint = Math.floor((lastInputSample + currentSample) / 2); // Interpolate
                        
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
                if (elevenLabsWs) elevenLabsWs.close();
                clearInterval(outputIntervalId);
            }
        } catch (e) { console.error(e); }
    });

    ws.on('close', () => clearInterval(outputIntervalId));

    // --- THE STREAMER FUNCTION ---
    // This cuts the audio into perfect 160-byte chunks for Twilio.
    // Without this, Twilio rejects the audio, which is why you heard nothing.
    function streamAudioToTwilio() {
        if (!streamSid || ws.readyState !== WebSocket.OPEN) return;
        
        const CHUNK_SIZE = 160; // 20ms of audio
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

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
