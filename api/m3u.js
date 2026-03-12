/**
 * MITV MASTER ENGINE - VERSION 4.0 (ULTRA-STABLE)
 * OWNER: MUAAZ IQBAL (MiTV NETWORK)
 * PROJECT: MUSLIM ISLAM
 * SUPPORTED PLAYERS: Televizo, OTT Navigator, IPTV Smarters, VLC, TiviMate
 */

const axios = require('axios');

module.exports = async (req, res) => {
    // Xtream Codes standard parameters
    const { 
        user, password, username, action, 
        stream, sid, cid, type, stream_id 
    } = req.query;

    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const baseUrl = `${protocol}://${host}`;

    // Normalize Credentials (M3U or Xtream style)
    const finalUser = user || username;
    const finalPass = password;

    // --- ACTIVITY MONITORING LOGIC ---
    const recordActivity = async (uid, actionType, targetName) => {
        try {
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            const ua = req.headers['user-agent'] || "Unknown Device";
            const time = new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" });

            // Post to Activity Logs
            await axios.post(`${dbUrl}/activity_logs/${uid}.json`, {
                time,
                action: actionType,
                channel: targetName || "System",
                ip,
                device: ua
            });

            // Update User Stats in Realtime
            await axios.patch(`${dbUrl}/master_users/${uid}.json`, {
                last_seen: time,
                last_ip: ip,
                last_ua: ua
            });
        } catch (e) {
            console.error("Logging Error:", e.message);
        }
    };

    // --- 1. STREAM REDIRECT & MASKING (Individual Channel Play) ---
    // Sid is Base64 encoded real URL
    if (stream && sid && finalUser) {
        try {
            const userCheck = await axios.get(`${dbUrl}/master_users/${finalUser}.json`);
            if (!userCheck.data || userCheck.data.status !== 'Paid') {
                return res.status(403).send("Account Suspended. Contact MiTV.");
            }

            const realUrl = Buffer.from(sid, 'base64').toString('ascii');
            await recordActivity(finalUser, "Streaming", cid || "Live Channel");
            
            // 302 Redirect to the actual source (The Masking Magic)
            return res.redirect(302, realUrl);
        } catch (e) {
            return res.status(500).send("Stream Engine Error");
        }
    }

    // --- 2. XTREAM CODES API HANDSHAKE (Televizo/Smarters Support) ---
    if (finalUser && finalPass) {
        try {
            const userRes = await axios.get(`${dbUrl}/master_users/${finalUser}.json`);
            const userData = userRes.data;

            // Authentication Check
            if (!userData || userData.phone !== finalPass) {
                return res.status(200).json({ auth: 0, message: "Invalid Credentials" });
            }

            // Case: Login Only (Initial Connection)
            if (!action) {
                await recordActivity(finalUser, "Xtream Login", "Handshake Success");
                return res.json({
                    user_info: {
                        username: finalUser,
                        status: userData.status,
                        expiry_date: "1923456789", // Set far in future
                        is_trial: "0",
                        active_cons: "1",
                        max_connections: "1",
                        created_at: "1600000000"
                    },
                    server_info: {
                        url: host,
                        port: "80",
                        https_port: "443",
                        server_protocol: "https",
                        timezone: "Asia/Karachi",
                        timestamp: Math.floor(Date.now() / 1000)
                    }
                });
            }

            // Case: Live Categories (Televizo needs this to show the folder)
            if (action === 'get_live_categories') {
                return res.json([
                    { category_id: "1", category_name: "MiTV Global Channels", parent_id: 0 }
                ]);
            }

            // Case: Get Live Streams (Populating the channel list)
            if (action === 'get_live_streams') {
                const channelRes = await axios.get(`${dbUrl}/global_channels.json`);
                const channels = channelRes.data || {};
                let streams = [];

                Object.keys(channels).forEach((key, index) => {
                    const c = channels[key];
                    // Create masked link for the Xtream player
                    const maskedSid = Buffer.from(c.url).toString('base64');
                    const maskedUrl = `${baseUrl}/api/m3u?user=${finalUser}&stream=true&cid=${encodeURIComponent(c.name)}&sid=${maskedSid}`;

                    streams.push({
                        num: index + 1,
                        name: c.name,
                        stream_id: key,
                        stream_icon: c.logo || "",
                        category_id: "1",
                        epg_channel_id: "",
                        added: "1600000000",
                        custom_sid: "",
                        tv_archive: 0,
                        direct_source: maskedUrl, // Televizo reads this
                        thumbnail: c.logo || ""
                    });
                });
                return res.json(streams);
            }

            // Standard Empty Responses for VOD/Series to prevent player errors
            if (action === 'get_vod_categories' || action === 'get_series_categories') return res.json([]);
            if (action === 'get_vod_streams' || action === 'get_series_streams') return res.json([]);

        } catch (error) {
            console.error("API Crash:", error.message);
            return res.status(500).json({ auth: 0, error: "Internal Server Error" });
        }
    }

    // --- 3. M3U PLAYLIST FALLBACK (For M3U Links) ---
    if (finalUser) {
        try {
            const userRes = await axios.get(`${dbUrl}/master_users/${finalUser}.json`);
            const userData = userRes.data;

            if (!userData) return res.status(404).send("User Not Found");

            await recordActivity(finalUser, "M3U Fetch", "Full List");

            let m3uResponse = "#EXTM3U\n";

            if (userData.status !== 'Paid') {
                m3uResponse += `#EXTINF:-1 tvg-logo="https://cdn-icons-png.flaticon.com/512/5972/5972778.png", ACCOUNT SUSPENDED - PLEASE PAY\nhttps://example.com/pay_video.mp4\n`;
            } else {
                const channelRes = await axios.get(`${dbUrl}/global_channels.json`);
                const channels = channelRes.data || {};

                Object.keys(channels).forEach(key => {
                    const c = channels[key];
                    const maskedSid = Buffer.from(c.url).toString('base64');
                    const maskedUrl = `${baseUrl}/api/m3u?user=${finalUser}&stream=true&cid=${encodeURIComponent(c.name)}&sid=${maskedSid}`;
                    
                    m3uResponse += `#EXTINF:-1 tvg-logo="${c.logo || ''}" group-title="MiTV GLOBAL",${c.name}\n${maskedUrl}\n`;
                });
            }

            res.setHeader('Content-Type', 'audio/x-mpegurl');
            res.setHeader('Content-Disposition', `attachment; filename="mitv_${finalUser}.m3u"`);
            return res.status(200).send(m3uResponse);

        } catch (e) {
            return res.status(500).send("M3U Engine Error");
        }
    }

    // Default Error Response
    return res.status(400).send("MiTV Error: Authentication Required or Invalid Request");
};
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
                    
