/**
 * MITV NETWORK - DEEP STREAM MASKING ENGINE
 * OWNER: MUAAZ IQBAL (MiTV Network)
 * Logic: Extracts every single channel and masks individual stream URLs.
 */

const axios = require('axios');

module.exports = async (req, res) => {
    const { user, stream, sid } = req.query;
    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host; // Aapka domain (mitv-tan.vercel.app)

    // --- CASE 1: AGAR USER STREAM CHALA RAHA HAI (Individual Link Masking) ---
    if (stream && sid) {
        try {
            // Decrypt/Get the real link from sid (Security check)
            const realLink = Buffer.from(sid, 'base64').toString('ascii');
            // User status check (Security)
            const userCheck = await axios.get(`${dbUrl}/master_users/${user}/status.json`);
            if (userCheck.data !== 'Paid') return res.status(403).send("Payment Required");
            
            // Redirect to real video stream
            return res.redirect(realLink);
        } catch (e) {
            return res.status(500).send("Stream Error");
        }
    }

    // --- CASE 2: GENERATING MASKED M3U PLAYLIST ---
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
            // Loop through all M3U sources
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
                                // --- INDIVIDUAL CHANNEL MASKING LOGIC ---
                                // Asli link ko Base64 mein convert kar rahe hain taake nazar na aaye
                                const encodedStream = Buffer.from(streamLine).toString('base64');
                                
                                // Naya Masked Link banayein jo hamare hi API ko call karega
                                const maskedStreamUrl = `https://${host}/api/m3u?user=${user}&stream=true&sid=${encodedStream}`;
                                
                                finalM3U += `${infoLine}\n${maskedStreamUrl}\n`;
                                i++; // Agli line (asli link) skip karein kyunke humne mask kar diya
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
                
