# TempChat

> Anonymous, webcam-only video calls. No accounts. No logs. No trace.

![WebRTC](https://img.shields.io/badge/WebRTC-DTLS--SRTP-00e5ff?style=flat-square)
![Privacy](https://img.shields.io/badge/Privacy-First-00ff88?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-ffffff?style=flat-square)
![Self-Hosted](https://img.shields.io/badge/Self--Hosted-Yes-00e5ff?style=flat-square)

![TEMPCHAT](./images/tempchat.png)
---

## What it is

TempChat is a privacy-first, 1-on-1 anonymous video chat. Share a link, connect with someone, close the tab — gone. No backend stores anything. No accounts, no identity, no history.

Built for people who treat privacy as a default, not a premium feature.

---

## How it works

```
Browser A ──── ScaleDrone WSS ────── Browser B
    │         (signaling only)           │
    └──────── WebRTC P2P (DTLS) ────────┘
              audio + video direct
```

- **Signaling** via [ScaleDrone](https://www.scaledrone.com) WebSocket — only used to exchange SDP and ICE candidates, never touches media
- **Media** travels peer-to-peer, end-to-end encrypted by WebRTC's built-in DTLS-SRTP
- **TURN relay** via self-hosted [coturn](https://github.com/coturn/coturn) — fallback for users behind strict NAT or VPN (Mullvad, etc.)
- **Room IDs** are random hashes in the URL fragment — never sent to any server

---

## Features

- Webcam-only — no chat, no distractions
- Works behind VPN and mobile networks (TURN relay)
- HD video with selectable quality: 360p / 720p / 1080p
- Stereo Opus audio at 48 kHz with FEC packet-loss recovery
- VP9 → H264 → VP8 codec preference for best quality/bandwidth ratio
- Draggable PiP self-view
- Live stats panel: resolution, FPS, bandwidth, RTT, packet loss, codec
- Direct P2P / TURN relay indicator
- Mute and camera toggle (no renegotiation)
- Copy invite link button
- Mobile-optimised: safe-area insets, 54px touch targets, landscape support
- Zero dependencies — vanilla JS, no frameworks

---

## Stack

| Layer | Technology |
|---|---|
| Transport | WebRTC (DTLS-SRTP) |
| Signaling | ScaleDrone (WSS) |
| TURN relay | coturn 4.9 |
| Reverse proxy | Nginx Proxy Manager |
| Frontend | Vanilla JS + HTML/CSS |
| Font | JetBrains Mono |

---

## Self-hosting

### Requirements

- A VPS with a public IP
- Docker + Docker Compose
- A domain with HTTPS (required for `getUserMedia`)
- A ScaleDrone account (free tier works)

### 1. Clone

```bash
git clone https://github.com/cristiancmoises/tempchat
cd tempchat
```

### 2. Serve static files

Point Nginx Proxy Manager at the folder. In the **Advanced** tab of your proxy host:

```nginx
location / {
    root /data/tempchat;
    index index.html;
    try_files $uri $uri/ =404;

    add_header Permissions-Policy "camera=*, microphone=*" always;
    add_header Content-Security-Policy "
        default-src 'self';
        script-src 'self' https://cdn.scaledrone.com https://fonts.googleapis.com;
        style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com;
        font-src 'self' https://fonts.gstatic.com;
        connect-src 'self' wss://*.scaledrone.com https://*.scaledrone.com;
        media-src 'self' blob: mediastream:;
    " always;
}
```

File ownership must match Nginx's uid (101 in NPM):

```bash
chown -R 101:101 /DATA/AppData/nginxproxymanager/data/tempchat
chmod 755 /DATA/AppData/nginxproxymanager/data/tempchat
chmod 644 /DATA/AppData/nginxproxymanager/data/tempchat/*.{html,js}
```

### 3. Configure ScaleDrone

1. Create a free account at [scaledrone.com](https://www.scaledrone.com)
2. Create a channel — copy the channel ID
3. Set it in `script.js`:

```js
const SCALEDRONE_CHANNEL = 'YOUR_CHANNEL_ID';
```

### 4. Deploy coturn (TURN server)

Without a TURN server, calls fail behind VPN or strict NAT.

```bash
mkdir -p /opt/coturn && cd /opt/coturn
```

**`turnserver.conf`:**

```conf
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=YOUR_VPS_PUBLIC_IP
relay-ip=YOUR_VPS_PUBLIC_IP
min-port=49152
max-port=65535
static-auth-secret=YOUR_SECRET   # openssl rand -hex 32
realm=yourdomain.com
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
log-file=stdout
verbose
```

**`docker-compose.yml`:**

```yaml
services:
  coturn:
    image: coturn/coturn:latest
    container_name: coturn
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./turnserver.conf:/etc/coturn/turnserver.conf:ro
```

```bash
docker compose up -d
docker logs coturn -f  # verify it starts
```

Set your credentials in `script.js`:

```js
const TURN_HOST   = 'YOUR_VPS_PUBLIC_IP';
const TURN_SECRET = 'YOUR_SECRET';
```

### 5. Firewall

Open these ports in your VPS firewall (IONOS, Hetzner, etc.) and in nftables:

| Port | Protocol | Direction | Purpose |
|------|----------|-----------|---------|
| 80 | TCP | IN | HTTP → HTTPS redirect |
| 443 | TCP | IN | HTTPS + ScaleDrone WSS |
| 3478 | TCP + UDP | IN | TURN/STUN |
| 5349 | TCP + UDP | IN | TURNS (TLS) |
| 49152–65535 | UDP | IN | TURN relay media |

---

## Usage

1. Open the app and click **Allow Camera & Start**
2. Select your video quality (default: 720p)
3. Copy the URL and share it with whoever you want to call
4. When they open the link and start their camera, the call begins automatically

The room lives in the URL hash (`#abc123...`). Each page load generates a new random room. There is no matchmaking — you always connect with the specific person you share the link with.

---

## Privacy model

| What | Stored? |
|---|---|
| Your identity | Never |
| Call contents | Never — P2P only |
| Room IDs | Only in URL hash, never on server |
| IP addresses | Visible to peer in direct mode; hidden via TURN relay |
| Signaling messages | Transit only, not persisted by ScaleDrone |
| Camera/mic | Only activated after explicit user consent |

> **Note:** In Direct P2P mode, your IP is visible to the remote peer via WebRTC ICE candidates. If IP privacy is required, use a VPN — the TURN relay handles fallback connectivity automatically.

---

## Architecture notes

### Offerer / Answerer

The second person to join the room (last in ScaleDrone's `members` array) becomes the **offerer** and initiates the WebRTC negotiation. The first person waits and **answers**.

### Track negotiation

- Offerer adds tracks via `addTransceiver()` before `createOffer()` — locks codec preferences into the SDP
- Answerer adds tracks via `addTrack()` **after** `setRemoteDescription(offer)` — maps local tracks onto the offerer's m-lines, preventing m-line conflicts that cause one-sided video

### ICE restart

On `iceConnectionState === 'failed'` or `'disconnected'`, the offerer automatically calls `pc.restartIce()` after a short grace period. This recovers from transient network disruptions without requiring a page reload.

### Bitrate targets

| Quality | Max video bitrate |
|---|---|
| 360p | 700 kbps |
| 720p | 3 Mbps |
| 1080p | 6 Mbps |
| Audio (all) | 128 kbps stereo Opus |

---

## Development

No build step. Edit `index.html` and `script.js` directly.

```bash
# Local testing with a self-signed cert (required for getUserMedia)
# Use ngrok, caddy, or mkcert + a local server
npx serve .
# or
python3 -m http.server 8080
# then expose via ngrok: ngrok http 8080
```

---

## License

MIT — see [LICENSE](LICENSE)

---

<div align="center">
  <sub>Built by <a href="https://github.com/cristiancmoises">@cristiancmoises</a> · <a href="https://wiki.securityops.co">wiki.securityops.co</a></sub>
</div>
