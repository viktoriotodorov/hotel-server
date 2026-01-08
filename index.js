const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 1048576 });

// Parse incoming form data
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Settings
const BG_VOLUME = 0.08;
const AI_VOLUME = 1.0;
const MIC_BOOST = 8.0;
const OUTPUT_BUFFER_LIMIT = 20;

// IMPORTANT: ElevenLabs settings - they accept 16kHz input
const ELEVENLABS_INPUT_RATE = 16000; // AI hears at 16kHz
const TWILIO_SAMPLE_RATE = 8000; // Twilio sends/receives at 8kHz
const AI_OUTPUT_RATE = 8000; // AI responds at 8kHz

// Audio State
let BACKGROUND_PCM = null;

// --- Mu-Law Conversion (G.711) ---
const BIAS = 0x84;
const CLIP = 32635;
const MAX = 32767;

const muLawToLinearTable = new Int16Array(256);
const linearToMuLawTable = new Uint8Array(65536);

// Generate mu-law to linear table
for (let i = 0; i < 256; i++) {
    const mu = ~i;
    const exponent = (mu >> 4) & 0x07;
    const mantissa = mu & 0x0F;
    let sample = (mantissa << 3) + BIAS;
    sample <<= exponent + 3;
    sample = (mu & 0x80) ? BIAS - sample : sample - BIAS;
    muLawToLinearTable[i] = sample;
}

// Generate linear to mu-law table
for (let i = 0; i <= MAX; i++) {
    let linear = i;
    let sign = (linear >> 8) & 0x80;
    if (sign !== 0) linear = -linear;
    if (linear > CLIP) linear = CLIP;
    linear += BIAS;
    
    let exponent = 7;
    let mask = 0x4000;
    while ((linear & mask) === 0 && exponent > 0) {
        exponent--;
        mask >>= 1;
    }
    
    let mantissa = (linear >> (exponent + 3)) & 0x0F;
    let muLaw = ~(sign | (exponent << 4) | mantissa);
    linearToMuLawTable[i] = muLaw & 0xFF;
}

// Conversion functions
function muLawToLinear(muLawBuffer) {
    const length = muLawBuffer.length;
    const pcm = new Int16Array(length);
    
    for (let i = 0; i < length; i++) {
        pcm[i] = muLawToLinearTable[muLawBuffer[i] & 0xFF];
    }
    return pcm;
}

function linearToMuLaw(pcmBuffer) {
    const length = pcmBuffer.length;
    const muLaw = new Uint8Array(length);
    
    for (let i = 0; i < length; i++) {
        let sample = pcmBuffer[i];
        if (sample < -32768) sample = -32768;
        if (sample > 32767) sample = 32767;
        const index = sample < 0 ? 32768 - sample : sample;
        muLaw[i] = linearToMuLawTable[index];
    }
    return muLaw;
}

// Simple upsampling from 8kHz to 16kHz (for ElevenLabs input)
function upsample8kTo16k(pcm8k) {
    const length = pcm8k.length;
    const pcm16k = new Int16Array(length * 2);
    
    for (let i = 0; i < length; i++) {
        const sample = pcm8k[i];
        pcm16k[i * 2] = sample;
        pcm16k[i * 2 + 1] = sample; // Simple duplication (nearest neighbor)
    }
    return pcm16k;
}

// Simple downsampling from 16kHz to 8kHz
function downsample16kTo8k(pcm16k) {
    const length = Math.floor(pcm16k.length / 2);
    const pcm8k = new Int16Array(length);
    
    for (let i = 0; i < length; i++) {
        pcm8k[i] = pcm16k[i * 2]; // Take every other sample
    }
    return pcm8k;
}

