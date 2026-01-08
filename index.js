// 3. WebSocket Handler
wss.on('connection', (ws) => {
    console.log("[SYSTEM] Twilio connected");
    
    let streamSid = null;
    let elevenLabsWs = null;
    let audioQueue = [];

    const elevenLabsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${AGENT_ID}&output_format=ulaw_8000`;
    
    try {
        elevenLabsWs = new WebSocket(elevenLabsUrl, {
            headers: { 'xi-api-key': API_KEY }
        });
    } catch (err) {
        console.error('[Error] Setup failed:', err);
        return;
    }

    elevenLabsWs.on('open', () => console.log("[11LABS] Connected to AI"));

    // --- AI -> PHONE ( The Broken Part ) ---
    elevenLabsWs.on('message', (data) => {
        try {
            // Ensure data is a string before parsing
            const msgStr = data.toString();
            const msg = JSON.parse(msgStr);

            // Check if this is an audio packet
            if (msg.audio_event?.audio_base64_chunk) {
                const chunk = msg.audio_event.audio_base64_chunk;
                
                // DEBUG LOG: Prove we got data
                // console.log(`[11LABS] Received audio chunk: ${chunk.length} chars`);

                const audioPayload = {
                    event: 'media',
                    streamSid: streamSid,
                    media: { payload: chunk }
                };

                // Buffer Logic
                if (streamSid === null) {
                    audioQueue.push(audioPayload);
                    console.log("[Buffer] Queued chunk (Waiting for StreamSid)");
                } else {
                    ws.send(JSON.stringify(audioPayload));
                }
            }
        } catch (e) { 
            console.log('[11Labs Error] Parsing failed:', e); 
        }
    });

    // --- PHONE -> AI ( This works fine ) ---
    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);

            if (msg.event === 'start') {
                streamSid = msg.start.streamSid;
                console.log("[TWILIO] Stream started. ID:", streamSid);

                // Flush Queue
                if (audioQueue.length > 0) {
                    console.log(`[Buffer] Flushing ${audioQueue.length} chunks to phone.`);
                    audioQueue.forEach(chunk => {
                        chunk.streamSid = streamSid;
                        ws.send(JSON.stringify(chunk));
                    });
                    audioQueue = [];
                }

            } else if (msg.event === 'media') {
                if (elevenLabsWs.readyState === WebSocket.OPEN) {
                    const aiInput = {
                        user_audio_chunk: msg.media.payload
                    };
                    elevenLabsWs.send(JSON.stringify(aiInput));
                }
            } else if (msg.event === 'stop') {
                console.log("[TWILIO] Call ended");
                if (elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
            }
        } catch (e) { console.log('[Twilio Error]', e); }
    });

    ws.on('close', () => {
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) elevenLabsWs.close();
    });
});
