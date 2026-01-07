/**
 * Title: Robust Real-Time Audio Mixer for Twilio Media Streams
 * Description: Implements Packet Clock architecture, G.711 u-law LUTs, and RIFF parsing.
 * Architecture: Input-Driven (Drift elimination)
 * DSP: Lookup Table based G.711 transcoding
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Configuration
const HTTP_PORT = process.env.PORT |

| 8080;
// Background file MUST be 8000Hz, 16-bit, Mono, PCM (Uncompressed)
const BACKGROUND_FILE_PATH = path.join(__dirname, 'background.wav'); 

// ============================================================================
// PART 1: G.711 MU-LAW DSP ENGINE (Lookup Table Generation)
// ============================================================================
// Reference: ITU-T Recommendation G.711
// Analysis: Pre-computing these tables saves millions of CPU cycles per call.

class MuLawCoder {
    constructor() {
        this.mu2linear = new Int16Array(256);
        this.linear2mu = new Uint8Array(16384); // Covers 14-bit linear range
        this.generateTables();
    }

    /**
     * Generates the Lookup Tables according to G.711 specification.
     * Maps 8-bit compressed u-law to 14-bit linear PCM and vice versa.
     */
    generateTables() {
        const BIAS = 0x84; // 132
        const CLIP = 32635;

        // 1. Generate mu-law to Linear (Expansion) Table
        // Iterates through all 256 possible byte values.
        for (let i = 0; i < 256; i++) {
            let mu = ~i; // Invert the bits (u-law is one's complement)
            let sign = (mu & 0x80) >> 7;
            let exponent = (mu & 0x70) >> 4;
            let mantissa = mu & 0x0F;
            
            // The G.711 expansion formula
            let sample = ((mantissa << 3) + 0x84) << exponent;
            sample -= 0x84;
            
            if (sign) sample = -sample;
            
            // Store as signed 16-bit integer
            this.mu2linear[i] = sample;
        }

        // 2. Generate Linear to mu-law (Compression) Table
        // We map a simplified 14-bit linear space to 8-bit mu-law.
        // The array index represents the linear value (offset by 8192 to handle negative indices).
        for (let i = 0; i < 16384; i++) {
            // Normalize input to 14-bit range (-8192 to +8191)
            let sample = i - 8192; 
            let sign = (sample < 0)? 0x80 : 0x00;
            if (sample < 0) sample = -sample;
            
            // Apply clipping for safety (Standard G.711 clip)
            if (sample > CLIP) sample = CLIP;
            
            sample += BIAS;
            let exponent = 0;
            
            // Determine exponent (logarithmic segment identification)
            // We verify bits from MSB down.
            if (sample > 0x7FFF) exponent = 7;
            else if (sample >= 0x4000) exponent = 7;
            else if (sample >= 0x2000) exponent = 6;
            else if (sample >= 0x1000) exponent = 5;
            else if (sample >= 0x0800) exponent = 4;
            else if (sample >= 0x0400) exponent = 3;
            else if (sample >= 0x0200) exponent = 2;
            else if (sample >= 0x0100) exponent = 1;
            else exponent = 0;

            let mantissa = (sample >> (exponent + 3)) & 0x0F;
            let mu = ~(sign | (exponent << 4) | mantissa);
            
            // Store the compressed byte
            this.linear2mu[i] = mu & 0xFF;
        }
    }

    /**
     * Decodes a single mu-law byte to 16-bit Linear PCM
     * Complexity: O(1)
     */
    decode(muByte) {
        return this.mu2linear;
    }

    /**
     * Encodes a 16-bit Linear PCM sample to mu-law byte
     * Complexity: O(1)
     */
    encode(linearSample) {
        // 1. Shift 16-bit sample to 14-bit range (G.711 standard)
        // 16-bit (-32768..32767) >> 2 becomes (-8192..8191)
        let sample = linearSample >> 2; 
        
        // 2. Offset the index to be positive for array access (0 = -8192)
        let lutIndex = sample + 8192;
        
        // 3. Clamp bounds to prevent array overflow
        if (lutIndex < 0) lutIndex = 0;
        if (lutIndex > 16383) lutIndex = 16383;
        
        return this.linear2mu[lutIndex];
    }
}

