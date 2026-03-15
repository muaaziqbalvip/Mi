/**
 * MITV NETWORK - DEEP STREAM MASKING ENGINE
 * OWNER: MUAAZ IQBAL (MiTV Network)
 * Logic: Extracts every single channel and masks individual stream URLs.
 * Update: Smart Health Check (Range-based) with 3 retries & intelligent fallback.
 */

const axios = require('axios');

// Retry delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async (req, res) => {
    const { user, stream, sid } = req.query;
    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host;
    const offlineVideo = `https://mitvnet.vercel.app/mipay.mp4`;

    if (stream && sid) {
        try {
            const realLink = Buffer.from(sid, 'base64').toString('ascii');
            
            // User status check
            const userCheck = await axios.get(`${dbUrl}/master_users/${user}/status.json`);
            if (userCheck.data !== 'Paid') return res.status(403).send("Payment Required");

            // --- IMPROVED HEALTH CHECK LOGIC ---
            let isAlive = false;
            let attempts = 0;
            const maxAttempts = 3;

            while (attempts < maxAttempts && !isAlive) {
                try {
                    // Range header use kiya hai taake server 'Live' signal de de bina heavy load ke
                    const response = await axios.get(realLink, { 
                        timeout: 7000, 
                        headers: { 'Range': 'bytes=0-0' },
                        validateStatus: (status) => status >= 200 && status < 400 
                    });
                    
                    if (response.status) {
                        isAlive = true;
                    }
                } catch (err) {
                    attempts++;
                    if (attempts < maxAttempts) await delay(500); // 0.5 second ruk kar dobara koshish
                }
            }

            if (isAlive) {
                // Agar check pass ho gaya
                return res.redirect(realLink);
            } else {
                // Agar 3 bar koshish fail hui, lekin hum ek 'Final Chance' redirect dete hain 
                // taake agar hamara check block ho raha ho tab bhi user ko video mil sake.
                // Agar bilkul hi dead link hai to player khud hi error dega ya offline video chalegi.
                try {
                    return res.redirect(realLink); 
                } catch (finalErr) {
                    return res.redirect(offlineVideo);
                }
            }

        } catch (e) {
            return res.redirect(offlineVideo);
        }
    }

    // --- CASE 2: M3U PLAYLIST GENERATION (Same as before) ---
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
                    const m3uResponse = await axios.get(sourceUrl, { timeout: 10000 });
                    const lines = m3uResponse.data.split('\n');

                    for (let i = 0; i < lines.length; i++) {
                        let line = lines[i].trim();
                        if (line.startsWith('#EXTINF')) {
                            let infoLine = line;
                            let streamLine = lines[i + 1] ? lines[i + 1].trim() : "";
                            if (streamLine.startsWith('http')) {
                                const encodedStream = Buffer.from(streamLine).toString('base64');
                                const maskedStreamUrl = `https://${host}/api/m3u?user=${user}&stream=true&sid=${encodedStream}`;
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
