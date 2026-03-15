/**
 * MITV NETWORK - OMNI STREAM ENGINE (v4.5 - TURBO RETRY)
 * OWNER: MUAAZ IQBAL (MiTV Network)
 * Logic: 20x Ultra-Fast Retries, 5s Max Wait, Deep Masking, Device Tracking.
 */

const axios = require('axios');

// Fast delay helper
const wait = (ms) => new Promise(res => setTimeout(res, ms));

module.exports = async (req, res) => {
    const { user, stream, sid, cname } = req.query;
    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host;
    const offlineVideo = `https://${host}/mipay.mp4`;

    // --- CASE 1: STREAM PLAYBACK WITH TURBO RETRY ---
    if (stream && sid) {
        try {
            const realLink = Buffer.from(sid, 'base64').toString('ascii');
            const userAgent = req.headers['user-agent'] || "Unknown Device";
            const channelName = cname ? decodeURIComponent(cname) : "Direct Stream";

            // 1. Parallel Security & Tracking (Instant)
            const [userCheck] = await Promise.all([
                axios.get(`${dbUrl}/master_users/${user}/status.json`),
                axios.patch(`${dbUrl}/master_users/${user}/tracking.json`, {
                    last_played: channelName,
                    last_seen: new Date().toISOString(),
                    device: userAgent,
                    ip: req.headers['x-forwarded-for'] || "0.0.0.0"
                }).catch(() => {})
            ]);

            if (userCheck.data !== 'Paid') return res.status(403).send("Payment Required");

            // 2. TURBO RETRY LOGIC (Fast & Focused)
            let isAlive = false;
            let attempts = 0;
            const maxAttempts = 15; // 15 fast attempts are enough

            while (attempts < maxAttempts && !isAlive) {
                try {
                    // Sirf 800ms ka waqt diya hai ek attempt ko
                    const check = await axios.get(realLink, { 
                        timeout: 800, 
                        headers: { 'Range': 'bytes=0-0' } 
                    });
                    
                    if (check.status >= 200 && check.status < 400) {
                        isAlive = true;
                    }
                } catch (err) {
                    attempts++;
                    // Agar server block kar raha hai (403/405), to seedha chala do
                    if (err.response && (err.response.status === 403 || err.response.status === 405 || err.response.status === 401)) {
                        isAlive = true; 
                        break;
                    }
                    // Bohat thora gap taake processing fast rahe
                    await wait(50); 
                }
            }

            if (isAlive) {
                return res.redirect(realLink);
            } else {
                // Agar saari koshishon ke baad bhi response nahi aaya
                return res.redirect(offlineVideo);
            }

        } catch (e) {
            return res.redirect(offlineVideo);
        }
    }

    // --- CASE 2: M3U PLAYLIST GENERATION ---
    if (!user) return res.status(400).send("No User ID");

    try {
        const [userRes, configRes] = await Promise.all([
            axios.get(`${dbUrl}/master_users/${user}.json`),
            axios.get(`${dbUrl}/active_playlists/${user}.json`)
        ]);

        const userData = userRes.data;
        const config = configRes.data;

        if (!userData || !config) return res.status(404).send("User Not Found");

        let finalM3U = "#EXTM3U\n";

        if (userData.status !== 'Paid') {
            finalM3U += `#EXTINF:-1 tvg-logo="https://cdn-icons-png.flaticon.com/512/5972/5972778.png", EXPIRED - MiTV\n${offlineVideo}\n`;
        } else {
            for (let sourceUrl of config.sources) {
                try {
                    const m3uResponse = await axios.get(sourceUrl, { timeout: 5000 });
                    const lines = m3uResponse.data.split('\n');

                    for (let i = 0; i < lines.length; i++) {
                        let line = lines[i].trim();
                        if (line.startsWith('#EXTINF')) {
                            let infoLine = line;
                            let streamLine = lines[i + 1] ? lines[i + 1].trim() : "";
                            
                            if (streamLine.startsWith('http')) {
                                let rawName = infoLine.split(',').pop() || "Channel";
                                let cleanName = encodeURIComponent(rawName.trim());
                                const encodedStream = Buffer.from(streamLine).toString('base64');
                                
                                const maskedUrl = `https://${host}/api/m3u?user=${user}&stream=true&sid=${encodedStream}&cname=${cleanName}`;
                                
                                finalM3U += `${infoLine}\n${maskedUrl}\n`;
                                i++; 
                            }
                        }
                    }
                } catch (e) { console.error("Source skip"); }
            }
        }

        res.setHeader('Content-Type', 'application/x-mpegurl');
        res.setHeader('Content-Disposition', `attachment; filename="mitv_${user}.m3u"`);
        return res.status(200).send(finalM3U);

    } catch (error) {
        return res.status(500).send("Server Error");
    }
};
                    
