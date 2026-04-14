const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'max-age=0',
};

async function resolvePinItUrl(shortUrl) {
  try {
    const resp = await axios.get(shortUrl, {
      headers: HEADERS,
      maxRedirects: 10,
      timeout: 10000,
    });
    return resp.request.res.responseUrl || resp.config.url;
  } catch (err) {
    if (err.response) return err.response.headers['location'] || shortUrl;
    throw err;
  }
}

function extractPinId(url) {
  const m = url.match(/\/pin\/(\d+)/i);
  return m ? m[1] : null;
}

function cleanUrl(url) {
  if (!url) return null;
  return url.replace(/\\u002F/g, '/').replace(/\\/g, '').replace(/&amp;/g, '&');
}

async function fetchPinData(pinId) {
  const url = `https://www.pinterest.com/pin/${pinId}/`;
  const resp = await axios.get(url, {
    headers: HEADERS,
    timeout: 15000,
    decompress: true,
  });
  const html = resp.data;
  const $ = cheerio.load(html);

  let result = {
    pinId,
    type: 'image',
    title: '',
    description: '',
    videoUrls: {},
    imageUrl: null,
    thumbnailUrl: null,
  };

  // OG title / description
  result.title = $('meta[property="og:title"]').attr('content') || '';
  result.description = $('meta[property="og:description"]').attr('content') || '';

  // OG video
  const ogVideo = $('meta[property="og:video:url"]').attr('content') ||
                  $('meta[property="og:video"]').attr('content');
  const ogImage = $('meta[property="og:image"]').attr('content');

  if (ogImage) result.thumbnailUrl = cleanUrl(ogImage);

  // Search all script tags for Pinterest's redux state JSON
  $('script').each((i, el) => {
    const txt = $(el).html() || '';

    // Video quality URLs
    const patterns = [
      { key: 'V_1080P', label: '1080p' },
      { key: 'V_720P',  label: '720p'  },
      { key: 'V_480P',  label: '480p'  },
      { key: 'V_360P',  label: '360p'  },
      { key: 'HLS',     label: 'hls'   },
    ];
    patterns.forEach(({ key, label }) => {
      const re = new RegExp(`"${key}"\\s*:\\s*\\{[^}]*"url"\\s*:\\s*"([^"]+)"`, 'g');
      let m;
      while ((m = re.exec(txt)) !== null) {
        if (!result.videoUrls[label]) {
          result.videoUrls[label] = cleanUrl(m[1]);
          result.type = 'video';
        }
      }
    });

    // Alternate video pattern
    const altVideo = txt.match(/"video_url"\s*:\s*"(https:[^"]+\.mp4[^"]*)"/);
    if (altVideo && !result.videoUrls['hd']) {
      result.videoUrls['hd'] = cleanUrl(altVideo[1]);
      result.type = 'video';
    }

    // Original image
    const origImg = txt.match(/"orig"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/);
    if (origImg && !result.imageUrl) {
      result.imageUrl = cleanUrl(origImg[1]);
    }

    // GIF detection
    if (txt.includes('.gif') && !result.videoUrls['1080p']) {
      const gifMatch = txt.match(/"url"\s*:\s*"(https:[^"]+\.gif[^"]*)"/);
      if (gifMatch) {
        result.imageUrl = cleanUrl(gifMatch[1]);
        result.type = 'gif';
      }
    }
  });

  // Fallback to OG video
  if (ogVideo && Object.keys(result.videoUrls).length === 0) {
    result.videoUrls['hd'] = cleanUrl(ogVideo);
    result.type = 'video';
  }

  // Fallback image from OG
  if (!result.imageUrl && ogImage) {
    result.imageUrl = cleanUrl(ogImage);
    // Upgrade to original resolution
    result.imageUrl = result.imageUrl
      .replace('/236x/', '/originals/')
      .replace('/474x/', '/originals/')
      .replace('/736x/', '/originals/')
      .replace('_b.jpg', '.jpg');
  }

  return result;
}

// API: resolve + fetch pin
app.post('/api/fetch', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    // Resolve short URL
    if (/pin\.it/i.test(url)) {
      url = await resolvePinItUrl(url);
    }

    const pinId = extractPinId(url);
    if (!pinId) {
      return res.status(400).json({ error: 'Could not find a Pin ID in this URL. Please use a direct pinterest.com/pin/... link or a pin.it short link.' });
    }

    const data = await fetchPinData(pinId);

    if (!data.imageUrl && Object.keys(data.videoUrls).length === 0) {
      return res.status(404).json({ error: 'No downloadable media found in this pin. It may be private or deleted.' });
    }

    return res.json({ success: true, data });
  } catch (err) {
    console.error('Fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch pin. Pinterest may be temporarily blocking requests. Please try again in a moment.' });
  }
});

// Proxy download (to bypass CORS on media)
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL required');
  if (!/pinimg\.com|v\.pinimg\.com/i.test(url)) return res.status(403).send('Only Pinterest CDN URLs allowed');

  try {
    const resp = await axios.get(url, {
      responseType: 'stream',
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Referer': 'https://www.pinterest.com/',
      },
      timeout: 30000,
    });
    res.set('Content-Type', resp.headers['content-type'] || 'application/octet-stream');
    res.set('Content-Length', resp.headers['content-length'] || '');
    res.set('Content-Disposition', `attachment; filename="pinterest-${Date.now()}"`);
    resp.data.pipe(res);
  } catch (err) {
    res.status(500).send('Proxy error: ' + err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PinSave server running on http://localhost:${PORT}`));
