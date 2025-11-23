# Temp Chat - Instant No-Account Video Chat

![TempChat](https://play-lh.googleusercontent.com/EEKdtId86HEOzg0rE-0tnePqfvRm57DejNQG44mrr5JGaqMJQAQuWtgxcdShMkil5SE=w1052-h592)

**TempChat** is a completely anonymous, zero-signup, one-click video chat web app.  
Open the link → instant video call. No apps, no accounts, no hassle.

Live demo: https://your-domain.com (just replace with your hosted URL)

## Features

- 🔗 **One unique URL = one private room** (auto-generated random hash)
- 🚀 **Instant connection** – works in any modern browser (desktop & mobile)
- 🎥 High-quality WebRTC video + audio
- 🛡️ **No personal data collected** – fully temporary sessions
- 📋 **Copy link button** – share via WhatsApp, SMS, email, etc.
- Large public STUN list for better NAT traversal
- Works behind most firewalls (pure STUN, no TURN required in most cases)

## How to Use

1. Open https://teams.securityops.co in your browser
2. Allow camera & microphone
3. Copy the URL from the button (or just share the page URL)
4. Send it to anyone – when they open it, you’re instantly connected!

## Self-Hosting (30 seconds)

```bash
git clone https://github.com/yourusername/tempchat.git
cd tempchat
python3 -m http.server 8080
# Just upload the files to any static web host (Netlify, Vercel, GitHub Pages, etc.)
```
##  Files needed:
    index.html
    script.js
    images/32.png and images/256.png (favicons)
> No build step, no backend, no database.

## Change the signaling channel (optional but recommended)
Open script.js and replace:
     
     const SCALEDONE_CHANNEL = 'yiS12Ts5RdNhebyM';

with your own free ScaleDrone channel ID (get one at https://www.scaledrone.com – free tier is enough).
Privacy & Security


- No cookies, no tracking, no logs
- Media never touches any server – pure peer-to-peer WebRTC
- Room URLs are random and unguessable
- Sessions disappear when both users leave

## Tech Stack
- Vanilla HTML + CSS + JavaScript
- WebRTC (RTCPeerConnection)
- ScaleDrone for lightweight signaling
- Extensive public STUN servers for connectivity




