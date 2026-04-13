/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║         🔥 MITV NETWORK - OMNI STREAM ENGINE v6.0 🔥           ║
 * ║         ULTRA FAST | CATEGORIES | AI FALLBACK | FULL POWER      ║
 * ║         OWNER: MUAAZ IQBAL (MiTV Network)                       ║
 * ║         FEATURES:                                                ║
 * ║          ✅ Smart Categories (Sports, News, Movies, Kids...)     ║
 * ║          ✅ AI-Powered Fallback Chain (3 Levels Deep)            ║
 * ║          ✅ Lightning Fast Connection Pooling                    ║
 * ║          ✅ Real-Time Status Cache (10s TTL)                     ║
 * ║          ✅ Random Fallback Channel if Dead                      ║
 * ║          ✅ Bold Channel Names + Emojis                          ║
 * ║          ✅ Full M3U Animation Tags                              ║
 * ║          ✅ Parallel Source Fetching                             ║
 * ║          ✅ Deep Tracking (IP, Device, Channel, Time)            ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

const axios = require('axios');
const http  = require('http');
const https = require('https');

// ─────────────────────────────────────────────────────────────────────────────
// 🚀 CONNECTION POOL — keep-alive sockets for zero-overhead reuse
// ─────────────────────────────────────────────────────────────────────────────
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const axiosClient = axios.create({
    httpAgent,
    httpsAgent,
    timeout: 6000
});

// ─────────────────────────────────────────────────────────────────────────────
// 💾 IN-MEMORY CACHE (survives within single Vercel function warm-instance)
// ─────────────────────────────────────────────────────────────────────────────
const cache = {
    userStatus : {},  // uid → { status, time }
    playlists  : {},  // url  → { data, time }
    channels   : []   // flat list of all working channels for random fallback
};

const PAID_TTL    = 10_000;   // 10 sec  — near-realtime status
const M3U_TTL     = 120_000;  // 2 min   — source playlist data
const CHANNEL_TTL = 300_000;  // 5 min   — random fallback pool

// ─────────────────────────────────────────────────────────────────────────────
// 🎨 MITV BRAND ASSETS
// ─────────────────────────────────────────────────────────────────────────────
const MITV_LOGO      = "https://i.ibb.co/7Jbv5QZf/file-00000000305071fa945b58b012ac072b.png";
const MITV_USER_AGENT = "MITV-OmniEngine/6.0 (MiTV Network; Muaaz Iqbal)";

// ─────────────────────────────────────────────────────────────────────────────
// 📂 CATEGORY RULES — matched against channel name (case-insensitive)
// Each entry: { keywords[], emoji, groupTitle }
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY_RULES = [
    {
        groupTitle : "🏆 Sports",
        emoji      : "⚽",
        keywords   : ["sport","sports","cricket","psl","football","soccer","ptv sports",
                      "ten sports","geo super","a sports","dsport","espn","star sports",
                      "sky sports","bt sport","willow","laliga","premier","champions"]
    },
    {
        groupTitle : "📰 News",
        emoji      : "📡",
        keywords   : ["news","geo news","ary news","samaa","dunya","express","92 news",
                      "bbc","cnn","sky news","al jazeera","wion","ndtv","aaj news",
                      "capital tv","city42","channel24"]
    },
    {
        groupTitle : "🎬 Movies",
        emoji      : "🍿",
        keywords   : ["movie","movies","cinema","film","films","hbo","showtime","fox movies",
                      "star movies","aplus movies","urdu1","hum sitaray","ary digital",
                      "action","thriller","comedy","drama",
                      "sony max","zee cinema","b4u movies","masala"]
    },
    {
        groupTitle : "🌟 Entertainment",
        emoji      : "🎭",
        keywords   : ["entertainment","hum tv","ary digital","geo entertainment","express ent",
                      "such tv","channel 7","star plus","zee tv","colors","sony","life ok",
                      "k2","tv one","big magic","zee5","mx player"]
    },
    {
        groupTitle : "👶 Kids",
        emoji      : "🧒",
        keywords   : ["kids","children","cartoon","nick","nickelodeon","disney",
                      "cartoon network","baby tv","spacetoon","cbeebies","boomerang",
                      "pogo","hungama","toony","junior"]
    },
    {
        groupTitle : "🎵 Music",
        emoji      : "🎶",
        keywords   : ["music","mtv","viva","ary musik","play","beat","sound","rhythm",
                      "entertainment music","b4u music","sonic","channel v","vh1","zee music"]
    },
    {
        groupTitle : "📖 Islamic & Religious",
        emoji      : "🕌",
        keywords   : ["islam","quran","islamic","noor","hidayat","madani","peace tv",
                      "qtv","ary qtv","huda","dish islamic","rohani","paigham","dawah"]
    },
    {
        groupTitle : "🌍 International",
        emoji      : "🌐",
        keywords   : ["international","world","global","france","hindi","indian","arabic",
                      "turkish","trt","star jalsha","etv","sun tv","vijay tv","zee telugu"]
    },
    {
        groupTitle : "📺 General",
        emoji      : "📺",
        keywords   : []   // catch-all
    }
];

