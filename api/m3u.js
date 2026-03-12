/**
 * MITV NETWORK - HYBRID XTREAM API & M3U MASKER
 * OWNER: MUAAZ IQBAL (Founder MUSLIM ISLAM)
 */

const axios = require('axios');

module.exports = async (req, res) => {
    const { user, password, stream, sid, username, action } = req.query;
    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host;

    // --- 1. XTREAM CODES API LOGIC (player_api.php) ---
    // Xtream players 'username' aur 'password' query use karte hain
    const finalUser = user || username;
    const finalPass = password;

    if (finalUser && finalPass) {
        try {
            const userRes = await axios.get(`${dbUrl}/master_users/${finalUser}.json`);
            const userData = userRes.data;

            // Security Check: User aur Password (Phone) match hona chahiye
            if (!userData || userData.phone !== finalPass) {
                return res.status(403).json({ auth: 0, message: "Invalid Login" });
            }

            // Agar Player sirf Login check kar raha hai
            if (!action) {
                return res.json({
                    user_info: {
                        username: finalUser,
                        status: userData.status,
                        expiry_date: "1923456789", // Future date
                        is_trial: "0",
                        active_cons: "1",
                        max_connections: "1"
                    },
                    server_info: { url: host, port: "80", https_port: "443", server_protocol: "https" }
                });
            }

            // Agar Player "Live Streams" maang raha hai
            if (action === 'get_live_categories') {
                return res.json([{ category_id: "1", category_name: "MiTV All Channels", parent_id: 0 }]);
            }

            if (action === 'get_live_streams') {
                const configRes = await axios.get(`${dbUrl}/active_playlists/${finalUser}.json`);
                const config = configRes.data;
                let streams = [];

                if (userData.status === 'Paid' && config.sources) {
                    // Yahan hum M3U ko extract kar ke Xtream Format (JSON) mein convert karenge
                    // Abhi simple placeholder de raha hoon, asli links expand honge
                    streams.push({
                        num: 1, name: "Check M3U Link for Full List", stream_id: "1", 
                        stream_icon: "", category_id: "1", epg_channel_id: ""
                    });
                }
                return res.json(streams);
            }
        } catch (e) { return res.status(500).send("API Error"); }
    }

    // --- 2. DEEP STREAM MASKING (Vahi purana logic) ---
    if (stream && sid) {
        const realLink = Buffer.from(sid, 'base64').toString('ascii');
        return res.redirect(realLink);
    }

    // --- 3. M3U PLAYLIST GENERATOR ---
    if (finalUser) {
        try {
            const [userRes, configRes] = await Promise.all([
                axios.get(`${dbUrl}/master_users/${finalUser}.json`),
                axios.get(`${dbUrl}/active_playlists/${finalUser}.json`)
            ]);

            const userData = userRes.data;
            const config = configRes.data;

            if (!userData) return res.status(404).send("User not found");

            let finalM3U = "#EXTM3U\n";

            if (userData.status !== 'Paid') {
                finalM3U += `#EXTINF:-1, PAYMENT REQUIRED\n${config.warningVideo}\n`;
            } else {
                for (let sourceUrl of config.sources) {
                    try {
                        const m3uResponse = await axios.get(sourceUrl);
                        const lines = m3uResponse.data.split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            let line = lines[i].trim();
                            if (line.startsWith('#EXTINF')) {
                                let streamLine = lines[i+1]?.trim();
                                if (streamLine?.startsWith('http')) {
                                    const encoded = Buffer.from(streamLine).toString('base64');
                                    const masked = `https://${host}/api/m3u?user=${finalUser}&stream=true&sid=${encoded}`;
                                    finalM3U += `${line}\n${masked}\n`;
                                    i++;
                                }
                            }
                        }
                    } catch (e) {}
                }
            }
            res.setHeader('Content-Type', 'application/x-mpegurl');
            return res.status(200).send(finalM3U);
        } catch (error) { return res.status(500).send("M3U Error"); }
    }
};
