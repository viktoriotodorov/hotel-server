const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 1048576 });

// Settings
const BG_VOLUME = 0.08; // 8% volume - adjust for good background level
const AI_VOLUME = 1.0;
const MIC_BOOST = 8.0;  // Boost user input for AI
const SAMPLE_RATE = 8000;
const CHUNK_SIZE = 160; // 20ms at 8000Hz
const OUTPUT_BUFFER_LIMIT = 20; // Max 20 chunks (400ms)

// Audio State
let BACKGROUND_PCM = null; // Will hold Int16Array

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
        
        // Ensure sample is within valid range
        if (sample < -32768) sample = -32768;
        if (sample > 32767) sample = 32767;
        
        const index = sample < 0 ? 32768 - sample : sample;
        muLaw[i] = linearToMuLawTable[index];
    }
    return muLaw;
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
                
                // Check content type (optional but helpful)
                const contentType = res.headers['content-type'];
                if (contentType && contentType.includes('text/html')) {
                    console.warn('Warning: Server returned HTML, not raw audio');
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
                        
                        // Check if audio is actually 8000Hz mono
                        const duration = sampleCount / 8000;
                        console.log(`Audio duration: ${duration.toFixed(2)} seconds (${sampleCount} samples)`);
                        
                        // Find peak for normalization
                        let peak = 0;
                        for (let i = 0; i < sampleCount; i++) {
                            const absVal = Math.abs(pcmData[i]);
                            if (absVal > peak) peak = absVal;
                        }
                        
                        console.log(`Peak amplitude: ${peak} (max 32767)`);
                        
                        // Apply volume scaling and normalization if needed
                        if (peak > 0) {
                            const normalizeFactor = Math.min(1.0, 30000 / peak); // Leave headroom
                            const volumeFactor = normalizeFactor * BG_VOLUME;
                            
                            for (let i = 0; i < sampleCount; i++) {
                                pcmData[i] = Math.round(pcmData[i] * volumeFactor);
                            }
                            
                            console.log(`Applied volume: ${(BG_VOLUME * 100).toFixed(1)}% (normalized ${(normalizeFactor * 100).toFixed(1)}%)`);
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
        
        req.on('error', (error) => {
            reject(new Error(`Network error: ${error.message}`));
        });
        
        req.setTimeout(15000, () => {
            req.destroy();
            reject(new Error('Timeout loading background audio'));
        });
    });
}

// --- Audio Processing Functions ---
function boostAudio(pcmSamples) {
    const length = pcmSamples.length;
    const boosted = new Int16Array(length);
    
    for (let i = 0; i < length; i++) {
        let sample = pcmSamples[i] * MIC_BOOST;
        
        // Clamp to 16-bit range with headroom
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

// --- WebSocket Server ---
wss.on('connection', (ws, req) => {
    console.log('New Twilio connection:', req.socket.remoteAddress);
    
    let elevenLabsWs = null;
    let streamSid = null;
    let aiPacketQueue = [];
    let bgPosition = 0;
    let isActive = true;
    
    // Cleanup function
    const cleanup = () => {
        if (!isActive) return;
        isActive = false;
        
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.close();
        }
        aiPacketQueue = [];
        console.log('Connection cleaned up');
    };
    
    // Handle Twilio messages
    ws.on('message', async (message) => {
        if (!isActive) return;
        
        try {
            const msg = JSON.parse(message.toString());
            
            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`Stream started: ${streamSid}`);
                
                // Connect to ElevenLabs
                const agentId = process.env.AGENT_ID;
                const apiKey = process.env.ELEVENLABS_API_KEY;
                
                if (!agentId || !apiKey) {
                    console.error('Missing ElevenLabs credentials');
                    ws.close();
                    return;
                }
                
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
                    
                    // Send initial configuration if needed
                    const config = {
                        type: 'config',
                        config: {
                            stt: true,
                            tts: true,
                            backchanneling: false
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
                            
                            // Limit queue size
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
                // Skip processing if background audio isn't loaded
                if (!BACKGROUND_PCM) {
                    console.warn('Background audio not loaded yet');
                    return;
                }
                
                const twilioPayload = Buffer.from(msg.media.payload, 'base64');
                
                // --- Process Input: User -> AI ---
                try {
                    // Convert Mu-Law to PCM
                    const userPcm = muLawToLinear(twilioPayload);
                    
                    // Boost volume for AI
                    const boostedPcm = boostAudio(userPcm);
                    
                    // Convert back to Mu-Law for ElevenLabs
                    const boostedMuLaw = linearToMuLaw(boostedPcm);
                    
                    // Send to ElevenLabs if connected
                    if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                        const audioMessage = {
                            type: 'input_audio',
                            audio_base64_chunk: boostedMuLaw.toString('base64')
                        };
                        elevenLabsWs.send(JSON.stringify(audioMessage));
                    }
                } catch (error) {
                    console.error('Error processing input audio:', error.message);
                }
                
                // --- Process Output: AI + BG -> User ---
                try {
                    let outputPcm;
                    
                    if (aiPacketQueue.length > 0) {
                        // Get AI audio from queue
                        const aiMuLaw = aiPacketQueue.shift();
                        const aiPcm = muLawToLinear(aiMuLaw);
                        
                        // Mix with background audio
                        outputPcm = mixAudio(aiPcm, BACKGROUND_PCM, bgPosition);
                        bgPosition = (bgPosition + aiPcm.length) % BACKGROUND_PCM.length;
                    } else {
                        // No AI audio, just send background
                        const chunkSize = Math.min(CHUNK_SIZE, BACKGROUND_PCM.length - bgPosition);
                        outputPcm = BACKGROUND_PCM.subarray(bgPosition, bgPosition + chunkSize);
                        
                        // If we need to wrap around
                        if (chunkSize < CHUNK_SIZE) {
                            const remaining = CHUNK_SIZE - chunkSize;
                            const combined = new Int16Array(CHUNK_SIZE);
                            combined.set(outputPcm);
                            combined.set(BACKGROUND_PCM.subarray(0, remaining), chunkSize);
                            outputPcm = combined;
                            bgPosition = remaining;
                        } else {
                            bgPosition += chunkSize;
                        }
                    }
                    
                    // Convert to Mu-Law for Twilio
                    const outputMuLaw = linearToMuLaw(outputPcm);
                    
                    // Send to Twilio
                    const response = {
                        streamSid: streamSid,
                        event: 'media',
                        media: {
                            payload: outputMuLaw.toString('base64')
                        }
                    };
                    
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(response));
                    }
                    
                } catch (error) {
                    console.error('Error processing output audio:', error.message);
                }
                
            } else if (msg.event === 'stop') {
                console.log('Stream stopped:', streamSid);
                cleanup();
            }
            
        } catch (error) {
            console.error('Error processing WebSocket message:', error.message);
        }
    });
    
    ws.on('error', (error) => {
        console.error('Twilio WebSocket error:', error.message);
        cleanup();
    });
    
    ws.on('close', () => {
        console.log('Twilio connection closed');
        cleanup();
    });
});

// --- HTTP Routes ---
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        backgroundLoaded: BACKGROUND_PCM !== null,
        connections: wss.clients.size
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        backgroundSamples: BACKGROUND_PCM ? BACKGROUND_PCM.length : 0
    });
});

// --- Startup ---
server.listen(PORT, async () => {
    console.log(`Server starting on port ${PORT}...`);
    
    try {
        await loadBackgroundSound();
        console.log('Server initialized successfully');
    } catch (error) {
        console.error('CRITICAL: Failed to load background audio:', error.message);
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
