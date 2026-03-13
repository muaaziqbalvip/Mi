/**
 * MITV NETWORK - ULTRA MASKING & DEEP SCAN ENGINE
 * PROJECT: MUSLIM ISLAM | OWNER: MAAZ IQBAL
 */

const axios = require('axios');

module.exports = async (req, res) => {
    const { user, stream, sid, name } = req.query;
    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host;

    // --- SECTION 1: LIVE USER TRACKING & REDIRECT ---
    if (stream && sid) {
        try {
            const realLink = Buffer.from(sid, 'base64').toString('ascii');
            const logData = {
                channel: name || "Unknown Channel",
                ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress || "0.0.0.0",
                ua: req.headers['user-agent'] || "Unknown Device",
                time: new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })
            };
            // Firebase mein live tracking data bhejna
            await axios.post(`${dbUrl}/user_logs/${user}.json`, logData);
            return res.redirect(realLink);
        } catch (e) {
            return res.status(500).send("Stream Link Error");
        }
    }

    if (!user) return res.status(400).send("User ID is Required");

    try {
        // Firebase se data fetch karna
        const [userRes, playlistRes] = await Promise.all([
            axios.get(`${dbUrl}/master_users/${user}.json`),
            axios.get(`${dbUrl}/active_playlists/${user}.json`)
        ]);

        if (!userRes.data || !playlistRes.data) return res.status(404).send("Configuration Not Found");

        let finalM3U = "#EXTM3U\n";
        let stats = { total: 0, active: 0, dead: 0 };

        // Check if user is Paid
        if (userRes.data.status !== 'Paid') {
            finalM3U += `#EXTINF:-1, EXPIRED - CONTACT MITV NETWORK\n${playlistRes.data.warningVideo}\n`;
        } else {
            // Processing Multiple Sources (Library + Raw)
            const sources = playlistRes.data.sources || [];
            
            for (let source of sources) {
                try {
                    const response = await axios.get(source, { timeout: 6000 });
                    const lines = response.data.split('\n');

                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].startsWith('#EXTINF')) {
                            stats.total++;
                            let streamUrl = "";
                            
                            // Agli line check karna stream URL ke liye
                            if (lines[i+1] && lines[i+1].trim().startsWith('http')) {
                                streamUrl = lines[i+1].trim();
                            }

                            if (streamUrl) {
                                try {
                                    // DEEP SCAN: Channel link check karna
                                    await axios.head(streamUrl, { timeout: 2500 });
                                    
                                    const encoded = Buffer.from(streamUrl).toString('base64');
                                    const channelName = lines[i].split(',')[1] || "MiTV Channel";
                                    
                                    // Individual Channel Masking
                                    const maskedLink = `https://${host}/api/m3u?user=${user}&stream=true&name=${encodeURIComponent(channelName)}&sid=${encoded}`;
                                    
                                    finalM3U += `${lines[i]}\n${maskedLink}\n`;
                                    stats.active++;
                                } catch (scanErr) {
                                    stats.dead++; // Link response nahi de raha
                                }
                                i++; // Skip the next line as it was the URL
                            }
                        }
                    }
                } catch (sourceErr) {
                    console.error("M3U Source Down: " + source);
                }
            }
        }

        // Global Stats Update for Dashboard
        await axios.patch(`${dbUrl}/global_stats/${user}.json`, {
            ...stats,
            last_scan: new Date().toLocaleTimeString('en-PK', { timeZone: 'Asia/Karachi' })
        });

        res.setHeader('Content-Type', 'application/x-mpegurl');
        res.setHeader('Cache-Control', 'no-cache');
        return res.status(200).send(finalM3U);

    } catch (error) {
        return res.status(500).send("Internal Server Error");
    }
};
