const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function httpGet(url, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': 'https://www.pinterest.com/',
        ...options.headers,
      },
    };
    const req = mod.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return resolve(httpGet(next, options, redirects + 1));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({ data, status: res.statusCode, finalUrl: url }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function extractPinId(url) {
  const m = url.match(/\/pin\/(\d+)/i);
  return m ? m[1] : null;
}

function cleanUrl(u) {
  if (!u) return null;
  try {
    return u.replace(/\\u002F/g, '/').replace(/\\/g, '').replace(/&amp;/g, '&');
  } catch (e) { return u; }
}

function extractFromHtml(html) {
  let videoUrls = {};
  let imageUrl = null;
  let thumbnailUrl = null;
  let title = '';
  let type = 'image';

  const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  if (ogTitle) title = ogTitle[1];

  const ogImg = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (ogImg) thumbnailUrl = cleanUrl(ogImg[1]);

  const ogVid = html.match(/<meta[^>]*property=["']og:video(?::url)?["'][^>]*content=["']([^"']+)["']/i);
  if (ogVid) { videoUrls['hd'] = cleanUrl(ogVid[1]); type = 'video'; }

  const qualities = [['1080p','V_1080P'],['720p','V_720P'],['480p','V_480P'],['360p','V_360P']];
  qualities.forEach(([label, key]) => {
    const re = new RegExp('"' + key + '"\\s*:\\s*\\{[^}]*"url"\\s*:\\s*"([^"]+)"');
    const m = html.match(re);
    if (m) { videoUrls[label] = cleanUrl(m[1]); type = 'video'; }
  });

  const origImg = html.match(/"orig"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/);
  if (origImg) imageUrl = cleanUrl(origImg[1]);
  if (!imageUrl && thumbnailUrl) imageUrl = thumbnailUrl;

  if (imageUrl) {
    imageUrl = imageUrl
      .replace('/236x/', '/originals/')
      .replace('/474x/', '/originals/')
      .replace('/736x/', '/originals/');
  }

  if (imageUrl && imageUrl.match(/\.gif/i)) type = 'gif';
  return { videoUrls, imageUrl, thumbnailUrl, title, type };
}

async function fetchPinData(pinId) {
  // Try internal API first
  try {
    const apiUrl = `https://www.pinterest.com/resource/PinResource/get/?source_url=/pin/${pinId}/&data=%7B%22options%22%3A%7B%22id%22%3A%22${pinId}%22%2C%22field_set_key%22%3A%22detailed%22%7D%7D`;
    const r = await httpGet(apiUrl, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (r.status === 200 && r.data.includes('"resource_response"')) {
      const json = JSON.parse(r.data);
      const pin = json.resource_response && json.resource_response.data;
      if (pin) {
        let videoUrls = {};
        let imageUrl = null;
        let thumbnailUrl = null;
        let title = pin.title || pin.grid_title || '';
        let type = 'image';

        if (pin.videos && pin.videos.video_list) {
          const vl = pin.videos.video_list;
          [['V_1080P','1080p'],['V_720P','720p'],['V_480P','480p'],['V_360P','360p']].forEach(([k,l]) => {
            if (vl[k] && vl[k].url) { videoUrls[l] = cleanUrl(vl[k].url); type = 'video'; }
          });
        }

        if (pin.images) {
          for (const k of ['orig','1200x','736x','474x','236x']) {
            if (pin.images[k] && pin.images[k].url) {
              imageUrl = cleanUrl(pin.images[k].url);
              thumbnailUrl = imageUrl;
              break;
            }
          }
        }

        if (imageUrl && imageUrl.match(/\.gif/i)) type = 'gif';
        if (imageUrl || Object.keys(videoUrls).length > 0) {
          return { videoUrls, imageUrl, thumbnailUrl, title, type };
        }
      }
    }
  } catch (e) { /* fall through */ }

  // Fallback HTML scrape
  const r = await httpGet(`https://www.pinterest.com/pin/${pinId}/`, {
    headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
  });
  return extractFromHtml(r.data);
}

app.post('/api/fetch', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    if (/pin\.it/i.test(url)) {
      try { const r = await httpGet(url); url = r.finalUrl || url; } catch (e) {}
    }

    const pinId = extractPinId(url);
    if (!pinId) return res.status(400).json({ error: 'Could not find a Pin ID. Please use a full pinterest.com/pin/... URL.' });

    const media = await fetchPinData(pinId);

    if (!media.imageUrl && Object.keys(media.videoUrls).length === 0) {
      return res.status(404).json({ error: 'No media found. Pinterest may be rate-limiting. Please try again in a moment.' });
    }

    return res.json({ success: true, data: { ...media, pinId } });
  } catch (err) {
    console.error('Fetch error:', err.message);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.get('/api/proxy', (req, res) => {
  const { url } = req.query;
  if (!url || !/pinimg\.com|v\.pinimg\.com/i.test(url)) return res.status(403).send('Forbidden');
  const mod = url.startsWith('https') ? https : http;
  const ext = (url.match(/\.(mp4|jpg|jpeg|png|gif|webp)/i) || [''])[0];
  mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.pinterest.com/' } }, (r) => {
    res.set('Content-Type', r.headers['content-type'] || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="pinterest-media${ext}"`);
    if (r.headers['content-length']) res.set('Content-Length', r.headers['content-length']);
    r.pipe(res);
  }).on('error', (e) => res.status(500).send(e.message));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PinSave running on port ${PORT}`));
