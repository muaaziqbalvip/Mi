/**
 * MITV NETWORK - PRO SCANNING & MASKING ENGINE
 * OWNER: MUAAZ IQBAL
 * ORGANIZATION: MUSLIM ISLAM
 */

const axios = require('axios');

module.exports = async (req, res) => {
    const { user, stream, sid, name } = req.query;
    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host;

    // --- 1. LIVE MONITORING & REDIRECT ---
    if (stream && sid) {
        try {
            const realLink = Buffer.from(sid, 'base64').toString('ascii');
            const logData = {
                channel: name || "Unknown",
                ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress,
                ua: req.headers['user-agent'],
                time: new Date().toLocaleString()
            };
            await axios.post(`${dbUrl}/user_logs/${user}.json`, logData);
            return res.redirect(realLink);
        } catch (e) {
            return res.status(500).send("Stream Offline");
        }
    }

    if (!user) return res.status(400).send("User ID Required");

    try {
        const [userRes, playlistRes] = await Promise.all([
            axios.get(`${dbUrl}/master_users/${user}.json`),
            axios.get(`${dbUrl}/active_playlists/${user}.json`)
        ]);

        if (!userRes.data || !playlistRes.data) return res.status(404).send("Config Not Found");

        let finalM3U = "#EXTM3U\n";
        let stats = { total: 0, active: 0, dead: 0 };

        if (userRes.data.status !== 'Paid') {
            finalM3U += `#EXTINF:-1, EXPIRED - CONTACT MITV\n${playlistRes.data.warningVideo}\n`;
        } else {
            for (let source of playlistRes.data.sources) {
                try {
                    const response = await axios.get(source, { timeout: 5000 });
                    const lines = response.data.split('\n');

                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].startsWith('#EXTINF')) {
                            stats.total++;
                            let streamUrl = lines[i + 1]?.trim();

                            if (streamUrl && streamUrl.startsWith('http')) {
                                try {
                                    // Deep Scan: Check if individual channel link is alive
                                    await axios.head(streamUrl, { timeout: 2000 });
                                    
                                    const encoded = Buffer.from(streamUrl).toString('base64');
                                    const chName = lines[i].split(',')[1] || "Channel";
                                    const masked = `https://${host}/api/m3u?user=${user}&stream=true&name=${encodeURIComponent(chName)}&sid=${encoded}`;
                                    
                                    finalM3U += `${lines[i]}\n${masked}\n`;
                                    stats.active++;
                                } catch (err) {
                                    stats.dead++; // Link is dead
                                }
                                i++;
                            }
                        }
                    }
                } catch (e) { console.error("Source Down: " + source); }
            }
        }

        // Update Real-time Stats in Firebase
        await axios.patch(`${dbUrl}/global_stats/${user}.json`, {
            ...stats,
            last_scan: new Date().toLocaleTimeString()
        });

        res.setHeader('Content-Type', 'application/x-mpegurl');
        return res.status(200).send(finalM3U);

    } catch (error) {
        return res.status(500).send("System Error");
    }
};