// --- Load Raw PCM Background Audio ---
async function loadBackgroundSound() {
    return new Promise((resolve, reject) => {
        console.log('Loading background audio (raw PCM)...');
        
        const req = https.get(
            "https://raw.githubusercontent.com/viktoriotodorov/hotel-server/main/backgroundn.raw",
            (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Failed to load audio: HTTP ${res.statusCode}`));
                    return;
                }
                
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    try {
                        const buffer = Buffer.concat(chunks);
                        console.log(`Raw audio loaded: ${buffer.length} bytes`);
                        
                        // Convert raw 16-bit PCM (little-endian) to Int16Array
                        const sampleCount = Math.floor(buffer.length / 2);
                        const pcmData = new Int16Array(sampleCount);
                        
                        for (let i = 0; i < sampleCount; i++) {
                            pcmData[i] = buffer.readInt16LE(i * 2);
                        }
                        
                        // Apply volume scaling
                        for (let i = 0; i < sampleCount; i++) {
                            pcmData[i] = Math.round(pcmData[i] * BG_VOLUME);
                        }
                        
                        BACKGROUND_PCM = pcmData;
                        console.log(`Background audio ready: ${pcmData.length} samples`);
                        resolve();
                        
                    } catch (error) {
                        reject(new Error(`Failed to process audio: ${error.message}`));
                    }
                });
            }
        );
        
        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy();
            reject(new Error('Timeout loading background audio'));
        });
    });
}

// Audio processing functions
function boostAudio(pcmSamples) {
    const length = pcmSamples.length;
    const boosted = new Int16Array(length);
    
    for (let i = 0; i < length; i++) {
        let sample = pcmSamples[i] * MIC_BOOST;
        if (sample < -32768) sample = -32768;
        if (sample > 32767) sample = 32767;
        boosted[i] = Math.round(sample);
    }
    return boosted;
}

function mixAudio(aiPcm, bgPcm, bgPosition) {
    const length = aiPcm.length;
    const mixed = new Int16Array(length);
    
    for (let i = 0; i < length; i++) {
        const bgIndex = (bgPosition + i) % bgPcm.length;
        const mixedSample = Math.round((aiPcm[i] * AI_VOLUME) + bgPcm[bgIndex]);
        
        // Clamp with headroom
        if (mixedSample < -32000) mixed[i] = -32000;
        else if (mixedSample > 32000) mixed[i] = 32000;
        else mixed[i] = mixedSample;
    }
    
    return mixed;
}

// --- HTTP Routes for Twilio Webhooks ---
app.post('/incoming-call', (req, res) => {
    console.log('Incoming call received:', req.body.CallSid);
    
    // Return TwiML to start media stream
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Start>
        <Stream url="wss://${req.headers.host}/media" />
    </Start>
    <Say>Please wait while we connect you.</Say>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
});

app.post('/call-status', (req, res) => {
    console.log('Call status update:', req.body.CallSid, req.body.CallStatus);
    res.sendStatus(200);
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        backgroundLoaded: BACKGROUND_PCM !== null,
        connections: wss.clients.size
    });
});

app.get('/', (req, res) => {
    res.send('Audio Streaming Server - Ready for Calls');
});

// --- WebSocket Server for Media Streams ---
wss.on('connection', (ws, req) => {
    // Only handle media streams on /media path
    if (req.url !== '/media') {
        console.log('Rejecting non-media WebSocket connection:', req.url);
        ws.close();
        return;
    }
    
    console.log('Media WebSocket connected');
    
    let elevenLabsWs = null;
    let streamSid = null;
    let aiPacketQueue = [];
    let bgPosition = 0;
    let isActive = true;
    let lastSequence = 0;
    
    const cleanup = () => {
        if (!isActive) return;
        isActive = false;
        
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.close();
        }
        aiPacketQueue = [];
        console.log('Media connection cleaned up');
    };
    
    // Handle Twilio media stream messages
    ws.on('message', async (message) => {
        if (!isActive) return;
        
        try {
            const msg = JSON.parse(message.toString());
            
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`Media stream started: ${streamSid}`);
                
                // Connect to ElevenLabs
                const agentId = process.env.AGENT_ID;
                const apiKey = process.env.ELEVENLABS_API_KEY;
                
                if (!agentId || !apiKey) {
                    console.error('Missing ElevenLabs credentials');
                    ws.close();
                    return;
                }
                
                // IMPORTANT: Tell ElevenLabs we're sending 16kHz PCM
                elevenLabsWs = new WebSocket(
                    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}&output_format=ulaw_8000`,
                    {
                        headers: {
                            'xi-api-key': apiKey
                        }
                    }
                );
                
                elevenLabsWs.on('open', () => {
                    console.log('Connected to ElevenLabs');
                    
                    // Send configuration for 16kHz input
                    const config = {
                        type: 'config',
                        config: {
                            input_audio_format: 'pcm_16000',
                            output_audio_format: 'ulaw_8000'
                        }
                    };
                    elevenLabsWs.send(JSON.stringify(config));
                });
                
                elevenLabsWs.on('message', (data) => {
                    if (!isActive) return;
                    
                    try {
                        const aiMsg = JSON.parse(data.toString());
                        
                        if (aiMsg.audio_event?.audio_base64_chunk) {
                            const audioData = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                            
                            if (aiPacketQueue.length < OUTPUT_BUFFER_LIMIT) {
                                aiPacketQueue.push(audioData);
                            } else {
                                console.warn('AI audio queue full, dropping packet');
                            }
                        }
                    } catch (error) {
                        console.error('Error parsing ElevenLabs message:', error.message);
                    }
                });
                
                elevenLabsWs.on('error', (error) => {
                    console.error('ElevenLabs WebSocket error:', error.message);
                    cleanup();
                });
                
                elevenLabsWs.on('close', () => {
                    console.log('ElevenLabs connection closed');
                    cleanup();
                });
                
            } else if (msg.event === 'media') {
                // Skip if background audio isn't loaded
                if (!BACKGROUND_PCM) {
                    console.warn('Background audio not loaded yet');
                    return;
                }
                
                const twilioPayload = Buffer.from(msg.media.payload, 'base64');
                lastSequence = msg.sequenceNumber || 0;
                
                // --- Process Input: User -> AI ---
                try {
                    // Convert Twilio's 8kHz mu-law to 8kHz PCM
                    const userPcm8k = muLawToLinear(twilioPayload);
                    
                    // Boost volume for AI
                    const boostedPcm8k = boostAudio(userPcm8k);
                    
                    // Upsample to 16kHz for ElevenLabs
                    const boostedPcm16k = upsample8kTo16k(boostedPcm8k);
                    
                    // Send to ElevenLabs as base64 PCM
                    if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                        // Convert Int16Array to bytes (little-endian)
                        const pcmBuffer = new ArrayBuffer(boostedPcm16k.length * 2);
                        const pcmView = new Int16Array(pcmBuffer);
                        pcmView.set(boostedPcm16k);
                        
                        const audioMessage = {
                            type: 'input_audio',
                            audio_base64_chunk: Buffer.from(pcmBuffer).toString('base64')
                        };
                        elevenLabsWs.send(JSON.stringify(audioMessage));
                    }
                } catch (error) {
                    console.error('Error processing input audio:', error.message);
                }
                
                // --- Process Output: AI + BG -> User ---
                try {
                    let outputPcm8k;
                    
                    if (aiPacketQueue.length > 0) {
                        // Get AI audio from queue (already 8kHz mu-law from ElevenLabs)
                        const aiMuLaw = aiPacketQueue.shift();
                        const aiPcm8k = muLawToLinear(aiMuLaw);
                        
                        // Mix with background audio
                        outputPcm8k = mixAudio(aiPcm8k, BACKGROUND_PCM, bgPosition);
                        bgPosition = (bgPosition + aiPcm8k.length) % BACKGROUND_PCM.length;
                    } else {
                        // No AI audio, just send background
                        const chunkSize = 160; // 20ms at 8kHz
                        if (bgPosition + chunkSize > BACKGROUND_PCM.length) {
                            bgPosition = 0;
                        }
                        outputPcm8k = BACKGROUND_PCM.slice(bgPosition, bgPosition + chunkSize);
                        bgPosition += chunkSize;
                    }
                    
                    // Convert to Mu-Law for Twilio
                    const outputMuLaw = linearToMuLaw(outputPcm8k);
                    
                    // Send to Twilio
                    const response = {
                        streamSid: streamSid,
                        event: 'media',
                        sequenceNumber: lastSequence + 1,
                        media: {
                            payload: outputMuLaw.toString('base64')
                        }
                    };
                    
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(response));
                    }
                    
                    // Send mark periodically
                    if (Math.random() < 0.1) {
                        const mark = {
                            streamSid: streamSid,
                            event: 'mark',
                            mark: { name: 'chunk' }
                        };
                        ws.send(JSON.stringify(mark));
                    }
                    
                } catch (error) {
                    console.error('Error processing output audio:', error.message);
                }
                
            } else if (msg.event === 'stop') {
                console.log('Media stream stopped:', streamSid);
                cleanup();
            }
            
        } catch (error) {
            console.error('Error processing WebSocket message:', error.message);
        }
    });
    
    ws.on('error', (error) => {
        console.error('Media WebSocket error:', error.message);
        cleanup();
    });
    
    ws.on('close', () => {
        console.log('Media WebSocket closed');
        cleanup();
    });
});

// --- Startup ---
server.listen(PORT, async () => {
    console.log(`Server started on port ${PORT}`);
    console.log(`HTTP endpoint: http://localhost:${PORT}/incoming-call`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}/media`);
    
    try {
        await loadBackgroundSound();
        console.log('Server initialized successfully');
    } catch (error) {
        console.error('Failed to load background audio:', error.message);
        console.log('Server will start without background audio');
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.close();
        }
    });
    
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
