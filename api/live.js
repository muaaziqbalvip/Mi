export default function handler(req, res) {
    const videoUrl = "https://mitv-tan.vercel.app/welcomemitv.mp4";
    
    // M3U8 format content
    const m3u8Content = 
    `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\n${videoUrl}\n#EXT-X-ENDLIST`;

    res.setHeader('Content-Type', 'application/x-mpegURL');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
    res.status(200).send(m3u8Content);
}
