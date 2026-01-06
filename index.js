// index.js (Echo Test: Verifies Audio Engine)
const express = require('express');
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

// --- MANUAL TABLES (Fixed & Verified) ---
const muLawToLinearTable = new Int16Array(256);
const linearToMuLawTable = new Int8Array(65536);

// Generate Tables
for (let i = 0; i < 256; i++) {
    let muLawByte = ~i;
    let sign = (muLawByte & 0x80) >> 7;
    let exponent = (muLawByte & 0x70) >> 4;
    let mantissa = muLawByte & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    muLawToLinearTable[i] = sign === 0 ? -sample : sample;
}
for (let i = -32768; i < 32768; i++) {
    let sample = (i < 0) ? -i : i;
    let sign = (i < 0) ? 0x80 : 0;
    sample += 33;
    if (sample > 8192) sample = 8192;
    let exponent = Math.floor(Math.log(sample) / Math.log(2)) - 5;
    if (exponent < 0) exponent = 0;
    let mantissa = (sample >> (exponent + 1)) & 0x0F;
    linearToMuLawTable[i + 32768] = ~(sign | (exponent << 4) | mantissa);
}

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.send("Echo Test Server"));

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
    let streamSid = null;
    
    // Test Tone State
    let phase = 0;
    const toneVol = 0.1; // 10% volume beep

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log(`[TWILIO] Stream Started!`);
            } else if (msg.event === 'media') {
                // 1. DECODE YOUR VOICE (Input)
                const inputChunk = Buffer.from(msg.media.payload, 'base64');
                const linearInput = new Int16Array(inputChunk.length);
                
                for (let i = 0; i < inputChunk.length; i++) {
                    linearInput[i] = muLawToLinearTable[inputChunk[i]];
                }

                // 2. GENERATE OUTPUT (Echo + Soft Beep)
                const outputBuffer = Buffer.alloc(inputChunk.length);

                for (let i = 0; i < inputChunk.length; i++) {
                    // A. Your Voice (Echo)
                    const voiceSample = linearInput[i];
                    
                    // B. Soft Beep (Generated Math - No File)
                    // 400Hz Tone
                    const beepSample = Math.sin(phase) * 32767 * toneVol;
                    phase += (2 * Math.PI * 400) / 8000;
                    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;

                    // C. Mix
                    let mixed = voiceSample + beepSample;
                    
                    // D. Clamp
                    if (mixed > 32767) mixed = 32767;
                    if (mixed < -32768) mixed = -32768;

                    // E. Encode
                    outputBuffer[i] = linearToMuLawTable[Math.floor(mixed) + 32768];
                }

                // 3. SEND BACK
                if (streamSid) {
                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: outputBuffer.toString('base64') }
                    }));
                }
            }
        } catch (e) {
            console.error(e);
        }
    });
});

server.listen(PORT, () => console.log(`[SYSTEM] Echo Test on ${PORT}`));
