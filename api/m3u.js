/**
 * MITV MASTER ENGINE - VERSION 5.0 (ADVANCED MASKING & TRACKING)
 * OWNER: MUAAZ IQBAL (MiTV NETWORK)
 * PROJECT: MUSLIM ISLAM
 */

const axios = require('axios');

module.exports = async (req, res) => {
    const { 
        user, password, username, action, 
        stream, sid, cid, token 
    } = req.query;

    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const baseUrl = `${protocol}://${host}`;

    // Normalize Credentials
    const finalUser = user || username || token; // Support for token-based M3U
    const finalPass = password;

    // --- DEEP TRACKING LOGIC ---
    const recordActivity = async (uid, actType, target) => {
        try {
            const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
            const ua = req.headers['user-agent'] || "Unknown";
            
            // Vercel automatically provides location in headers
            const city = req.headers['x-vercel-ip-city'] || "Unknown City";
            const country = req.headers['x-vercel-ip-country'] || "PK";
            
            const logEntry = {
                timestamp: Date.now(),
                user_name: uid,
                action: actType,
                target: target,
                ip: ip,
                location: `${city}, ${country}`,
                device: ua,
                software: ua.includes("Televizo") ? "Televizo" : 
                          ua.includes("OTTNav") ? "OTT Navigator" : 
                          ua.includes("Smarters") ? "IPTV Smarters" : "Web/Other"
            };

            // Push to Global Radar
            await axios.post(`${dbUrl}/activity_logs.json`, logEntry);
            
            // Update User Last Seen
            await axios.patch(`${dbUrl}/users/${uid}.json`, {
                last_active: Date.now(),
                last_ip: ip,
                last_loc: `${city}, ${country}`
            });
        } catch (e) { console.error("Log Error"); }
    };

    // --- CASE 1: STREAM MASKING (REDIRECT) ---
    if (stream === 'true' && sid && finalUser) {
        try {
            // Decrypt the source URL
            const realUrl = Buffer.from(sid, 'base64').toString('utf-8');
            const channelName = cid || "Live Stream";

            await recordActivity(finalUser, "WATCHING", channelName);
            
            // Direct 302 redirect to hide source
            return res.redirect(302, realUrl);
        } catch (e) {
            return res.status(500).send("Stream Engine Error");
        }
    }

    // --- CASE 2: XTREAM API (FOR APPS) ---
    if (finalUser && finalPass) {
        try {
            const uRes = await axios.get(`${dbUrl}/users/${finalUser}.json`);
            const uData = uRes.data;

            if (!uData) return res.json({ auth: 0, message: "Invalid User" });

            if (!action) {
                await recordActivity(finalUser, "LOGIN", "Xtream Handshake");
                return res.json({
                    user_info: { username: finalUser, status: "Active", expiry_date: "1923456789", active_cons: "1" },
                    server_info: { url: host, port: "80", https_port: "443", server_protocol: "https" }
                });
            }

            if (action === 'get_live_categories') return res.json([{ category_id: "1", category_name: "MiTV Global Pool" }]);

            if (action === 'get_live_streams') {
                const poolRes = await axios.get(`${dbUrl}/global_pool.json`);
                const pool = poolRes.data || {};
                let streams = [];

                Object.keys(pool).forEach((key, index) => {
                    const c = pool[key];
                    const maskedSid = Buffer.from(c.url).toString('base64');
                    // Masked URL format
                    const maskedUrl = `${baseUrl}/api/m3u?user=${finalUser}&stream=true&cid=${encodeURIComponent(c.name)}&sid=${maskedSid}`;

                    streams.push({
                        num: index + 1,
                        name: c.name,
                        stream_id: key,
                        stream_icon: c.logo || "",
                        category_id: "1",
                        url: maskedUrl
                    });
                });
                return res.json(streams);
            }
        } catch (e) { return res.status(500).json({ error: "API Crash" }); }
    }

    // --- CASE 3: PROFESSIONAL M3U GENERATION ---
    if (finalUser) {
        try {
            const uRes = await axios.get(`${dbUrl}/users/${finalUser}.json`);
            if (!uRes.data) return res.status(404).send("User Not Found");

            await recordActivity(finalUser, "FETCH_M3U", "Playlist Request");

            const poolRes = await axios.get(`${dbUrl}/global_pool.json`);
            const pool = poolRes.data || {};

            let m3u = "#EXTM3U\n";
            Object.keys(pool).forEach(key => {
                const c = pool[key];
                const maskedSid = Buffer.from(c.url).toString('base64');
                const maskedUrl = `${baseUrl}/api/m3u?user=${finalUser}&stream=true&cid=${encodeURIComponent(c.name)}&sid=${maskedSid}`;
                
                m3u += `#EXTINF:-1 tvg-id="${key}" tvg-logo="${c.logo}" group-title="MiTV NETWORK",${c.name}\n${maskedUrl}\n`;
            });

            res.setHeader('Content-Type', 'application/x-mpegurl');
            res.setHeader('Content-Disposition', 'attachment; filename="mitv.m3u"');
            return res.send(m3u);
        } catch (e) { return res.status(500).send("M3U Error"); }
    }

    return res.status(400).send("MiTV Engine: Invalid Request");
};
 return res.json([{ category_id: "1", category_name: "MiTV Global" }]);
            
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
                    
