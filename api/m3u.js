/**
 * MITV NETWORK - DEEP STREAM MASKING ENGINE (PRO)
 * OWNER: MUAAZ IQBAL (MiTV Network)
 * Features: High-speed redirect, User tracking, Device logging, Offline Fallback.
 */

const axios = require('axios');

module.exports = async (req, res) => {
    const { user, stream, sid, cname } = req.query;
    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host;
    const offlineVideo = `https://mitvnet.vercel.app/mipay.mp4`;

    // --- CASE 1: STREAM REDIRECT & TRACKING ---
    if (stream && sid) {
        try {
            const realLink = Buffer.from(sid, 'base64').toString('ascii');
            const userAgent = req.headers['user-agent'] || "Unknown Device";
            const channelName = cname || "Unknown Channel";

            // 1. User Status & Tracking (Parallel execution for speed)
            const [userCheck] = await Promise.all([
                axios.get(`${dbUrl}/master_users/${user}/status.json`),
                // Tracking data update in Firebase
                axios.patch(`${dbUrl}/master_users/${user}/tracking.json`, {
                    last_played: channelName,
                    last_seen: new Date().toISOString(),
                    device: userAgent,
                    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
                }).catch(e => console.log("Tracking Error"))
            ]);

            if (userCheck.data !== 'Paid') return res.status(403).send("Payment Required");

            // 2. Instant Redirect (Fast Playback)
            // Hum direct redirect kar rahe hain taake buffering na ho. 
            // Agar link bilkul dead hoga to catch block isse handle karega.
            return res.redirect(realLink);

        } catch (e) {
            return res.redirect(offlineVideo);
        }
    }

    // --- CASE 2: M3U GENERATION (With Tracking Parameters) ---
    if (!user) return res.status(400).send("No User ID");

    try {
        const [userRes, configRes] = await Promise.all([
            axios.get(`${dbUrl}/master_users/${user}.json`),
            axios.get(`${dbUrl}/active_playlists/${user}.json`)
        ]);

        const userData = userRes.data;
        const config = configRes.data;

        if (!userData || !config) return res.status(404).send("User/Config Not Found");

        let finalM3U = "#EXTM3U\n";

        if (userData.status !== 'Paid') {
            finalM3U += `#EXTINF:-1 tvg-logo="https://cdn-icons-png.flaticon.com/512/5972/5972778.png", PLEASE PAY BILL - MiTV\n`;
            finalM3U += `${config.warningVideo || 'https://example.com/pay.mp4'}\n`;
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
                                // Channel name extract karna tracking ke liye
                                const nameMatch = infoLine.match(/,(.*)$/);
                                const cleanName = nameMatch ? encodeURIComponent(nameMatch[1]) : "Channel";
                                
                                const encodedStream = Buffer.from(streamLine).toString('base64');
                                // Naya Link: isme cname (channel name) bhi add kiya hai tracking ke liye
                                const maskedStreamUrl = `https://${host}/api/m3u?user=${user}&stream=true&sid=${encodedStream}&cname=${cleanName}`;
                                
                                finalM3U += `${infoLine}\n${maskedStreamUrl}\n`;
                                i++; 
                            }
                        }
                    }
                } catch (e) { console.error("Source skip: " + sourceUrl); }
            }
        }

        res.setHeader('Content-Type', 'application/x-mpegurl');
        res.setHeader('Content-Disposition', `attachment; filename="mitv_masked_${user}.m3u"`);
        return res.status(200).send(finalM3U);

    } catch (error) {
        return res.status(500).send("Server Error");
    }
};
