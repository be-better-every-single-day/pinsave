const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: HEADERS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return resolve(httpGet(next, redirects + 1));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({ data, finalUrl: url }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function extractPinId(url) {
  const m = url.match(/\/pin\/(\d+)/i);
  return m ? m[1] : null;
}

function cleanUrl(u) {
  if (!u) return null;
  return u.replace(/\\u002F/g, '/').replace(/\\/g, '').replace(/&amp;/g, '&');
}

function extractMedia(html) {
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

  const qualities = [['1080p', 'V_1080P'], ['720p', 'V_720P'], ['480p', 'V_480P'], ['360p', 'V_360P']];
  qualities.forEach(([label, key]) => {
    const re = new RegExp('"' + key + '"\\s*:\\s*\\{[^}]*"url"\\s*:\\s*"([^"]+)"');
    const m = html.match(re);
    if (m) { videoUrls[label] = cleanUrl(m[1]); type = 'video'; }
  });

  const origImg = html.match(/"orig"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"/);
  if (origImg) imageUrl = cleanUrl(origImg[1]);

  if (!imageUrl && thumbnailUrl) imageUrl = thumbnailUrl;
  if (imageUrl && imageUrl.match(/\.gif/i)) type = 'gif';

  return { videoUrls, imageUrl, thumbnailUrl, title, type };
}

app.post('/api/fetch', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  try {
    if (/pin\.it/i.test(url)) {
      const r = await httpGet(url);
      url = r.finalUrl;
    }
    const pinId = extractPinId(url);
    if (!pinId) return res.status(400).json({ error: 'Could not find Pin ID in URL. Use a pinterest.com/pin/... or pin.it/... link.' });
    const r = await httpGet('https://www.pinterest.com/pin/' + pinId + '/');
    const media = extractMedia(r.data);
    if (!media.imageUrl && Object.keys(media.videoUrls).length === 0)
      return res.status(404).json({ error: 'No media found in this pin. It may be private or deleted.' });
    return res.json({ success: true, data: { ...media, pinId } });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch pin: ' + err.message });
  }
});

app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url || !/pinimg\.com|v\.pinimg\.com/i.test(url)) return res.status(403).send('Forbidden');
  try {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.pinterest.com/' } }, (r) => {
      res.set('Content-Type', r.headers['content-type'] || 'application/octet-stream');
      res.set('Content-Disposition', 'attachment; filename="pinterest-media"');
      r.pipe(res);
    }).on('error', (e) => res.status(500).send(e.message));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('PinSave running on port ' + PORT));
