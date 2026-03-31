/**
 * MITV NETWORK - OMNI STREAM ENGINE (v4.5 - HYPER FAST + SMART CACHE)
 * OWNER: MUAAZ IQBAL (MiTV Network)
 * Logic: Optimized Connection Pooling, Dynamic Status Caching, Parallel Parsing, tvg-logo injection.
 */

const axios = require('axios');
const http = require('http');
const https = require('https');

// --- SUPER FAST CONNECTION POOLING (AXIOS INSTANCE) ---
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const axiosClient = axios.create({
    httpAgent,
    httpsAgent,
    timeout: 8000 // Global default timeout
});

// --- Simple In-Memory Cache ---
const cache = {
    userStatus: {},
    playlists: {}
};

// Cache durations (in milliseconds)
const PAID_STATUS_CACHE_TIME = 10000; // 10 seconds only for Paid users (near realtime check)
const M3U_DATA_CACHE_TIME = 120000;  // 2 minutes for source playlist data

// MITV Logos
const MITV_ICON = "https://i.ibb.co/7Jbv5QZf/file-00000000305071fa945b58b012ac072b.png"; // Placeholder small logo for tvg-logo

module.exports = async (req, res) => {
    // res.setHeader('X-Engine-Author', 'MUAAZ IQBAL - MITV');
    
    // Core Variables & Queries
    const { user, stream, sid, cname } = req.query;
    const dbUrl = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host = req.headers.host;
    const offlineVideo = `https://${host}/mioff.mp4`;
    const paidWarningVideo = `https://mitvnet.vercel.app/mipay.mp4`; 

    // Time helper
    const now = Date.now();

    // =========================================================================
    // CASE 1: ULTRA-FAST STREAM PLAYBACK & FALLBACK PROXY
    // =========================================================================
    if (stream && sid) {
        try {
            // Decode stream URL
            const realLink = Buffer.from(sid, 'base64').toString('ascii');
            const userAgent = req.headers['user-agent'] || "Unknown Device";
            const channelName = cname ? decodeURIComponent(cname) : "Direct Stream";
            const timestamp = new Date().toISOString();
            const userIP = req.headers['x-forwarded-for'] || "0.0.0.0";

            // --- REALTIME STATUS CHECK WITH SMART CACHE ---
            let userStatus = null;
            const cachedUser = cache.userStatus[user];

            if (cachedUser && cachedUser.status === 'Paid' && (now - cachedUser.time < PAID_STATUS_CACHE_TIME)) {
                // If paid and under 10 seconds, use cache for speed.
                userStatus = 'Paid';
            } else {
                // Fetch fresh from Firebase (Connection Pooling makes it faster)
                const userCheck = await axiosClient.get(`${dbUrl}/master_users/${user}/status.json`);
                userStatus = userCheck.data;
                // Update Cache
                cache.userStatus[user] = {
                    status: userStatus,
                    time: now
                };
            }

            // Realtime tracking (Passive, we don't wait for this to finish)
            axiosClient.patch(`${dbUrl}/master_users/${user}/tracking.json`, {
                last_played: channelName,
                last_seen: timestamp,
                device: userAgent,
                ip: userIP
            }).catch(() => {});

            // If unpaid or cache outdated & fresh check is unpaid -> Block
            if (userStatus !== 'Paid') {
                return res.redirect(paidWarningVideo);
            }

            // --- ULTRA-LOW LATENCY PING CHECK ---
            try {
                // Extremely fast ping check - 1.5s timeout only
                await axiosClient.get(realLink, {
                    timeout: 1500, 
                    headers: { 'Range': 'bytes=0-100' }
                });
                
                // If alive, immediate redirect
                return res.redirect(realLink);
            } catch (err) {
                // Smart error handling (same logic as before, optimized)
                if (err.response && [401, 403, 405].includes(err.response.status)) {
                    return res.redirect(realLink); // Treat as server blocking, user's IP might work
                }
                // Stream is truly dead
                return res.redirect(offlineVideo);
            }

        } catch (e) {
            return res.redirect(offlineVideo);
        }
    }

    // =========================================================================
    // CASE 2: HYPER-FAST M3U PLAYLIST GENERATION (With Caching & MITV Logos)
    // =========================================================================
    if (!user) return res.status(400).send("No User ID");

    try {
        // Parallel fetch User Info and active playlists
        const [userRes, configRes] = await Promise.all([
            axiosClient.get(`${dbUrl}/master_users/${user}.json`),
            axiosClient.get(`${dbUrl}/active_playlists/${user}.json`)
        ]);

        const userData = userRes.data;
        const config = configRes.data;

        if (!userData || !config || !config.sources) return res.status(404).send("Config Not Found");

        const isPaid = userData.status === 'Paid';
        
        // Cache user status immediately for playback
        cache.userStatus[user] = { status: userData.status, time: now };

        let finalM3U = "#EXTM3U\n";

        // parallel fetching M3U sources with source-specific caching
        const m3uPromises = config.sources.map(async (sourceUrl) => {
            const cachedSource = cache.playlists[sourceUrl];
            if (cachedSource && (now - cachedSource.time < M3U_DATA_CACHE_TIME)) {
                return cachedSource.data; // Return cached m3u data
            }

            try {
                const response = await axiosClient.get(sourceUrl, { timeout: 10000 });
                if (response.data && typeof response.data === 'string') {
                    // Cache the fresh data
                    cache.playlists[sourceUrl] = { data: response.data, time: now };
                    return response.data;
                }
                return null;
            } catch (e) {
                return null; // Skip bad sources quickly
            }
        });

        const m3uDatas = await Promise.all(m3uPromises);

        // Process M3U data faster
        for (const m3uData of m3uDatas) {
            if (!m3uData) continue;

            const lines = m3uData.split('\n');

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i].trim();
                
                if (line.startsWith('#EXTINF')) {
                    let infoLine = line;
                    let streamLine = lines[i + 1] ? lines[i + 1].trim() : "";
                    
                    if (streamLine.startsWith('http')) {
                        let rawName = infoLine.split(',').pop() || "Channel";
                        let cleanName = encodeURIComponent(rawName.trim());
                        
                        // Mask URL
                        const encodedStream = Buffer.from(streamLine).toString('base64');
                        const maskedUrl = `https://${host}/api/m3u?user=${user}&stream=true&sid=${encodedStream}&cname=${cleanName}`;
                        
                        // INJECT MITV LOGO (This puts logo in channel list)
                        // This updates tvg-logo="original_logo" to tvg-logo="original_logo_or_MITV"
                        let updatedInfoLine = infoLine.replace(/tvg-logo="([^"]*)"/, `tvg-logo="${MITV_ICON}"`);
                        
                        // If no original logo found, inject one at the end of tags
                        if (!updatedInfoLine.includes('tvg-logo=')) {
                            updatedInfoLine = infoLine.replace('-1', `-1 tvg-logo="${MITV_ICON}"`);
                        }

                        // Use masked URL for Paid, Warning Video for Unpaid
                        const finalStreamUrl = isPaid ? maskedUrl : paidWarningVideo;

                        finalM3U += `${updatedInfoLine}\n${finalStreamUrl}\n`;
                        i++; // Skip URL line
                    }
                }
            }
        }

        // Send ultra-fast response
        res.setHeader('Content-Type', 'application/x-mpegurl');
        res.setHeader('Cache-Control', 'public, max-age=10'); // Client should cache M3U list for 10s only for efficiency
        return res.status(200).send(finalM3U);

    } catch (error) {
        return res.status(500).send("Engine Error");
    }
};
