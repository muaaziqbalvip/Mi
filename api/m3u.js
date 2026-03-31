/**
 * MITV NETWORK - OMNI STREAM ENGINE (v4.1 - ULTRA FAST + FULL RETRY)
 * OWNER: MUAAZ IQBAL (MiTV Network)
 * Logic: Concurrent M3U Loading, Fast Stream Ping Check, Retained Unpaid List.
 */

const axios = require('axios');

module.exports = async (req, res) => {
    // 1. Core Variables & Queries
    const { user, stream, sid, cname } = req.query;
    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host;
    const offlineVideo = `https://${host}/mioff.mp4`;
    const paidWarningVideo = `https://mitvnet.vercel.app/mipay.mp4`; // Paid warning video URL

    // =========================================================================
    // CASE 1: STREAM PLAYBACK & FALLBACK CHECKER
    // =========================================================================
    if (stream && sid) {
        try {
            // Decode the Base64 stream URL
            const realLink = Buffer.from(sid, 'base64').toString('ascii');
            const userAgent = req.headers['user-agent'] || "Unknown Device";
            const channelName = cname ? decodeURIComponent(cname) : "Direct Stream";
            const timestamp = new Date().toISOString();
            const userIP = req.headers['x-forwarded-for'] || "0.0.0.0";

            // Parallel Security & Tracking updates (Dashboard & History)
            const [userCheck] = await Promise.all([
                axios.get(`${dbUrl}/master_users/${user}/status.json`),
                // Update Current Activity for Dashboard
                axios.patch(`${dbUrl}/master_users/${user}/tracking.json`, {
                    last_played: channelName,
                    last_seen: timestamp,
                    device: userAgent,
                    ip: userIP
                }).catch(() => {}), // Ignore tracking errors to keep speed fast
                // Save to History Log
                axios.post(`${dbUrl}/master_users/${user}/history.json`, {
                    channel: channelName,
                    time: timestamp,
                    device: userAgent,
                    ip: userIP
                }).catch(() => {})
            ]);

            // If somehow the user becomes unpaid during playback, redirect to warning
            if (userCheck.data !== 'Paid') {
                return res.redirect(paidWarningVideo);
            }

            // FAST FALLBACK LOGIC: Check stream health quickly instead of 20x loop
            // We request only the first 100 bytes of the video stream. This is extremely fast.
            try {
                await axios.get(realLink, {
                    timeout: 2500, // Maximum wait time is 2.5 seconds for extremely fast start
                    headers: { 'Range': 'bytes=0-100' }
                });
                
                // If the check passes, immediately redirect the user to the real stream
                return res.redirect(realLink);
            } catch (err) {
                // Handle different types of errors smartly
                if (err.response) {
                    const status = err.response.status;
                    // Note: IPTV panels often block server IPs like Vercel (403/401/405 errors).
                    // If we get these, it means the server is ALIVE but blocking us. 
                    // We should still redirect because the user's home IP will likely work.
                    if ([401, 403, 405].includes(status)) {
                        return res.redirect(realLink);
                    }
                }
                
                // If it is a real error (Timeout, 404 Not Found, 500 Server Error),
                // the stream is dead behind the scenes. Show the offline fallback video!
                console.log(`[MiTV Fallback Triggered] Channel Offline: ${channelName}`);
                return res.redirect(offlineVideo);
            }

        } catch (e) {
            // Ultimate fallback if anything completely breaks
            return res.redirect(offlineVideo);
        }
    }

    // =========================================================================
    // CASE 2: M3U PLAYLIST GENERATION (ULTRA FAST)
    // =========================================================================
    if (!user) return res.status(400).send("No User ID Provided");

    try {
        // Fetch User Data and User Config (Playlists) at the SAME time
        const [userRes, configRes] = await Promise.all([
            axios.get(`${dbUrl}/master_users/${user}.json`),
            axios.get(`${dbUrl}/active_playlists/${user}.json`)
        ]);

        const userData = userRes.data;
        const config = configRes.data;

        if (!userData || !config || !config.sources) {
            return res.status(404).send("User or Playlists Not Found");
        }

        const isPaid = userData.status === 'Paid';
        let finalM3U = "#EXTM3U\n";

        // FAST PLAYLIST LOADING: Fetch all external M3U sources simultaneously
        const m3uPromises = config.sources.map(sourceUrl => 
            axios.get(sourceUrl, { timeout: 8000 }).catch(e => {
                console.error(`[MiTV Error] Failed to load source: ${sourceUrl}`);
                return null; // Return null if one list fails, so others keep working
            })
        );

        // Wait for all playlists to download
        const m3uResponses = await Promise.all(m3uPromises);

        // Process each downloaded playlist
        for (let m3uResponse of m3uResponses) {
            if (!m3uResponse || !m3uResponse.data) continue;

            const lines = m3uResponse.data.split('\n');

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i].trim();
                
                // If the line contains channel information
                if (line.startsWith('#EXTINF')) {
                    let infoLine = line;
                    let streamLine = lines[i + 1] ? lines[i + 1].trim() : "";
                    
                    // Validate that the next line is an actual URL
                    if (streamLine.startsWith('http')) {
                        let rawName = infoLine.split(',').pop() || "Channel";
                        let cleanName = encodeURIComponent(rawName.trim());
                        
                        // Encode the real stream URL
                        const encodedStream = Buffer.from(streamLine).toString('base64');
                        
                        // Mask the URL through your Vercel API
                        const maskedUrl = `https://${host}/api/m3u?user=${user}&stream=true&sid=${encodedStream}&cname=${cleanName}`;
                        
                        // UNPAID LOGIC: 
                        // If the user is unpaid, we keep the original channel name and logo (infoLine),
                        // but we replace the stream URL with the "Paid Warning Video".
                        const finalStreamUrl = isPaid ? maskedUrl : paidWarningVideo;

                        // Append to our final M3U text
                        finalM3U += `${infoLine}\n${finalStreamUrl}\n`;
                        i++; // Skip the stream line since we already processed it
                    }
                }
            }
        }

        // Send the complete, ultra-fast compiled M3U list to the player
        res.setHeader('Content-Type', 'application/x-mpegurl');
        return res.status(200).send(finalM3U);

    } catch (error) {
        console.error("[MiTV Critical] Server Error: ", error.message);
        return res.status(500).send("Server Error Generating Playlist");
    }
};