// Instantiate the Coder (Singleton)
const g711 = new MuLawCoder();

// ============================================================================
// PART 2: ROBUST WAV PARSER (Metadata Noise Removal)
// ============================================================================

function parseWavFile(filePath) {
    console.log(` Loading file: ${filePath}`);
    const fileBuffer = fs.readFileSync(filePath);

    // 1. Validate RIFF Header
    if (fileBuffer.toString('ascii', 0, 4)!== 'RIFF') {
        throw new Error('Invalid WAV: Missing RIFF header');
    }
    if (fileBuffer.toString('ascii', 8, 12)!== 'WAVE') {
        throw new Error('Invalid WAV: Missing WAVE format');
    }

    // 2. Chunk Walker: Iterate through chunks to find 'data'
    // Start after the 12-byte RIFF header
    let offset = 12;
    let audioData = null;

    while (offset < fileBuffer.length) {
        // Read Chunk ID (4 bytes)
        const chunkId = fileBuffer.toString('ascii', offset, offset + 4);
        // Read Chunk Size (4 bytes, Little Endian)
        const chunkSize = fileBuffer.readUInt32LE(offset + 4);
        
        console.log(` Found Chunk: '${chunkId}', Size: ${chunkSize} bytes`);

        if (chunkId === 'fmt ') {
            // Validate format to ensure it matches our mixing engine requirements
            const audioFormat = fileBuffer.readUInt16LE(offset + 8);
            const channels = fileBuffer.readUInt16LE(offset + 10);
            const sampleRate = fileBuffer.readUInt32LE(offset + 12);
            const bitsPerSample = fileBuffer.readUInt16LE(offset + 22);
            
            console.log(` Fmt Analysis: Format=${audioFormat} (1=PCM), Ch=${channels}, Rate=${sampleRate}, Depth=${bitsPerSample}`);
            
            if (audioFormat!== 1) throw new Error('WAV must be Linear PCM (Format 1)');
            if (channels!== 1) throw new Error('WAV must be Mono (1 Channel)');
            if (sampleRate!== 8000) throw new Error('WAV must be 8000Hz');
            if (bitsPerSample!== 16) throw new Error('WAV must be 16-bit');
        }

        if (chunkId === 'data') {
            // FOUND IT! The actual audio starts at offset + 8
            const start = offset + 8;
            const end = start + chunkSize;
            // Create a view into the buffer (efficient slicing)
            audioData = fileBuffer.subarray(start, end);
            console.log(` Audio Data Extracted: ${audioData.length} bytes`);
            break; // Stop parsing once data is found
        }

        // Move to next chunk: Current Offset + ID(4) + Size(4) + ChunkContent(chunkSize)
        offset += 8 + chunkSize;
    }

    if (!audioData) {
        throw new Error('Invalid WAV: No data chunk found in file');
    }

    return audioData;
}

// Pre-load audio to memory to avoid I/O latency during calls
let backgroundBuffer;
try {
    backgroundBuffer = parseWavFile(BACKGROUND_FILE_PATH);
} catch (e) {
    console.error(` Failed to load background audio: ${e.message}`);
    process.exit(1);
}

