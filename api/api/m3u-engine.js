// Location: /api/m3u.js
import axios from 'axios';

export default async function handler(req, res) {
    const { token } = req.query;

    if (!token) {
        return res.status(401).send("#EXTM3U\n#ERROR: Authentication Token Missing");
    }

    try {
        // 1. Get User Data from Firebase
        const userRes = await axios.get(`https://ramadan-2385b-default-rtdb.firebaseio.com/users/${token}.json`);
        const user = userRes.data;

        if (!user) {
            return res.status(403).send("#EXTM3U\n#ERROR: Invalid Subscriber");
        }

        // 2. Expiry & Payment Logic
        const today = new Date();
        const expiryDate = new Date(user.expiry);
        
        // Agar payment paused hai ya date khatam ho gayi hai
        if (user.status === 'paused' || today > expiryDate) {
            return res.send(`#EXTM3U
#EXTINF:-1 tvg-logo="https://cdn-icons-png.flaticon.com/512/595/595067.png", [!] EXPIRED - PAY NOW TO RENEW
https://www.w3schools.com/html/mov_bbb.mp4`); // Loop video here
        }

        // 3. Fetch Master Playlist
        const playRes = await axios.get(`https://ramadan-2385b-default-rtdb.firebaseio.com/master_playlist.json`);
        const masterChannels = playRes.data;

        // 4. Generate Masked Output
        let output = `#EXTM3U\n`;
        output += `#EXTREM: MiTV Network - Secure Subscriber: ${user.name}\n`;

        masterChannels.forEach(ch => {
            // Masking the source URL using Base64 + Proxy Route
            const maskedLink = `https://mitv-network.vercel.app/api/stream?source=${Buffer.from(ch.url).toString('base64')}&token=${token}&ch_name=${encodeURIComponent(ch.name)}`;
            
            output += `#EXTINF:-1 tvg-id="" tvg-logo="${ch.logo}" group-title="MiTV PREMIUM", ${ch.name}\n`;
            output += `${maskedLink}\n`;
        });

        // Track that the user downloaded/refreshed their list
        await axios.post(`https://ramadan-2385b-default-rtdb.firebaseio.com/logs.json`, {
            user: user.name,
            action: "Playlist Refreshed",
            timestamp: Date.now(),
            ip: req.headers['x-forwarded-for'] || "Unknown"
        });

        res.setHeader('Content-Type', 'text/plain');
        res.status(200).send(output);

    } catch (error) {
        res.status(500).send("#EXTM3U\n#ERROR: Cloud Connection Failed");
    }
    }
              
