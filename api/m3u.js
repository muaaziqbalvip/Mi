/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║        🔥 MITV NETWORK — OMNI STREAM ENGINE v7.0 🔥                    ║
 * ║        OWNER : MUAAZ IQBAL | MUSLIM ISLAM | KASUR, PUNJAB, PAKISTAN    ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  ✅ Firebase User Name → First Channel (Welcome Channel per user)       ║
 * ║  ✅ M3U group-title ORDER preserved (original M3U sequence)             ║
 * ║  ✅ Smart AI Category Detection (fallback if no group in M3U)           ║
 * ║  ✅ Multi-layer Stream Security (Base64 + HMAC URL Masking)             ║
 * ║  ✅ 3-Level AI Fallback Chain (Live → Pool → Offline)                   ║
 * ║  ✅ Ultra-Fast Parallel Fetch + Connection Pooling                      ║
 * ║  ✅ Dual-Store Cache (Memory + Firebase .json backup)                   ║
 * ║  ✅ Real-Time User Status Check (10s TTL)                               ║
 * ║  ✅ Passive Deep Tracking (IP, Device, Channel, Timestamp)              ║
 * ║  ✅ Category sorted: M3U native order, unknowns appended at bottom      ║
 * ║  ✅ Channel logos from source, fallback to MITV logo                    ║
 * ║  ✅ Zero blocking calls — all fire-and-forget tracking                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

'use strict';

const axios  = require('axios');
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════════════
// 🔧 CONFIG — Edit these if needed
// ═══════════════════════════════════════════════════════════════════════════
const CFG = {
    DB            : 'https://ramadan-2385b-default-rtdb.firebaseio.com',
    LOGO          : 'https://i.ibb.co/Xxpt0B54/IMG-20260415-223746-removebg-preview.png',
    UA            : 'MiTV-Engine/7.0 (MITV Network; muaaziqbal)',
    // HMAC signing secret for stream URL masking (change in production)
    SIGN_SECRET   : 'MiTV_MuaazIqbal_2026_ULTRA_SECRET',
    // TTLs (milliseconds)
    TTL_STATUS    : 10_000,    // user paid status cache
    TTL_M3U       : 180_000,   // source M3U cache (3 min)
    TTL_BACKUP    : 600_000,   // Firebase backup interval (10 min)
    // Timeouts
    TO_STREAM     : 2_500,     // stream alive check
    TO_M3U        : 12_000,    // M3U source fetch
    TO_FIREBASE   : 4_000,     // Firebase REST
    // Max channels per category before truncation (0 = unlimited)
    MAX_PER_CAT   : 0,
};

// ═══════════════════════════════════════════════════════════════════════════
// 🚀 HTTP AGENTS — Keep-alive connection pool
// ═══════════════════════════════════════════════════════════════════════════
const httpAgent  = new http.Agent({  keepAlive: true, maxSockets: 80, maxFreeSockets: 20 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 80, maxFreeSockets: 20 });

const ax = axios.create({ httpAgent, httpsAgent, timeout: 8000 });

// ═══════════════════════════════════════════════════════════════════════════
// 💾 IN-MEMORY CACHE
// ═══════════════════════════════════════════════════════════════════════════
const CACHE = {
    status    : {},   // uid  → { v: 'Paid'|'Blocked', t: timestamp }
    m3u       : {},   // url  → { v: string,           t: timestamp }
    channels  : [],   // flat array of raw stream URLs (for random fallback)
    chTime    : 0,    // last channels update time
    users     : {},   // uid  → { name, ... } from Firebase
    userTime  : {},   // uid  → timestamp of last user fetch
    backup    : {},   // last backup snapshots
};

// ═══════════════════════════════════════════════════════════════════════════
// 🔐 SECURITY HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/** Sign a value with HMAC-SHA256 (hex, 8 chars) */
function sign(value) {
    return crypto.createHmac('sha256', CFG.SIGN_SECRET)
        .update(value)
        .digest('hex')
        .slice(0, 8);
}

/** Encode a stream URL for masking */
function maskStream(rawUrl, user) {
    const b64  = Buffer.from(rawUrl).toString('base64url');
    const sig  = sign(b64 + user);
    return { b64, sig };
}

/** Verify a masked stream */
function verifyStream(b64, sig, user) {
    return sign(b64 + user) === sig;
}