// ============================================================================
// PART 3: PACKET-CLOCK STREAM PROCESSOR
// ============================================================================

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Twilio Media Stream Mixer is Running');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log(' New Connection Initiated');
    
    // Stream State
    let streamSid = null;
    let backgroundOffset = 0; // Byte cursor for the background file
    let isStreamOpen = false;

    // Helper: Handle wrapping of background audio (Looping)
    // Returns a buffer of requested sizeBytes
    const getBackgroundChunk = (sizeBytes) => {
        let chunk = Buffer.alloc(sizeBytes);
        
        // If the request exceeds remaining file length, we must loop
        if (backgroundOffset + sizeBytes > backgroundBuffer.length) {
            const part1Len = backgroundBuffer.length - backgroundOffset;
            // Copy from cursor to end
            backgroundBuffer.copy(chunk, 0, backgroundOffset, backgroundBuffer.length);
            // Copy remaining amount from start (Loop)
            const part2Len = sizeBytes - part1Len;
            backgroundBuffer.copy(chunk, part1Len, 0, part2Len);
            // Reset cursor
            backgroundOffset = part2Len;
        } else {
            // Standard copy
            backgroundBuffer.copy(chunk, 0, backgroundOffset, backgroundOffset + sizeBytes);
            backgroundOffset += sizeBytes;
        }
        return chunk;
    };

    ws.on('message', (message) => {
        let msg;
        try {
            msg = JSON.parse(message);
        } catch (e) {
            console.error(' Error parsing JSON:', e);
            return;
        }

        if (msg.event === 'start') {
            streamSid = msg.start.streamSid;
            console.log(` Stream Started: ${streamSid}`);
            isStreamOpen = true;
            // Reset background track cursor
            backgroundOffset = 0;
        } 
        else if (msg.event === 'media') {
            if (!isStreamOpen) return;

            // 1. DECODE: Parse inbound payload (Base64 -> Buffer)
            const inboundPayload = Buffer.from(msg.media.payload, 'base64');
            
            // 2. PACKET CLOCK SYNC: 
            // The size of inboundPayload dictates the timing.
            // Typically 160 bytes for 20ms of 8kHz u-law.
            const sampleCount = inboundPayload.length; 

            // 3. FETCH BACKGROUND: Get corresponding linear samples
            // Background is 16-bit (2 bytes per sample). 
            // So we need 2 * sampleCount bytes.
            const bgChunkRaw = getBackgroundChunk(sampleCount * 2);
            
            // 4. MIXING LOOP
            // We allocate the output buffer for the same number of samples
            const mixedPayload = Buffer.alloc(sampleCount); // u-law is 1 byte/sample

            for (let i = 0; i < sampleCount; i++) {
                // A. Decode Inbound (u-law byte -> Linear Int16)
                // Use O(1) LUT
                const inboundSample = g711.decode(inboundPayload[i]);

                // B. Parse Background (Linear Byte Pair -> Linear Int16)
                // We must read 16-bit Little Endian from the wav bytes
                const bgSample = bgChunkRaw.readInt16LE(i * 2);

                // C. MIX: Simple Addition
                // This is where constructive interference occurs
                let mixed = inboundSample + bgSample;

                // D. SOFT CLIP / LIMITING
                // Prevent Integer Overflow (Wraparound distortion)
                // A value of 40000 becomes -25536 without clamping.
                if (mixed > 32767) mixed = 32767;
                if (mixed < -32768) mixed = -32768;

                // E. ENCODE: Linear Int16 -> u-law byte
                // Use O(1) LUT
                mixedPayload[i] = g711.encode(mixed);
            }

            // 5. TRANSMIT: Send mixed audio back immediately
            // We are responding to the 'tick' of the inbound packet.
            const response = {
                event: 'media',
                streamSid: streamSid,
                media: {
                    payload: mixedPayload.toString('base64')
                }
            };

            ws.send(JSON.stringify(response));
        } 
        else if (msg.event === 'stop') {
            console.log(` Stream Stopped: ${streamSid}`);
            isStreamOpen = false;
        }
        else if (msg.event === 'mark') {
            // Marks are used to label specific points in the stream, 
            // useful for debugging latency or handling barge-in logic.
            console.log(` Mark received: ${msg.mark.name}`);
        }
        else if (msg.event === 'clear') {
             // Handle Interruption:
             // If the user spoke and the AI is clearing the buffer, 
             // we might also want to reset our background music loop or 
             // jump to a specific timestamp.
             // For this implementation, we log the event.
             console.log(` Clear received for ${streamSid}`);
        }
    });

    ws.on('close', () => {
        console.log(' Client Disconnected');
        isStreamOpen = false;
    });
    
    ws.on('error', (error) => {
        console.error(' Error:', error);
    });
});

server.listen(HTTP_PORT, () => {
    console.log(` Listening on port ${HTTP_PORT}`);
    console.log(` Architecture: Input-Driven Packet Clock`);
    console.log(` DSP: G.711 LUT-based Transcoding`);
    console.log(` Ready to mix audio.`);
});