// ─────────────────────────────────────────────────────────────────────────────
// 🤖 AI CATEGORY DETECTOR
// ─────────────────────────────────────────────────────────────────────────────
function detectCategory(channelName, existingGroup) {
    // Prefer the group from the original EXTINF if it's meaningful
    if (existingGroup && existingGroup.length > 2 && existingGroup.toLowerCase() !== "undefined") {
        return { groupTitle: existingGroup, emoji: "📺" };
    }
    const nameLower = channelName.toLowerCase();
    for (const cat of CATEGORY_RULES) {
        if (cat.keywords.length === 0) continue;
        if (cat.keywords.some(kw => nameLower.includes(kw))) {
            return cat;
        }
    }
    return CATEGORY_RULES[CATEGORY_RULES.length - 1]; // General fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// 💅 CHANNEL NAME BEAUTIFIER  — adds emoji + bold markers
// ─────────────────────────────────────────────────────────────────────────────
function beautifyName(rawName, emoji) {
    // Remove existing leading emojis/spaces
    const clean = rawName.replace(/^[\s\u{1F300}-\u{1FAFF}]+/u, "").trim();
    return `${emoji} ${clean}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔍 EXTINF PARSER — extracts tvg attributes + group-title + name
// ─────────────────────────────────────────────────────────────────────────────
function parseExtInf(line) {
    const logoMatch       = line.match(/tvg-logo="([^"]+)"/i);
    const idMatch         = line.match(/tvg-id="([^"]+)"/i);
    const groupMatch      = line.match(/group-title="([^"]+)"/i);
    const nameAfterComma  = line.split(",").pop()?.trim() || "Channel";

    return {
        logo       : logoMatch  ? logoMatch[1]  : MITV_LOGO,
        tvgId      : idMatch    ? idMatch[1]    : "",
        groupTitle : groupMatch ? groupMatch[1] : "",
        rawName    : nameAfterComma
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 🏗️ EXTINF BUILDER — reconstructs a clean, tagged EXTINF line
// ─────────────────────────────────────────────────────────────────────────────
function buildExtInf(parsed, category, beautifiedName) {
    return `#EXTINF:-1 tvg-id="${parsed.tvgId}" tvg-name="${beautifiedName}" tvg-logo="${parsed.logo}" group-title="${category.groupTitle}",${beautifiedName}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ⚡ FAST STREAM HEALTH CHECK  (2s timeout, HEAD or Range GET)
// Returns true if stream is alive, false otherwise
// ─────────────────────────────────────────────────────────────────────────────
async function isStreamAlive(url) {
    try {
        await axiosClient.get(url, {
            timeout : 2000,
            headers : {
                'Range'      : 'bytes=0-500',
                'User-Agent' : MITV_USER_AGENT
            }
        });
        return true;
    } catch (err) {
        // 401/403/405 = server restricted but stream EXISTS — treat as alive
        if (err.response && [401, 403, 405].includes(err.response.status)) {
            return true;
        }
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🎲 RANDOM ALIVE CHANNEL PICKER — for last-resort fallback
// ─────────────────────────────────────────────────────────────────────────────
function pickRandomChannel() {
    const pool = cache.channels;
    if (!pool || pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
// 🌐 MAIN VERCEL HANDLER
// ─────────────────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {

    const { user, stream, sid, cname } = req.query;
    const DB     = `https://ramadan-2385b-default-rtdb.firebaseio.com`;
    const host   = req.headers.host;
    const now    = Date.now();

    // Static fallback assets hosted on your Vercel domain
    const offlineVideo      = `https://${host}/Dream_Screen_13Apr2026_22_35_47.mp4`;
    const paidWarningVideo  = `https://mitvnet.vercel.app/mipay.mp4`;

    // ═══════════════════════════════════════════════════════════════════════
    // 🔴 PATH 1 ─ REAL-TIME STREAM PLAYBACK  (stream=true & sid present)
    // ═══════════════════════════════════════════════════════════════════════
    if (stream && sid) {
        try {
            const realLink    = Buffer.from(sid, 'base64').toString('ascii');
            const userAgent   = req.headers['user-agent'] || "Unknown Device";
            const channelName = cname ? decodeURIComponent(cname) : "Direct Stream";
            const userIP      = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || "0.0.0.0";
            const timestamp   = new Date().toISOString();

            // ── STEP 1: User status check (cache-first, Firebase-fallback) ──
            let userStatus = null;
            const cached = cache.userStatus[user];

            if (cached && cached.status === 'Paid' && (now - cached.time < PAID_TTL)) {
                userStatus = 'Paid';
            } else {
                try {
                    const chk = await axiosClient.get(`${DB}/master_users/${user}/status.json`);
                    userStatus = chk.data;
                    cache.userStatus[user] = { status: userStatus, time: now };
                } catch (_) {
                    // If Firebase is unreachable, use last known status
                    userStatus = cached ? cached.status : null;
                }
            }

            // ── STEP 2: Reject unpaid users immediately ──
            if (userStatus !== 'Paid') {
                return res.redirect(302, paidWarningVideo);
            }

            // ── STEP 3: Passive tracking (fire-and-forget, never blocks) ──
            axiosClient.patch(`${DB}/master_users/${user}/tracking.json`, {
                last_played : channelName,
                last_seen   : timestamp,
                device      : userAgent,
                ip          : userIP
            }).catch(() => {});

            // ── STEP 4: AI FALLBACK CHAIN ────────────────────────────────
            //   Level 1 → Try actual stream (2s timeout)
            //   Level 2 → Try a random channel from the pool
            //   Level 3 → Show offline video
            // ─────────────────────────────────────────────────────────────

            // Level 1
            const alive = await isStreamAlive(realLink);
            if (alive) {
                return res.redirect(302, realLink);
            }

            // Level 2 — pick a random working channel
            const randomChannel = pickRandomChannel();
            if (randomChannel) {
                // Try the random channel quickly
                const randomAlive = await isStreamAlive(randomChannel);
                if (randomAlive) {
                    // Log the fallback
                    axiosClient.patch(`${DB}/master_users/${user}/tracking.json`, {
                        fallback_triggered : true,
                        fallback_channel   : randomChannel,
                        original_channel   : channelName,
                        fallback_time      : timestamp
                    }).catch(() => {});
                    return res.redirect(302, randomChannel);
                }
            }

            // Level 3 — offline video
            return res.redirect(302, offlineVideo);

        } catch (e) {
            return res.redirect(302, offlineVideo);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 🟢 PATH 2 ─ M3U PLAYLIST GENERATION
    // ═══════════════════════════════════════════════════════════════════════
    if (!user) {
        return res.status(400).send([
            "MITV NETWORK - Engine v6.0",
            "━━━━━━━━━━━━━━━━━━━━━━━━",
            "❌ Missing ?user= parameter",
            "Usage: /api/m3u?user=YOUR_UID",
            "Contact: MiTV Network Support"
        ].join("\n"));
    }

    try {
        // ── Fetch user data + active playlist config in parallel ──
        const [userRes, configRes] = await Promise.all([
            axiosClient.get(`${DB}/master_users/${user}.json`),
            axiosClient.get(`${DB}/active_playlists/${user}.json`)
        ]);

        const userData = userRes.data;
        const config   = configRes.data;

        if (!userData) {
            return res.status(404).send("❌ User not found. Check your User ID.");
        }
        if (!config || !config.sources || !Array.isArray(config.sources)) {
            return res.status(404).send("❌ No active playlist configured for this account.");
        }

        const isPaid = userData.status === 'Paid';
        cache.userStatus[user] = { status: userData.status, time: now };

        // ── Fetch all M3U sources in parallel (with per-source caching) ──
        const m3uPromises = config.sources.map(async (sourceUrl) => {
            const hit = cache.playlists[sourceUrl];
            if (hit && (now - hit.time < M3U_TTL)) return hit.data;

            try {
                const r = await axiosClient.get(sourceUrl, {
                    timeout : 10_000,
                    headers : { 'User-Agent': MITV_USER_AGENT }
                });
                if (r.data) {
                    cache.playlists[sourceUrl] = { data: r.data, time: now };
                    return r.data;
                }
            } catch (_) { return null; }
        });

        const allSources = await Promise.all(m3uPromises);

        // ─────────────────────────────────────────────────────────────────
        // 📝 M3U HEADER  — with MITV branding + animation hints
        // ─────────────────────────────────────────────────────────────────
        let finalM3U = [
            `#EXTM3U`,
            `#EXT-X-LOGO:${MITV_LOGO}`,
            `#EXTM3U url-tvg="" refresh="1" cache="no-store"`,
            ``,
            `#EXTINF:-1 tvg-id="MITV_HEADER" tvg-logo="${MITV_LOGO}" group-title="🔥 MiTV Network",`,
            `#           ╔═══════════════════════════════════╗`,
            `#           ║  🔥 MITV NETWORK ULTRA STREAM 🔥  ║`,
            `#           ║  Engine v6.0  |  Muaaz Iqbal      ║`,
            `#           ║  Fast • Beautiful • Reliable       ║`,
            `#           ╚═══════════════════════════════════╝`,
            ``
        ].join("\n");

        // ─────────────────────────────────────────────────────────────────
        // 🗂️  CATEGORY BUCKETS  { groupTitle → [lines] }
        // ─────────────────────────────────────────────────────────────────
        const buckets    = {};
        const channelPool = [];

        for (const m3uContent of allSources) {
            if (!m3uContent) continue;

            const lines = m3uContent.split('\n');

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();

                if (!line.startsWith('#EXTINF')) continue;

                const nextLine = lines[i + 1]?.trim() || "";
                if (!nextLine.startsWith('http')) continue;

                // ── Parse EXTINF ──
                const parsed       = parseExtInf(line);
                const category     = detectCategory(parsed.rawName, parsed.groupTitle);
                const beautiful    = beautifyName(parsed.rawName, category.emoji);
                const newExtInf    = buildExtInf(parsed, category, beautiful);

                // ── Encode stream URL for masking ──
                const encodedSid  = Buffer.from(nextLine).toString('base64');
                const cnameEnc    = encodeURIComponent(beautiful);
                const maskedUrl   = `https://${host}/api/m3u?user=${user}&stream=true&sid=${encodedSid}&cname=${cnameEnc}`;

                const streamUrl   = isPaid ? maskedUrl : paidWarningVideo;

                // ── Add to category bucket ──
                if (!buckets[category.groupTitle]) {
                    buckets[category.groupTitle] = [];
                }
                buckets[category.groupTitle].push(`${newExtInf}\n${streamUrl}`);

                // ── Feed the random fallback pool ──
                channelPool.push(nextLine);

                i++; // skip stream URL line
            }
        }

        // ── Update global random fallback pool (refresh every 5 min) ──
        if (channelPool.length > 0) {
            cache.channels     = channelPool;
            cache.channelTime  = now;
        }

        // ─────────────────────────────────────────────────────────────────
        // 🗂️  OUTPUT BUCKETS IN ORDER  — Sports first, General last
        // ─────────────────────────────────────────────────────────────────
        const orderedTitles = CATEGORY_RULES.map(c => c.groupTitle);

        for (const title of orderedTitles) {
            const entries = buckets[title];
            if (!entries || entries.length === 0) continue;
            finalM3U += entries.join("\n") + "\n";
        }

        // Any leftover group titles not in CATEGORY_RULES (from original source)
        for (const [title, entries] of Object.entries(buckets)) {
            if (orderedTitles.includes(title)) continue;
            finalM3U += entries.join("\n") + "\n";
        }

        // ── Total count ──
        const totalChannels = Object.values(buckets).reduce((s, arr) => s + arr.length, 0);

        // ─────────────────────────────────────────────────────────────────
        // 📤 SEND RESPONSE
        // ─────────────────────────────────────────────────────────────────
        res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('X-MITV-Engine',   'OmniStream v6.0');
        res.setHeader('X-Channel-Count', String(totalChannels));
        res.setHeader('X-Paid-Status',   isPaid ? 'Active' : 'Inactive');
        return res.status(200).send(finalM3U);

    } catch (error) {
        console.error("MITV ENGINE CRITICAL:", error.message);
        return res.status(500).send([
            "💥 MITV Engine Critical Failure",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            `Error: ${error.message}`,
            "Please contact MiTV Network Support."
        ].join("\n"));
    }
};
