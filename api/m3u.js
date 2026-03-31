/**
 * MITV NETWORK - OMNI STREAM ENGINE (v4.6 - REALTIME + ORIGINAL LOGOS)
 * OWNER: MUAAZ IQBAL (MiTV Network)
 * Logic: Connection Pooling, Dynamic Status Caching, Preserves Original Logos.
 */

const axios = require('axios');
const http = require('http');
const https = require('https');

// --- HIGH-PERFORMANCE CONNECTION POOLING ---
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const axiosClient = axios.create({
    httpAgent,
    httpsAgent,
    timeout: 7000 // Fast timeout for better user experience
});

// --- IN-MEMORY CACHE ---
const cache = {
    userStatus: {},
    playlists: {}
};

const PAID_STATUS_CACHE_LIMIT = 10000; // 10 seconds (for near-instant status changes)
const M3U_CACHE_LIMIT = 120000;        // 2 minutes for source data

// MiTV Watermark Logo (Some players use this tag to show an overlay)
const MITV_WATERMARK = "https://i.ibb.co/7Jbv5QZf/file-00000000305071fa945b58b012ac072b.png";

module.exports = async (req, res) => {
    const { user, stream, sid, cname } = req.query;
    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host;
    const offlineVideo = `https://${host}/mioff.mp4`;
    const paidWarningVideo = `https://mitvnet.vercel.app/mipay.mp4`; 

    const now = Date.now();

    // =========================================================================
    // CASE 1: REALTIME STREAM PLAYBACK & FALLBACK
    // =========================================================================
    if (stream && sid) {
        try {
            const realLink = Buffer.from(sid, 'base64').toString('ascii');
            const userAgent = req.headers['user-agent'] || "Unknown Device";
            const channelName = cname ? decodeURIComponent(cname) : "Direct Stream";
            const timestamp = new Date().toISOString();
            const userIP = req.headers['x-forwarded-for'] || "0.0.0.0";

            // 1. SMART STATUS CHECK (Realtime balance)
            let userStatus = null;
            const cachedUser = cache.userStatus[user];

            if (cachedUser && cachedUser.status === 'Paid' && (now - cachedUser.time < PAID_STATUS_CACHE_LIMIT)) {
                userStatus = 'Paid';
            } else {
                // Fresh check from Firebase
                const userCheck = await axiosClient.get(`${dbUrl}/master_users/${user}/status.json`);
                userStatus = userCheck.data;
                cache.userStatus[user] = { status: userStatus, time: now };
            }

            // Passive Tracking (Does not block the stream start)
            axiosClient.patch(`${dbUrl}/master_users/${user}/tracking.json`, {
                last_played: channelName,
                last_seen: timestamp,
                device: userAgent,
                ip: userIP
            }).catch(() => {});

            // 2. UNPAID REDIRECT (Realtime fresh check)
            if (userStatus !== 'Paid') {
                return res.redirect(paidWarningVideo);
            }

            // 3. FAST FALLBACK PING
            try {
                await axiosClient.get(realLink, {
                    timeout: 2000, 
                    headers: { 'Range': 'bytes=0-100' }
                });
                return res.redirect(realLink);
            } catch (err) {
                // If it's a 403 or server restriction, redirect anyway (User IP might bypass)
                if (err.response && [401, 403, 405].includes(err.response.status)) {
                    return res.redirect(realLink);
                }
                // If stream is actually dead (404/Timeout)
                return res.redirect(offlineVideo);
            }

        } catch (e) {
            return res.redirect(offlineVideo);
        }
    }

    // =========================================================================
    // CASE 2: M3U PLAYLIST GENERATION (PRESERVING LOGOS)
    // =========================================================================
    if (!user) return res.status(400).send("No User ID");

    try {
        const [userRes, configRes] = await Promise.all([
            axiosClient.get(`${dbUrl}/master_users/${user}.json`),
            axiosClient.get(`${dbUrl}/active_playlists/${user}.json`)
        ]);

        const userData = userRes.data;
        const config = configRes.data;

        if (!userData || !config || !config.sources) return res.status(404).send("Config Error");

        const isPaid = userData.status === 'Paid';
        cache.userStatus[user] = { status: userData.status, time: now };

        let finalM3U = "#EXTM3U\n";
        // Tag for Branding (Some players show this as watermark)
        finalM3U += `#EXT-X-LOGO: ${MITV_WATERMARK}\n\n`;

        // Parallel fetch for all M3U sources
        const m3uPromises = config.sources.map(async (url) => {
            const cached = cache.playlists[url];
            if (cached && (now - cached.time < M3U_CACHE_LIMIT)) return cached.data;

            try {
                const res = await axiosClient.get(url, { timeout: 9000 });
                if (res.data) {
                    cache.playlists[url] = { data: res.data, time: now };
                    return res.data;
                }
            } catch (e) { return null; }
        });

        const allM3UData = await Promise.all(m3uPromises);

        for (const m3uContent of allM3UData) {
            if (!m3uContent) continue;

            const lines = m3uContent.split('\n');
            for (let i = 0; i < lines.length; i++) {
                let line = lines[i].trim();
                
                if (line.startsWith('#EXTINF')) {
                    let infoLine = line; 
                    let streamLine = lines[i+1] ? lines[i+1].trim() : "";
                    
                    if (streamLine.startsWith('http')) {
                        let rawName = infoLine.split(',').pop() || "Channel";
                        let cleanName = encodeURIComponent(rawName.trim());
                        const encodedStream = Buffer.from(streamLine).toString('base64');
                        
                        const maskedUrl = `https://${host}/api/m3u?user=${user}&stream=true&sid=${encodedStream}&cname=${cleanName}`;
                        
                        // Yahan hum infoLine ko as-is rehne dein ge (taake original logo na badle)
                        // Sirf logic apply karein ge Paid/Unpaid ki
                        const finalStreamUrl = isPaid ? maskedUrl : paidWarningVideo;

                        finalM3U += `${infoLine}\n${finalStreamUrl}\n`;
                        i++; 
                    }
                }
            }
        }

        res.setHeader('Content-Type', 'application/x-mpegurl');
        res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate');
        return res.status(200).send(finalM3U);

    } catch (error) {
        return res.status(500).send("Engine Critical Failure");
    }
};
