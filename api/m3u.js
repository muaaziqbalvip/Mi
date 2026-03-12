import axios from 'axios';

export default async function handler(req, res) {
    const { url } = req.query;

    if (!url) {
        return res.status(400).send("#EXTM3U\n#ERROR: No URL provided");
    }

    try {
        // Base64 decoding to get original link
        const decodedUrl = Buffer.from(url, 'base64').toString('utf-8');

        const response = await axios({
            method: 'get',
            url: decodedUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MiTV-Network/1.0',
                'Referer': 'https://mitvnetwork.com/'
            },
            timeout: 10000
        });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache');
        
        response.data.pipe(res);
    } catch (error) {
        console.error("Masking Error:", error.message);
        res.status(500).send("#EXTM3U\n#ERROR: Stream unavailable");
    }
}
