/**
 * MITV NETWORK - CLOUD M3U MASKING ENGINE
 * PROJECT: MUSLIM ISLAM
 * OWNER: MUAAZ IQBAL
 */

const axios = require('axios');

module.exports = async (req, res) => {
    // URL se user ID lena (get/m3u/:user)
    const { user } = req.query;

    if (!user) {
        return res.status(400).send("#EXTM3U\n#EXTINF:-1, ERROR: NO USER ID PROVIDED");
    }

    try {
        const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
        
        // 1. Firebase se User Status aur Playlist Config aik saath uthana
        // Hum axios.all use kar rahe hain taake fast loading ho
        const [userRes, configRes] = await Promise.all([
            axios.get(`${dbUrl}/master_users/${user}.json`),
            axios.get(`${dbUrl}/active_playlists/${user}.json`)
        ]);

        const userData = userRes.data;
        const config = configRes.data;

        // Agar user database mein nahi milta
        if (!userData) {
            return res.status(404).send("#EXTM3U\n#EXTINF:-1, ERROR: USER NOT REGISTERED IN MITV");
        }

        // Agar user ki koi playlist config nahi bani hui
        if (!config) {
            return res.status(404).send("#EXTM3U\n#EXTINF:-1, ERROR: NO PLAYLIST FOUND FOR THIS USER");
        }

        let finalM3U = "#EXTM3U\n";

        // 2. PAYMENT & STATUS CHECK
        // 'Paid' ke spelling check kar lein Admin panel se
        if (userData.status !== 'Paid') {
            const warnImg = "https://cdn-icons-png.flaticon.com/512/5972/5972778.png";
            const warnVid = config.warningVideo || "https://example.com/payment_warning.mp4";
            
            finalM3U += `#EXTINF:-1 tvg-logo="${warnImg}" group-title="MITV ALERT", >>> PLEASE PAY YOUR BILL <<<\n`;
            finalM3U += `${warnVid}\n`;
            finalM3U += `#EXTINF:-1 tvg-logo="${warnImg}" group-title="MITV ALERT", CONTACT ADMIN TO ACTIVATE\n`;
            finalM3U += `${warnVid}\n`;
        } 
        else {
            // 3. PAID USER: Combine Multiple M3U Sources
            if (config.sources && Array.isArray(config.sources)) {
                for (let sourceUrl of config.sources) {
                    try {
                        // Har M3U source se data fetch karna
                        const m3uResponse = await axios.get(sourceUrl, { timeout: 5000 });
                        let rawData = m3uResponse.data;

                        // Header (#EXTM3U) ko remove karna taake duplicate na ho
                        let cleanedData = rawData.replace("#EXTM3U", "").trim();
                        finalM3U += cleanedData + "\n";
                    } catch (fetchErr) {
                        console.error(`Failed to fetch: ${sourceUrl}`);
                        finalM3U += `#EXTINF:-1, --- SOURCE ERROR: ${sourceUrl} ---\n#\n`;
                    }
                }
            } else {
                finalM3U += `#EXTINF:-1, NO SOURCES ADDED IN ADMIN PANEL\n#\n`;
            }
        }

        // 4. BROWSER/PLAYER RESPONSE HEADERS
        res.setHeader('Content-Type', 'application/x-mpegurl');
        res.setHeader('Content-Disposition', `attachment; filename="mitv_${user}.m3u"`);
        res.setHeader('Cache-Control', 'no-cache');
        
        return res.status(200).send(finalM3U);

    } catch (error) {
        console.error("System Crash:", error.message);
        return res.status(500).send("#EXTM3U\n#EXTINF:-1, MITV SERVER ERROR: " + error.message);
    }
};
    
