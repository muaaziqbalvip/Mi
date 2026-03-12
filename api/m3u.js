// api/m3u.js
const axios = require('axios'); // M3U fetch karne ke liye

export default async function handler(req, res) {
    const { user } = req.query; // Link se user ID lega: ?user=MITV123

    if (!user) {
        return res.status(400).send("Error: No User ID provided.");
    }

    try {
        // 1. Firebase se User aur M3U Data uthana
        const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
        
        // User status check
        const userRes = await axios.get(`${dbUrl}/master_users/${user}.json`);
        const userData = userRes.data;

        // M3U Configuration check
        const configRes = await axios.get(`${dbUrl}/active_playlists/${user}.json`);
        const config = configRes.data;

        if (!userData || !config) {
            return res.status(404).send("#EXTM3U\n#EXTINF:-1,USER NOT FOUND");
        }

        let finalM3U = "#EXTM3U\n";

        // 2. PAYMENT CHECK LOGIC
        if (userData.status !== 'Paid') {
            // Unpaid user ke liye loop video
            finalM3U += `#EXTINF:-1 tvg-logo="https://cdn-icons-png.flaticon.com/512/5972/5972778.png", PLEASE PAY BILL - MiTV\n`;
            finalM3U += `${config.warningVideo || 'https://example.com/pay_now.mp4'}\n`;
        } else {
            // Paid user ke liye saare links ko combine aur mask karna
            for (let url of config.sources) {
                try {
                    const m3uData = await axios.get(url);
                    // Header nikaal kar baqi channels add karna
                    const cleaned = m3uData.data.replace("#EXTM3U", "").trim();
                    finalM3U += cleaned + "\n";
                } catch (e) {
                    console.log("Source link fail: " + url);
                }
            }
        }

        // 3. Response ko M3U file format mein bhejna
        res.setHeader('Content-Type', 'audio/x-mpegurl');
        res.setHeader('Content-Disposition', `attachment; filename="mitv_${user}.m3u"`);
        return res.send(finalM3U);

    } catch (error) {
        return res.status(500).send("Server Error: " + error.message);
    }
          }
                      
