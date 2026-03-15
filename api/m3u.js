/**
 * MITV NETWORK - OMNI STREAM ENGINE (v4.0 - ULTRA RETRY)
 * OWNER: MUAAZ IQBAL (MiTV Network)
 * Logic: 20x Aggressive Retry, Deep Masking, Device Tracking.
 */

const axios = require('axios');

// Fast delay helper
const wait = (ms) => new Promise(res => setTimeout(res, ms));

module.exports = async (req, res) => {
    const { user, stream, sid, cname } = req.query;
    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host;
    const offlineVideo = `https://${host}/mipay.mp4`;

    // --- CASE 1: STREAM PLAYBACK WITH 20 RETRIES ---
    if (stream && sid) {
        try {
            const realLink = Buffer.from(sid, 'base64').toString('ascii');
            const userAgent = req.headers['user-agent'] || "Unknown Device";
            const channelName = cname ? decodeURIComponent(cname) : "Direct Stream";

            // 1. Parallel Security & Tracking (No Wait)
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

            // 2. AGGRESSIVE RETRY LOGIC (15-20 Times)
            let isAlive = false;
            let attempts = 0;
            const maxAttempts = 20;

            while (attempts < maxAttempts && !isAlive) {
                try {
                    // HEAD request fast hoti hai aur data consume nahi karti
                    const check = await axios.head(realLink, { timeout: 1500 });
                    if (check.status >= 200 && check.status < 400) {
                        isAlive = true;
                    }
                } catch (err) {
                    attempts++;
                    // Agar 403 ya 405 error aye to direct redirect kardo (kuch servers check block karte hain)
                    if (err.response && (err.response.status === 403 || err.response.status === 405)) {
                        isAlive = true; 
                        break;
                    }
                    await wait(100); // 0.1 second ka gap
                }
            }

            if (isAlive) {
                return res.redirect(realLink);
            } else {
                // Agar 20 baar fail hua to offline video
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
            finalM3U += `#EXTINF:-1, ACCOUNT EXPIRED\n${offlineVideo}\n`;
        } else {
            for (let sourceUrl of config.sources) {
                try {
                    const m3uResponse = await axios.get(sourceUrl, { timeout: 8000 });
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
                } catch (e) { console.error("Source skip: " + sourceUrl); }
            }
        }

        res.setHeader('Content-Type', 'application/x-mpegurl');
        return res.status(200).send(finalM3U);

    } catch (error) {
        return res.status(500).send("Server Error");
    }
};
