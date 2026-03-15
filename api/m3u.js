/**
 * MITV NETWORK - DEEP STREAM MASKING ENGINE
 * OWNER: MUAAZ IQBAL (MiTV Network)
 * Logic: Extracts every single channel and masks individual stream URLs.
 * Update: Added 3-attempt health check and offline fallback to mipay.mp4.
 */

const axios = require('axios');

module.exports = async (req, res) => {
    const { user, stream, sid } = req.query;
    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host; // Aapka domain (mitv-tan.vercel.app)
    const offlineVideo = `https://mitvnet.vercel.app/mipay.mp4`; // Offline hone par ye chalega

    // --- CASE 1: AGAR USER STREAM CHALA RAHA HAI (Validation & Redirect) ---
    if (stream && sid) {
        try {
            // Asli link nikalna (Base64 decode)
            const realLink = Buffer.from(sid, 'base64').toString('ascii');
            
            // User status check (Security)
            const userCheck = await axios.get(`${dbUrl}/master_users/${user}/status.json`);
            if (userCheck.data !== 'Paid') return res.status(403).send("Payment Required");

            // --- HEALTH CHECK LOGIC (3 Attempts) ---
            let isAlive = false;
            let attempts = 0;

            while (attempts < 3 && !isAlive) {
                try {
                    // Sirf headers check kar rahe hain taake speed fast rahe
                    const response = await axios.head(realLink, { timeout: 4000 });
                    if (response.status >= 200 && response.status < 400) {
                        isAlive = true;
                    }
                } catch (err) {
                    attempts++;
                    // Short delay before retry (Optional)
                }
            }

            if (isAlive) {
                // Agar channel chal raha hai
                return res.redirect(realLink);
            } else {
                // Agar 3 bar koshish ke baad bhi band hai
                return res.redirect(offlineVideo);
            }

        } catch (e) {
            // Kisi bhi error ki surat mein offline video par bhej dein
            return res.redirect(offlineVideo);
        }
    }

    // --- CASE 2: GENERATING MASKED M3U PLAYLIST (No changes to links or users) ---
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
                    const m3uResponse = await axios.get(sourceUrl, { timeout: 8000 });
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
        return res.status(500).send("Server Error: " + error.message);
    }
};
