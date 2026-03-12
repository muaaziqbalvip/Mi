/**
 * MITV CLOUD ENGINE - VER 3.0 (ULTRA MASKER)
 * PROJECT: MUSLIM ISLAM | OWNER: MUAAZ IQBAL
 * * FEATURES:
 * - Real-time Device Tracking
 * - IP & User-Agent Logging
 * - Dynamic Channel Extraction from Global Pool
 * - Xtream Codes API Compatibility
 */

const axios = require('axios');

module.exports = async (req, res) => {
    const { user, password, stream, sid, username, action, type } = req.query;
    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host;

    // Helper: Security & Logging
    const recordActivity = async (uid, actionName, chName, ip, ua) => {
        try {
            const timestamp = new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });
            const logRef = `${dbUrl}/activity_logs/${uid}.json`;
            await axios.post(logRef, {
                time: timestamp,
                action: actionName,
                channel: chName || "N/A",
                ip: ip,
                device: ua || "Unknown Device",
                status: "Active"
            });
            // Update User's Last Seen
            await axios.patch(`${dbUrl}/master_users/${uid}.json`, { 
                last_seen: timestamp, 
                last_ip: ip,
                last_device: ua 
            });
        } catch (e) { console.error("Logger Error"); }
    };

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    const finalUser = user || username;
    const finalPass = password;

    // -------------------------------------------------------------------
    // CASE 1: INDIVIDUAL STREAM REDIRECT (MASKING)
    // -------------------------------------------------------------------
    if (stream && sid && finalUser) {
        try {
            const realUrl = Buffer.from(sid, 'base64').toString('ascii');
            const userCheck = await axios.get(`${dbUrl}/master_users/${finalUser}.json`);
            
            if (!userCheck.data || userCheck.data.status !== 'Paid') {
                return res.status(403).send("Access Denied / Unpaid");
            }

            // Log which channel is being watched
            const channelId = req.query.cid || "Unknown";
            await recordActivity(finalUser, "Watching Channel", channelId, clientIp, userAgent);

            return res.redirect(302, realUrl);
        } catch (e) { return res.status(500).send("Stream Error"); }
    }

    // -------------------------------------------------------------------
    // CASE 2: XTREAM CODES API SUPPORT
    // -------------------------------------------------------------------
    if (finalUser && finalPass) {
        try {
            const uRes = await axios.get(`${dbUrl}/master_users/${finalUser}.json`);
            const uData = uRes.data;

            if (!uData || uData.phone !== finalPass) {
                return res.status(403).json({ auth: 0, message: "Invalid Credentials" });
            }

            await recordActivity(finalUser, "Xtream Login", "System", clientIp, userAgent);

            if (!action) {
                return res.json({
                    user_info: { username: finalUser, status: uData.status, expiry_date: "1923456789", active_cons: "1" },
                    server_info: { url: host, port: "80", https_port: "443", server_protocol: "https" }
                });
            }

            // Categories & Streams
            if (action === 'get_live_categories') return res.json([{ category_id: "1", category_name: "MiTV Global" }]);
            
            if (action === 'get_live_streams') {
                const chRes = await axios.get(`${dbUrl}/global_channels.json`);
                const channels = chRes.data || {};
                let output = [];
                Object.keys(channels).forEach(key => {
                    const c = channels[key];
                    const masked = `https://${host}/api/m3u?user=${finalUser}&stream=true&cid=${encodeURIComponent(c.name)}&sid=${Buffer.from(c.url).toString('base64')}`;
                    output.push({ num: key, name: c.name, stream_id: key, stream_icon: c.logo || "", category_id: "1", url: masked });
                });
                return res.json(output);
            }
        } catch (e) { return res.status(500).send("API Fail"); }
    }

    // -------------------------------------------------------------------
    // CASE 3: FULL M3U PLAYLIST GENERATION
    // -------------------------------------------------------------------
    if (finalUser) {
        try {
            const uRes = await axios.get(`${dbUrl}/master_users/${finalUser}.json`);
            const uData = uRes.data;

            if (!uData) return res.status(404).send("User Not Found");

            await recordActivity(finalUser, "Playlist Downloaded", "Full M3U", clientIp, userAgent);

            let m3u = "#EXTM3U\n";
            if (uData.status !== 'Paid') {
                m3u += `#EXTINF:-1 tvg-logo="https://i.imgur.com/8Nn7Y9o.png", >>> ACCOUNT SUSPENDED - CONTACT MITV <<<\nhttps://example.com/pay.mp4\n`;
            } else {
                const chRes = await axios.get(`${dbUrl}/global_channels.json`);
                const channels = chRes.data || {};
                
                Object.keys(channels).forEach(key => {
                    const c = channels[key];
                    const masked = `https://${host}/api/m3u?user=${finalUser}&stream=true&cid=${encodeURIComponent(c.name)}&sid=${Buffer.from(c.url).toString('base64')}`;
                    m3u += `#EXTINF:-1 tvg-logo="${c.logo || ''}" group-title="${c.group || 'General'}",${c.name}\n${masked}\n`;
                });
            }

            res.setHeader('Content-Type', 'application/x-mpegurl');
            return res.send(m3u);
        } catch (e) { return res.status(500).send("M3U Engine Crash"); }
    }

    res.status(400).send("MiTV Engine: Invalid Request");
};
                    
