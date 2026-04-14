# PinSave – Pinterest Downloader

A complete Pinterest video, image & GIF downloader website (KlickPin clone).

## Why a server is required

Pinterest **blocks browser-side (CORS) requests** — this is why a pure HTML file cannot fetch Pinterest data directly. Any working Pinterest downloader (including KlickPin) runs a **backend server** that fetches content server-side, then returns the media URLs to the browser.

## Project Structure

```
pinsave/
├── server.js          ← Node.js backend (Express)
├── package.json
├── public/
│   └── index.html     ← Frontend website
└── README.md
```

## Local Setup (Quickest)

1. Make sure Node.js is installed (https://nodejs.org)
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the server:
   ```bash
   node server.js
   ```
4. Open your browser at: **http://localhost:3000**
5. Paste any Pinterest URL and click Download!

## Deploy to Railway (Free & Easy)

Railway gives you a free hosted server in minutes:

1. Create account at https://railway.app
2. Create new project → Deploy from GitHub (push this folder to GitHub first)
   OR use Railway CLI:
   ```bash
   npm install -g @railway/cli
   railway login
   railway init
   railway up
   ```
3. Railway gives you a URL like `https://pinsave-production.up.railway.app`
4. Open `public/index.html` and update the `API_BASE` variable:
   ```js
   const API_BASE = 'https://pinsave-production.up.railway.app';
   ```

## Deploy to Render (Also Free)

1. Push to GitHub
2. Go to https://render.com → New → Web Service
3. Connect repo, set:
   - Build command: `npm install`
   - Start command: `node server.js`
4. Get your URL and update `API_BASE` in index.html

## Deploy to VPS (DigitalOcean/AWS/etc.)

```bash
# On your VPS
git clone your-repo
cd pinsave
npm install
# Install PM2 to keep it running
npm install -g pm2
pm2 start server.js --name pinsave
pm2 save
```

Then use Nginx as a reverse proxy to port 3000.

## Add to package.json

Make sure your package.json has:
```json
{
  "scripts": {
    "start": "node server.js"
  }
}
```
Railway and Render use `npm start` to launch your app.

## How It Works

1. User pastes a Pinterest URL (pin.it or pinterest.com/pin/...)
2. Frontend sends it to `/api/fetch` (your backend)
3. Backend resolves short URLs, fetches the Pinterest page with browser-like headers
4. Extracts video URLs (V_1080P, V_720P, etc.) and image URLs from the page's JSON data
5. Returns the URLs to the frontend
6. `/api/proxy` endpoint streams the actual media file (needed because Pinterest CDN has referrer restrictions)
7. User's browser downloads the file

## Supported URL Formats

- `https://www.pinterest.com/pin/795377984215165340/`
- `https://in.pinterest.com/pin/795377984215165340/`
- `https://pin.it/2Bb8AHWZs` (short links)

## Tech Stack

- **Backend**: Node.js + Express + Axios + Cheerio
- **Frontend**: Pure HTML/CSS/JS (no framework needed)
- **Hosting**: Any Node.js host (Railway, Render, Heroku, VPS)
