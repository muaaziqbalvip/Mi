/**
 * MITV NETWORK - OMNI STREAM ENGINE (v3.0 - PERFECTED)
 * OWNER: MUAAZ IQBAL (MiTV Network)
 * Logic: Deep Masking, Instant Play, 2s Fallback, Device & IP Tracking.
 */

const axios = require('axios');

module.exports = async (req, res) => {
    const { user, stream, sid, cname } = req.query;
    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host;
    const offlineVideo = `https://${host}/mipay.mp4`;

    // --- CASE 1: INDIVIDUAL STREAMING + TRACKING + FALLBACK ---
    if (stream && sid) {
        try {
            const realLink = Buffer.from(sid, 'base64').toString('ascii');
            const userAgent = req.headers['user-agent'] || "Unknown Device";
            const channelName = cname ? decodeURIComponent(cname) : "Direct Stream";
            const userIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || "0.0.0.0";

            // 1. Parallel Execution: Security Check + Tracking
            // Hamne 'await' sirf Security par lagaya hai, tracking background mein chalti rahegi.
            const [userCheck] = await Promise.all([
                axios.get(`${dbUrl}/master_users/${user}/status.json`),
                axios.patch(`${dbUrl}/master_users/${user}/tracking.json`, {
                    last_played: channelName,
                    last_seen: new Date().toISOString(),
                    device: userAgent,
                    ip: userIP
                }).catch(() => {}) // Tracking error ignore karein for speed
            ]);

            if (userCheck.data !== 'Paid') return res.status(403).send("Payment Required");

            // 2. Smart Fast Fallback Logic
            // Sirf 2 seconds check karega ke link alive hai ya nahi
            try {
                await axios.get(realLink, { 
                    timeout: 2000, 
                    headers: { 'Range': 'bytes=0-0' } 
                });
                return res.redirect(realLink);
            } catch (err) {
                // Agar 2s mein response nahi aya ya link dead hai
                console.log(`Link Down: ${channelName}`);
                return res.redirect(offlineVideo);
            }

        } catch (e) {
            return res.redirect(offlineVideo);
        }
    }

    // --- CASE 2: M3U PLAYLIST GENERATION (Optimized) ---
    if (!user) return res.status(400).send("No User ID Provided");

    try {
        const [userRes, configRes] = await Promise.all([
            axios.get(`${dbUrl}/master_users/${user}.json`),
            axios.get(`${dbUrl}/active_playlists/${user}.json`)
        ]);

        const userData = userRes.data;
        const config = configRes.data;

        if (!userData || !config) return res.status(404).send("Account Not Setup");

        let finalM3U = "#EXTM3U\n";

        // Status Check for Playlist
        if (userData.status !== 'Paid') {
            finalM3U += `#EXTINF:-1 tvg-logo="https://cdn-icons-png.flaticon.com/512/5972/5972778.png", ACCOUNT EXPIRED - MiTV\n`;
            finalM3U += `${offlineVideo}\n`;
        } else {
            // Loop through sources
            for (let sourceUrl of config.sources) {
                try {
                    const m3uResponse = await axios.get(sourceUrl, { timeout: 7000 });
                    const lines = m3uResponse.data.split('\n');

                    for (let i = 0; i < lines.length; i++) {
                        let line = lines[i].trim();
                        if (line.startsWith('#EXTINF')) {
                            let infoLine = line;
                            let streamLine = lines[i + 1] ? lines[i + 1].trim() : "";
                            
                            if (streamLine.startsWith('http')) {
                                // Clean Channel Name Extraction
                                let channelTitle = "Channel";
                                if (infoLine.includes(',')) {
                                    channelTitle = infoLine.split(',').pop().trim();
                                }

                                const encodedStream = Buffer.from(streamLine).toString('base64');
                                const encodedName = encodeURIComponent(channelTitle);
                                
                                // Generate Masked URL
                                const maskedUrl = `https://${host}/api/m3u?user=${user}&stream=true&sid=${encodedStream}&cname=${encodedName}`;
                                
                                finalM3U += `${infoLine}\n${maskedUrl}\n`;
                                i++; // Skip original URL
                            }
                        }
                    }
                } catch (e) { console.error("Source Down: " + sourceUrl); }
            }
        }

        res.setHeader('Content-Type', 'application/x-mpegurl');
        res.setHeader('Content-Disposition', `attachment; filename="mitv_${user}.m3u"`);
        return res.status(200).send(finalM3U);

    } catch (error) {
        return res.status(500).send("Core Engine Error");
    }
};
                
