// index.js (DIAGNOSTIC MODE)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Server Online: DIAGNOSTIC MODE"));

app.post('/incoming-call', (req, res) => {
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

// --- DEBUG SETTINGS ---
const BG_VOLUME = 0.05;   // 5% Volume
const AI_VOLUME = 3.0;    // 300% AI Volume

// --- DIAGNOSTIC LOADER ---
let GLOBAL_BG_BUFFER = null;

function loadBackgroundSound() {
    console.log("[DEBUG] Starting Background Download...");
    const fileUrl = "https://raw.githubusercontent.com/viktoriotodorov/hotel-server/main/lobby.wav";
    
    https.get(fileUrl, (res) => {
        const data = [];
        res.on('data', chunk => data.push(chunk));
        res.on('end', () => {
            const fullFile = Buffer.concat(data);
            console.log(`[DEBUG] Download Finished. Total Size: ${fullFile.length} bytes`);
            
            // CHECK 1: Is it too small? (Text files are usually small)
            if (fullFile.length < 5000) {
                console.error("[CRITICAL ERROR] File is too small! Likely HTML or Error Text.");
                console.error(`[DEBUG] File Content Preview: ${fullFile.toString('utf8').substring(0, 100)}`);
                return;
            }

            // CHECK 2: Does it start with 'RIFF'? (WAV Header)
            const header = fullFile.subarray(0, 4).toString('ascii');
            console.log(`[DEBUG] File Header (First 4 chars): '${header}'`);
            
            if (header !== 'RIFF') {
                console.error("[CRITICAL ERROR] File is NOT a WAV file!");
                console.error("[DEBUG] This is likely why you hear 'Wind/Noise'. The server is playing text as audio.");
                console.error(`[DEBUG] First 50 bytes: ${fullFile.toString('utf8').substring(0, 50)}`);
                return; // Stop loading to prevent ear damage
            }

            // Success
            GLOBAL_BG_BUFFER = fullFile.subarray(44); 
            console.log(`[SUCCESS] Background Audio Loaded. Valid WAV detected.`);
        });
    }).on('error', err => console.error("[DEBUG] Network Error:", err.message));
}
loadBackgroundSound();

// --- TABLES ---
const muLawToLinear = new Int16Array(256);
const linearToMuLaw = new Uint8Array(65536);
(() => {
    // Generate standard G.711 tables
    const BIAS = 0x84; const CLIP = 32635;
    for (let i=0;i<256;i++){let b=~i,s=(b&0x80)>>7,e=(b&0x70)>>4,m=b&0x0F;muLawToLinear[i]=s===0?-((m*2+33)*(1<<e)-33):((m*2+33)*(1<<e)-33);}
    for (let i=0;i<65536;i++){let s=i-32768;if(s<-CLIP)s=-CLIP;if(s>CLIP)s=CLIP;let sg=(s<0)?0x80:0;s=(s<0)?-s:s;s+=BIAS;let e=7;for(let j=0;j<8;j++){if(s<(1<<(j+5))){e=j;break;}}let m=(s>>(e+3))&0x0F;linearToMuLaw[i]=~(sg|(e<<4)|m);}
})();

wss.on('connection', (ws) => {
    console.log("[DEBUG] Twilio Client Connected");
    
    let elevenLabsWs = null;
    let streamSid = null;
    let aiPacketQueue = []; 
    let bgIndex = 0;
    
    // Debug Counters
    let packetsReceivedFromTwilio = 0;
    let packetsSentToTwilio = 0;
    let aiChunksReceived = 0;

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[DEBUG] Stream Started. ID: ${streamSid}`);
                
                // Connect to 11Labs
                const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.AGENT_ID}&output_format=ulaw_8000`;
                console.log(`[DEBUG] Connecting to ElevenLabs...`);
                
                elevenLabsWs = new WebSocket(url, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });

                elevenLabsWs.on('open', () => console.log("[DEBUG] ElevenLabs Connected!"));
                
                elevenLabsWs.on('message', (data) => {
                    const aiMsg = JSON.parse(data);
                    if (aiMsg.audio_event?.audio_base64_chunk) {
                        aiChunksReceived++;
                        if (aiChunksReceived % 50 === 0) console.log(`[DEBUG] Received ${aiChunksReceived} chunks from AI.`);
                        
                        const chunk = Buffer.from(aiMsg.audio_event.audio_base64_chunk, 'base64');
                        aiPacketQueue.push(chunk);
                    }
                });

                elevenLabsWs.on('error', (e) => console.error("[DEBUG] ElevenLabs Error:", e.message));
                elevenLabsWs.on('close', (code, reason) => console.log(`[DEBUG] ElevenLabs Closed. Code: ${code}`));

            } else if (msg.event === 'media') {
                packetsReceivedFromTwilio++;
                
                // 1. Send User Audio to 11Labs
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                    elevenLabsWs.send(JSON.stringify({ 
                        user_audio_chunk: msg.media.payload 
                    }));
                }

                // 2. Prepare Output
                const CHUNK_SIZE = 160;
                const outputBuffer = Buffer.alloc(CHUNK_SIZE);
                
                // Get AI Audio
                let aiBuffer = null;
                if (aiPacketQueue.length > 0) {
                    aiBuffer = aiPacketQueue[0];
                    if (aiBuffer.length > CHUNK_SIZE) {
                        aiPacketQueue[0] = aiBuffer.subarray(CHUNK_SIZE);
                        aiBuffer = aiBuffer.subarray(0, CHUNK_SIZE);
                    } else {
                        aiPacketQueue.shift(); 
                    }
                }

                for (let i = 0; i < CHUNK_SIZE; i++) {
                    let mixedSample = 0;

                    // A. Add Background (Safety Checked)
                    if (GLOBAL_BG_BUFFER && GLOBAL_BG_BUFFER.length > 0) {
                        if (bgIndex >= GLOBAL_BG_BUFFER.length - 2) bgIndex = 0;
                        const bgSample = GLOBAL_BG_BUFFER.readInt16LE(bgIndex);
                        bgIndex += 2;
                        mixedSample += bgSample * BG_VOLUME;
                    }

                    // B. Add AI
                    if (aiBuffer && i < aiBuffer.length) {
                        const aiSample = muLawToLinear[aiBuffer[i]];
                        mixedSample += aiSample * AI_VOLUME;
                    }

                    if (mixedSample > 32767) mixedSample = 32767;
                    if (mixedSample < -32768) mixedSample = -32768;

                    const tableIdx = Math.floor(mixedSample) + 32768;
                    outputBuffer[i] = linearToMuLaw[tableIdx];
                }

                if (streamSid) {
                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: outputBuffer.toString('base64') }
                    }));
                    packetsSentToTwilio++;
                }
            } else if (msg.event === 'stop') {
                console.log(`[DEBUG] Call Ended. Total Sent: ${packetsSentToTwilio}, Total AI Chunks: ${aiChunksReceived}`);
                if (elevenLabsWs) elevenLabsWs.close();
            }
        } catch (e) {
            console.error("[DEBUG] Critical Exception:", e);
        }
    });

    ws.on('close', () => {
        console.log("[DEBUG] Twilio Disconnected");
        if (elevenLabsWs) elevenLabsWs.close();
    });
});

server.listen(PORT, () => console.log(`[SYSTEM] Server listening on port ${PORT}`));