/** Decode masked stream to real URL */
function unmaskStream(b64) {
    try {
        return Buffer.from(b64, 'base64url').toString('utf8');
    } catch {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 📂 CATEGORY RULES
// Priority order: first match wins. M3U native group-title takes precedence.
// ═══════════════════════════════════════════════════════════════════════════
const CAT_RULES = [
    {
        id         : 'sports',
        groupTitle : '🏆 Sports',
        emoji      : '⚽',
        keywords   : [
            'sport','sports','cricket','psl','ipl','football','soccer',
            'ptv sports','ten sports','geo super','a sports','dsport',
            'espn','star sports','sky sports','bt sport','willow','laliga',
            'premier league','champions league','serie a','bundesliga',
            'tennis','hockey','kabaddi','wrestling','ufc','f1','formula',
            'olympics','athletic','game','ptv','geo super'
        ]
    },
    {
        id         : 'news',
        groupTitle : '📰 News',
        emoji      : '📡',
        keywords   : [
            'news','geo news','ary news','samaa','dunya','express','92 news',
            'bbc','cnn','sky news','al jazeera','wion','ndtv','aaj news',
            'capital tv','city42','channel24','bol news','such tv news',
            'abc news','nbc news','fox news','reuters','update','live news',
            'breaking','headline','tonight','alert','report'
        ]
    },
    {
        id         : 'movies',
        groupTitle : '🎬 Movies',
        emoji      : '🍿',
        keywords   : [
            'movie','movies','cinema','film','films','hbo','showtime',
            'fox movies','star movies','aplus movies','ary digital movies',
            'sony max','zee cinema','b4u movies','masala','action','thriller',
            'comedy channel','drama','classic','premiere','plex','cinemax',
            'hallmark','lifetime','tmc','fxx','starz','epix'
        ]
    },
    {
        id         : 'entertainment',
        groupTitle : '🌟 Entertainment',
        emoji      : '🎭',
        keywords   : [
            'entertainment','hum tv','ary digital','geo entertainment',
            'express ent','such tv','channel 7','star plus','zee tv',
            'colors','sony','life ok','k2','tv one','big magic','zee5',
            'hum sitaray','urdu1','star jalsha','sony aath','rishtey',
            'comedy','drama','serial','show','reality','talk show',
            'variety','lifestyle','fashion','talkshow'
        ]
    },
    {
        id         : 'kids',
        groupTitle : '👶 Kids',
        emoji      : '🧒',
        keywords   : [
            'kids','children','cartoon','nick','nickelodeon','disney',
            'cartoon network','baby tv','spacetoon','cbeebies','boomerang',
            'pogo','hungama','toony','junior','toon','animated','animation',
            'kinder','youth','family','learning','educational'
        ]
    },
    {
        id         : 'music',
        groupTitle : '🎵 Music',
        emoji      : '🎶',
        keywords   : [
            'music','mtv','viva','ary musik','play','beat','sound','rhythm',
            'b4u music','sonic','channel v','vh1','zee music','coke studio',
            'raaga','eros now music','bollywood music','soundhound',
            'hits','radio','fm','jukebox','pop','classical music','rap'
        ]
    },
    {
        id         : 'islamic',
        groupTitle : '📖 Islamic & Religious',
        emoji      : '🕌',
        keywords   : [
            'islam','quran','islamic','noor','hidayat','madani','peace tv',
            'qtv','ary qtv','huda','dish islamic','rohani','paigham','dawah',
            'deen','masjid','mosque','salah','namaz','ramadan','dua','hadith',
            'sunnah','fatwa','mufti','ulama','religious'
        ]
    },
    {
        id         : 'documentary',
        groupTitle : '🔬 Documentary',
        emoji      : '🌍',
        keywords   : [
            'documentary','nat geo','national geographic','discovery',
            'history','history channel','animal planet','science','nature',
            'planet','universe','cosmos','explore','world','travel channel',
            'biography','bio','investigation','crime','true story'
        ]
    },
    {
        id         : 'international',
        groupTitle : '🌐 International',
        emoji      : '🌏',
        keywords   : [
            'international','world','global','france','hindi','indian',
            'arabic','turkish','trt','star jalsha','etv','sun tv','vijay tv',
            'zee telugu','india','iran','afghanistan','uk','usa','arab',
            'persian','desi','bengali','tamil','telugu','malayalam','marathi'
        ]
    },
    {
        id         : 'general',
        groupTitle : '📺 General',
        emoji      : '📺',
        keywords   : []   // catch-all — always last
    }
];

/** Map of groupTitle → CAT_RULES index (for fast lookup) */
const CAT_INDEX = new Map(CAT_RULES.map((c, i) => [c.groupTitle, i]));

// ═══════════════════════════════════════════════════════════════════════════
// 🤖 CATEGORY DETECTOR
// Logic:
//  1. If M3U has group-title → use it AS-IS (preserve M3U order)
//  2. Else → keyword match on channel name
//  3. Fallback → General
// ═══════════════════════════════════════════════════════════════════════════
function detectCategory(rawName, m3uGroup) {
    // Use original M3U group if it is meaningful
    if (m3uGroup && m3uGroup.trim().length > 1 && m3uGroup.toLowerCase() !== 'undefined') {
        return { groupTitle: m3uGroup.trim(), emoji: '📺', fromM3U: true };
    }
    const lower = rawName.toLowerCase();
    for (const cat of CAT_RULES) {
        if (!cat.keywords.length) continue;
        if (cat.keywords.some(kw => lower.includes(kw))) {
            return { groupTitle: cat.groupTitle, emoji: cat.emoji, fromM3U: false };
        }
    }
    return { groupTitle: '📺 General', emoji: '📺', fromM3U: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// 💅 CHANNEL NAME BEAUTIFIER
// ═══════════════════════════════════════════════════════════════════════════
function beautifyName(raw, emoji) {
    // Remove leading emojis/whitespace from original
    const clean = raw
        .replace(/^[\s\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]+/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!clean) return `${emoji} Channel`;
    return `${emoji} ${clean}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 🔍 EXTINF PARSER
// ═══════════════════════════════════════════════════════════════════════════
function parseExtInf(line) {
    const logo       = line.match(/tvg-logo="([^"]+)"/i)?.[1]  || CFG.LOGO;
    const tvgId      = line.match(/tvg-id="([^"]+)"/i)?.[1]    || '';
    const tvgName    = line.match(/tvg-name="([^"]+)"/i)?.[1]  || '';
    const groupTitle = line.match(/group-title="([^"]+)"/i)?.[1] || '';
    const afterComma = line.split(',').pop()?.trim()            || 'Channel';
    const rawName    = afterComma || tvgName || 'Channel';

    return { logo, tvgId, groupTitle, rawName };
}

// ═══════════════════════════════════════════════════════════════════════════
// 🏗️ EXTINF BUILDER
// ═══════════════════════════════════════════════════════════════════════════
function buildExtInf(parsed, cat, displayName, logo) {
    const finalLogo = logo || parsed.logo || CFG.LOGO;
    return `#EXTINF:-1 tvg-id="${parsed.tvgId}" tvg-name="${displayName}" tvg-logo="${finalLogo}" group-title="${cat.groupTitle}",${displayName}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 🎯 WELCOME CHANNEL — Personalized first channel per user (from Firebase)
// ═══════════════════════════════════════════════════════════════════════════
function buildWelcomeChannel(userName, host, user) {
    const name      = userName ? `🌟 Welcome — ${userName}` : '🌟 Welcome to MITV Network';
    const logoUrl   = CFG.LOGO;
    const streamUrl = `https://${host}/api/m3u?user=${user}&stream=true&welcome=1`;
    return [
        `#EXTINF:-1 tvg-id="MITV_WELCOME" tvg-name="${name}" tvg-logo="${logoUrl}" group-title="🔥 MiTV Network",${name}`,
        streamUrl
    ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// ⚡ STREAM HEALTH CHECK — 2.5s timeout, fast HEAD/Range
// ═══════════════════════════════════════════════════════════════════════════
async function isStreamAlive(url) {
    try {
        await ax.get(url, {
            timeout : CFG.TO_STREAM,
            headers : { Range: 'bytes=0-1023', 'User-Agent': CFG.UA }
        });
        return true;
    } catch (err) {
        // 4xx response means server is alive (just restricted)
        if (err.response && [401, 403, 405, 416].includes(err.response.status)) {
            return true;
        }
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 🎲 RANDOM CHANNEL PICKER
// ═══════════════════════════════════════════════════════════════════════════
function pickRandom() {
    const pool = CACHE.channels;
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
}

// ═══════════════════════════════════════════════════════════════════════════
// 💾 FIREBASE BACKUP HELPER — writes playlist snapshot to Firebase
// Fire-and-forget — never blocks the main response
// ═══════════════════════════════════════════════════════════════════════════
function backupToFirebase(user, totalChannels, categoryTitles) {
    const now  = Date.now();
    const last = CACHE.backup[user] || 0;
    if (now - last < CFG.TTL_BACKUP) return; // skip if backed up recently
    CACHE.backup[user] = now;

    const payload = {
        last_m3u_gen  : new Date(now).toISOString(),
        total_channels: totalChannels,
        categories    : categoryTitles,
        engine        : 'OmniStream v7.0'
    };

    ax.patch(`${CFG.DB}/master_users/${user}/m3u_meta.json`, payload)
        .catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// 👤 FIREBASE USER NAME FETCHER — cached per user
// ═══════════════════════════════════════════════════════════════════════════
async function getUserName(user) {
    const cached = CACHE.users[user];
    const age    = CACHE.userTime[user] || 0;
    if (cached && (Date.now() - age < 60_000)) return cached; // 1 min cache

    try {
        const r = await ax.get(`${CFG.DB}/master_users/${user}/name.json`, {
            timeout: CFG.TO_FIREBASE
        });
        const name = (r.data && typeof r.data === 'string') ? r.data : null;
        CACHE.users[user]    = name;
        CACHE.userTime[user] = Date.now();
        return name;
    } catch (_) {
        return cached || null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 📥 FETCH M3U SOURCE — cached
// ═══════════════════════════════════════════════════════════════════════════
async function fetchM3U(sourceUrl) {
    const hit = CACHE.m3u[sourceUrl];
    if (hit && (Date.now() - hit.t < CFG.TTL_M3U)) return hit.v;

    try {
        const r = await ax.get(sourceUrl, {
            timeout : CFG.TO_M3U,
            headers : { 'User-Agent': CFG.UA }
        });
        if (r.data && typeof r.data === 'string') {
            CACHE.m3u[sourceUrl] = { v: r.data, t: Date.now() };
            return r.data;
        }
    } catch (_) { /* silent */ }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 🗂️  PARSE M3U → ORDERED CATEGORY BUCKETS
//
// Category ORDER strategy:
//  1. Walk channels in M3U order
//  2. Track first-seen order of each group title
//  3. Output categories in that exact first-seen order
//  4. Smart-detected categories (no group-title in M3U) appended after
// ═══════════════════════════════════════════════════════════════════════════
function parseM3UToBuckets(m3uContent, host, user, isPaid, paidWarningUrl) {
    const buckets    = new Map(); // groupTitle → string[]
    const orderM3U   = [];        // titles in M3U first-seen order
    const orderAI    = [];        // titles from AI detection (no M3U group)
    const pool       = [];        // raw URLs for fallback pool

    const lines = m3uContent.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith('#EXTINF')) continue;

        const nextLine = lines[i + 1]?.trim() || '';
        if (!nextLine.startsWith('http')) continue;

        const parsed  = parseExtInf(line);
        const cat     = detectCategory(parsed.rawName, parsed.groupTitle);
        const beauty  = beautifyName(parsed.rawName, cat.emoji);

        // Encode stream URL with HMAC signature
        const { b64, sig } = maskStream(nextLine, user);
        const cnEnc = encodeURIComponent(beauty);
        const maskedUrl = isPaid
            ? `https://${host}/api/m3u?user=${user}&stream=true&sid=${b64}&sig=${sig}&cname=${cnEnc}`
            : paidWarningUrl;

        const extinf  = buildExtInf(parsed, cat, beauty, parsed.logo);
        const entry   = `${extinf}\n${maskedUrl}`;

        // Track insertion order
        const gt = cat.groupTitle;
        if (!buckets.has(gt)) {
            buckets.set(gt, []);
            if (cat.fromM3U) {
                if (!orderM3U.includes(gt)) orderM3U.push(gt);
            } else {
                if (!orderAI.includes(gt)) orderAI.push(gt);
            }
        }
        buckets.get(gt).push(entry);

        // Build fallback pool (raw URLs only)
        pool.push(nextLine);

        i++; // skip URL line
    }

    return { buckets, orderM3U, orderAI, pool };
}

// ═══════════════════════════════════════════════════════════════════════════
// 🌐 MAIN VERCEL HANDLER
// ═══════════════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
    const { user, stream, sid, sig, cname, welcome } = req.query;
    const host = req.headers.host || 'mitvnet.vercel.app';
    const now  = Date.now();

    const offlineVideo    = `https://${host}/Dream_Screen_13Apr2026_22_35_47.mp4`;
    const paidWarningUrl  = `https://mitvnet.vercel.app/mipay.mp4`;

    // ─────────────────────────────────────────────────────────────────────
    // 🔴 PATH 1 — WELCOME STREAM (personalized channel)
    // ─────────────────────────────────────────────────────────────────────
    if (stream === 'true' && welcome === '1') {
        // Redirect to a generic MITV intro/offline video as welcome
        return res.redirect(302, offlineVideo);
    }

    // ─────────────────────────────────────────────────────────────────────
    // 🔴 PATH 2 — REAL-TIME STREAM PLAYBACK
    // ─────────────────────────────────────────────────────────────────────
    if (stream === 'true' && sid) {

        // 1. Verify HMAC signature
        if (!user || !verifyStream(sid, sig || '', user)) {
            return res.status(403).send('❌ Invalid stream signature. Contact MITV Support.');
        }

        const realLink    = unmaskStream(sid);
        if (!realLink || !realLink.startsWith('http')) {
            return res.redirect(302, offlineVideo);
        }

        const channelName = cname ? decodeURIComponent(cname) : 'Direct Stream';
        const userAgent   = req.headers['user-agent'] || 'Unknown';
        const userIP      = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || '0.0.0.0';
        const timestamp   = new Date().toISOString();

        // 2. User status check (cache-first)
        let userStatus = null;
        const cs = CACHE.status[user];
        if (cs && cs.v === 'Paid' && (now - cs.t < CFG.TTL_STATUS)) {
            userStatus = 'Paid';
        } else {
            try {
                const chk = await ax.get(`${CFG.DB}/master_users/${user}/status.json`, {
                    timeout: CFG.TO_FIREBASE
                });
                userStatus = chk.data;
                CACHE.status[user] = { v: userStatus, t: now };
            } catch (_) {
                userStatus = cs ? cs.v : null;
            }
        }

        // 3. Block unpaid users
        if (userStatus !== 'Paid') {
            return res.redirect(302, paidWarningUrl);
        }

        // 4. Passive tracking (fire-and-forget)
        ax.patch(`${CFG.DB}/master_users/${user}/tracking.json`, {
            last_played : channelName,
            last_seen   : timestamp,
            device      : userAgent.substring(0, 120),
            ip          : userIP,
            engine      : 'v7.0'
        }).catch(() => {});

        // 5. AI Fallback Chain
        try {
            // Level 1: Try real stream
            const alive = await isStreamAlive(realLink);
            if (alive) return res.redirect(302, realLink);

            // Level 2: Random channel from pool
            const rand = pickRandom();
            if (rand) {
                const randAlive = await isStreamAlive(rand);
                if (randAlive) {
                    ax.patch(`${CFG.DB}/master_users/${user}/tracking.json`, {
                        fallback_triggered : true,
                        fallback_channel   : rand,
                        original_channel   : channelName,
                        fallback_time      : timestamp
                    }).catch(() => {});
                    return res.redirect(302, rand);
                }
            }
        } catch (_) { /* fall through */ }

        // Level 3: Offline video
        return res.redirect(302, offlineVideo);
    }

    // ─────────────────────────────────────────────────────────────────────
    // 🟢 PATH 3 — M3U PLAYLIST GENERATION
    // ─────────────────────────────────────────────────────────────────────
    if (!user) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(400).send([
            '╔══════════════════════════════════╗',
            '║  MITV NETWORK — Engine v7.0       ║',
            '╚══════════════════════════════════╝',
            '',
            '❌ Missing ?user= parameter',
            '✅ Usage: /api/m3u?user=YOUR_UID',
            '',
            'Contact: MiTV Network Support',
            'Owner  : Muaaz Iqbal (Muslim Islam)'
        ].join('\n'));
    }

    try {
        // ── Fetch user data + playlist config + user name in parallel ──
        const [userRes, configRes, userName] = await Promise.all([
            ax.get(`${CFG.DB}/master_users/${user}.json`,      { timeout: CFG.TO_FIREBASE }),
            ax.get(`${CFG.DB}/active_playlists/${user}.json`,  { timeout: CFG.TO_FIREBASE }),
            getUserName(user)
        ]);

        const userData = userRes.data;
        const config   = configRes.data;

        if (!userData) {
            return res.status(404).send('❌ User not found. Check your User ID.');
        }
        if (!config || !Array.isArray(config.sources) || !config.sources.length) {
            return res.status(404).send('❌ No active playlist configured for this account.');
        }

        const isPaid = userData.status === 'Paid';
        CACHE.status[user] = { v: userData.status, t: now };

        // ── Fetch all M3U sources in parallel ──
        const rawSources = await Promise.all(config.sources.map(fetchM3U));

        // ── Parse all sources → merge buckets ──
        const allBuckets  = new Map();  // groupTitle → string[]
        const orderM3U    = [];         // M3U-native group order (first-seen)
        const orderAI     = [];         // AI-detected category order
        const channelPool = [];

        for (const content of rawSources) {
            if (!content) continue;

            const { buckets, orderM3U: om, orderAI: oa, pool } =
                parseM3UToBuckets(content, host, user, isPaid, paidWarningUrl);

            // Merge buckets
            for (const [title, entries] of buckets.entries()) {
                if (!allBuckets.has(title)) allBuckets.set(title, []);
                allBuckets.get(title).push(...entries);
            }

            // Merge order (keep first-seen)
            for (const t of om) if (!orderM3U.includes(t)) orderM3U.push(t);
            for (const t of oa) if (!orderAI.includes(t))  orderAI.push(t);

            channelPool.push(...pool);
        }

        // ── Update global fallback pool ──
        if (channelPool.length > 0) {
            CACHE.channels = channelPool;
            CACHE.chTime   = now;
        }

        // ── Total channel count ──
        const totalChannels = [...allBuckets.values()].reduce((s, a) => s + a.length, 0);

        // ─────────────────────────────────────────────────────────────────
        // 📝 BUILD M3U OUTPUT
        // ─────────────────────────────────────────────────────────────────

        // Header
        const lines = [
            '#EXTM3U',
            `#EXT-X-LOGO:${CFG.LOGO}`,
            `#EXTM3U url-tvg="" refresh="1" cache="no-store" x-tvg-url=""`,
            ''
        ];

        // ── Welcome Channel (first channel = user's name from Firebase) ──
        lines.push(buildWelcomeChannel(userName, host, user));
        lines.push('');

        // ── Output M3U-native categories (preserve M3U order) ──
        for (const title of orderM3U) {
            const entries = allBuckets.get(title);
            if (!entries?.length) continue;
            for (const entry of entries) {
                lines.push(entry);
            }
            lines.push('');
        }

        // ── Output AI-detected categories (sorted by predefined priority) ──
        // Sort AI titles by CAT_RULES index for consistent order
        const sortedAI = orderAI.slice().sort((a, b) => {
            const ia = CAT_INDEX.has(a) ? CAT_INDEX.get(a) : 999;
            const ib = CAT_INDEX.has(b) ? CAT_INDEX.get(b) : 999;
            return ia - ib;
        });

        for (const title of sortedAI) {
            if (orderM3U.includes(title)) continue; // already output
            const entries = allBuckets.get(title);
            if (!entries?.length) continue;
            for (const entry of entries) {
                lines.push(entry);
            }
            lines.push('');
        }

        // ── Any remaining buckets not covered ──
        for (const [title, entries] of allBuckets.entries()) {
            if (orderM3U.includes(title) || orderAI.includes(title)) continue;
            if (!entries?.length) continue;
            for (const entry of entries) {
                lines.push(entry);
            }
            lines.push('');
        }

        const finalM3U = lines.join('\n');

        // ── Background: backup metadata to Firebase ──
        backupToFirebase(user, totalChannels, [...allBuckets.keys()]);

        // ── Response ──
        res.setHeader('Content-Type',    'application/x-mpegurl; charset=utf-8');
        res.setHeader('Cache-Control',   'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma',          'no-cache');
        res.setHeader('Expires',         '0');
        res.setHeader('X-MITV-Engine',   'OmniStream v7.0');
        res.setHeader('X-Channel-Count', String(totalChannels));
        res.setHeader('X-Paid-Status',   isPaid ? 'Active' : 'Inactive');
        res.setHeader('X-User-Name',     userName || 'Unknown');
        res.setHeader('X-Generated',     new Date().toUTCString());

        return res.status(200).send(finalM3U);

    } catch (err) {
        console.error('[MITV v7 CRITICAL]', err.message);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(500).send([
            '💥 MITV Engine Critical Failure',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            `Error: ${err.message}`,
            'Please contact MiTV Network Support.',
            'Owner: Muaaz Iqbal (Muslim Islam, Kasur)'
        ].join('\n'));
    }
};
