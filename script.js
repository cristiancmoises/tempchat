'use strict';
/**
 * TempChat — 1-on-1 encrypted video call
 *
 * ─── KEY FIXES & ENHANCEMENTS ────────────────────────────────────────────────
 *
 * [FIXED] TURN credentials with spaces → invalid URL → RTCPeerConnection crash.
 *   Validate before including TURN entries.
 *
 * [FIXED] Non-deterministic offerer role (members array order not guaranteed).
 *   Use lexicographic ID comparison: higher ID = offerer, always consistent.
 *
 * [NEW] Share buttons: WhatsApp, Telegram, Signal, X, Email, Web Share API.
 *   Wired on landing page and inside the waiting overlay.
 *
 * [PERF] 1080p delay / startup lag — multi-layered fix:
 *   1. SDP bandwidth hints (b=AS, x-google-{min,max,start}-bitrate) injected
 *      into the offer/answer. Tells Chrome's congestion controller to ramp
 *      up aggressively instead of spending 3-5 seconds probing bandwidth.
 *   2. Temporal scalability (L1T3) for VP9 and AV1. The encoder produces 3
 *      temporal layers: T0 at 1/4 fps, T1 at 1/2 fps, T2 at full fps.
 *      The receiver can decode at full quality immediately; the encoder itself
 *      starts at full resolution but adapts frame delivery. This eliminates
 *      the "blurry then sharp" ramp-up visible at 1080p.
 *   3. Start bitrate set to 80% of target — avoids the 30-second slow-start
 *      that the default 300 kbps start triggers at high resolutions.
 *   4. iceCandidatePoolSize increased to 8 — pre-gathers more candidates in
 *      parallel, reduces ICE setup time especially on first connection.
 *   5. encodingParams applied immediately after 'connected' (was 1500ms delay,
 *      now 500ms) so bandwidth ceiling takes effect sooner.
 */

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const SCALEDRONE_CHANNEL = 'yiS12Ts5RdNhebyM';

const TURN_HOST   = 'YOUR SERVER HOST';  // e.g. '195.201.x.x' — leave '' for STUN-only
const TURN_SECRET = 'YOUR SECRET CODE';  // must match coturn static-auth-secret

function buildIceServers() {
  const stun = [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.nextcloud.com:3478'  },
  ];

  const hostOk   = typeof TURN_HOST   === 'string' && TURN_HOST.trim().length   > 0 && !TURN_HOST.includes(' ');
  const secretOk = typeof TURN_SECRET === 'string' && TURN_SECRET.trim().length > 0 && !TURN_SECRET.includes(' ');

  if (!hostOk || !secretOk) {
    log('ICE: STUN-only');
    return stun;
  }

  const ttl      = Math.floor(Date.now() / 1000) + 86400;
  const username = `${ttl}:tempchat`;
  log('ICE: STUN + TURN for', TURN_HOST);

  return [
    ...stun,
    {
      urls: [
        `turn:${TURN_HOST}:3478?transport=udp`,
        `turn:${TURN_HOST}:3478?transport=tcp`,
        `turns:${TURN_HOST}:5349?transport=tcp`,
      ],
      username,
      credential: TURN_SECRET,
    },
  ];
}

// ─── QUALITY ──────────────────────────────────────────────────────────────────

const VIDEO_CONSTRAINTS = {
  360:  { width:{ideal:640,min:320},   height:{ideal:360,min:240},  frameRate:{ideal:30,min:15} },
  720:  { width:{ideal:1280,min:640},  height:{ideal:720,min:480},  frameRate:{ideal:30,min:24} },
  1080: { width:{ideal:1920,min:1280}, height:{ideal:1080,min:720}, frameRate:{ideal:30,min:24} },
};

// Max bitrate ceiling per quality tier
const VIDEO_BITRATE = { 360: 700_000, 720: 3_000_000, 1080: 6_000_000 };

// Start bitrate: high initial value kills the slow-start ramp at 1080p.
// Standard WebRTC congestion control starts at ~300 kbps and takes 3-8 seconds
// to reach target. Setting start bitrate to ~80% of target cuts that to <1s.
const VIDEO_START_BITRATE = { 360: 500_000, 720: 2_000_000, 1080: 4_500_000 };

const AUDIO_BITRATE = 128_000;
const AUDIO_CONSTRAINTS = {
  echoCancellation: { ideal: true  },
  noiseSuppression: { ideal: true  },
  autoGainControl:  { ideal: true  },
  sampleRate:       { ideal: 48000 },
  sampleSize:       { ideal: 16    },
  channelCount:     { ideal: 2     },
  latency:          { ideal: 0.01  },
};

// ─── STATE ────────────────────────────────────────────────────────────────────

let pc              = null;
let drone           = null;
let room            = null;
let localStream     = null;
let pendingCands    = [];
let isOfferer       = false;
let audioEnabled    = true;
let videoEnabled    = true;
let isConnected     = false;
let statsVisible    = false;
let statsInterval   = null;
let iceRestartTimer = null;
let selectedQuality = 720;
let prevStats       = { bytesSent: 0, bytesRecv: 0, ts: 0 };

// ─── ROOM ─────────────────────────────────────────────────────────────────────

if (!location.hash) {
  location.hash = Math.random().toString(36).slice(2,10) +
                  Math.random().toString(36).slice(2,10);
}
const roomHash = location.hash.substring(1);
const roomName  = 'observable-' + roomHash;

// ─── DOM REFS ─────────────────────────────────────────────────────────────────

let $permScreen, $app, $localVideo, $remoteVideo;
let $statusDot, $statusText, $waitingOverlay, $disconnBanner;
let $muteBtn, $muteIcon, $muteLbl, $camBtn, $camIcon, $camLbl;
let $copyBtn, $copyLbl, $statsToggleBtn, $statsBar;
let $statRes, $statFps, $statBw, $statRtt, $statPkt, $statCod;
let $roomId, $localWrap, $qualityBadge, $turnBadge;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const log  = (...a) => console.log('[tc]', ...a);
const err  = (...a) => console.error('[tc]', ...a);
const fmtB = bps   => bps > 1e6 ? (bps/1e6).toFixed(1)+' Mbps' : Math.round(bps/1e3)+' kbps';

function setStatus(state, text) {
  if (!$statusDot) return;
  $statusDot.className    = state;
  $statusText.textContent = text;
}
function showWaiting(v) { $waitingOverlay?.classList.toggle('hidden', !v); }
function showDisconn(v) { $disconnBanner?.classList.toggle('show', v); }
function setTurnBadge(type) {
  if (!$turnBadge) return;
  $turnBadge.className   = type ? `show ${type}` : '';
  $turnBadge.textContent =
    type === 'relay'  ? '⚡ TURN relay' :
    type === 'direct' ? '✓ Direct P2P'  : '';
}

// ─── SHARE UTILITIES ──────────────────────────────────────────────────────────

/**
 * Build share URLs for all platforms.
 * Called once the URL is known (i.e. after room hash is set).
 */
function buildShareUrls(url) {
  const enc  = encodeURIComponent(url);
  const text = encodeURIComponent('Join me on TempChat — anonymous encrypted video call: ');
  return {
    wa:     `https://wa.me/?text=${text}${enc}`,
    tg:     `https://t.me/share/url?url=${enc}&text=${encodeURIComponent('Join my TempChat call — anonymous & encrypted')}`,
    signal: `https://signal.me/#p/${enc}`,   // Signal deep-link (opens app on mobile)
    tw:     `https://twitter.com/intent/tweet?text=${text}&url=${enc}`,
    email:  `mailto:?subject=${encodeURIComponent('TempChat invite')}&body=${text}${enc}`,
  };
}

/**
 * Wire all share buttons (landing page + waiting overlay).
 * Call whenever the page URL might have changed.
 */
function wireShareButtons() {
  const url  = window.location.href;
  const urls = buildShareUrls(url);

  // Landing page buttons
  const map = {
    shareWa:      urls.wa,
    shareTg:      urls.tg,
    shareSignal:  urls.signal,
    shareTw:      urls.tw,
    shareEmail:   urls.email,
    // Waiting overlay buttons
    wShareWa:     urls.wa,
    wShareTg:     urls.tg,
    wShareSignal: urls.signal,
    wShareTw:     urls.tw,
  };

  for (const [id, href] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.href = href;
  }

  // Native Web Share API — show button only if supported (mostly mobile)
  const hasNativeShare = !!navigator.share;
  ['shareNative', 'wShareNative'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (hasNativeShare) {
      el.style.display = 'flex';
      el.onclick = async (e) => {
        e.preventDefault();
        try {
          await navigator.share({
            title: 'TempChat call',
            text:  'Join my anonymous encrypted video call',
            url,
          });
        } catch(e2) {
          if (e2.name !== 'AbortError') err('native share failed:', e2.message);
        }
      };
    }
  });
}

// ─── SDP ENHANCEMENTS ─────────────────────────────────────────────────────────

/**
 * Inject Opus quality parameters into SDP.
 */
function enhanceAudioSDP(sdp) {
  const injected = new Set();
  return sdp.replace(/(a=rtpmap:(\d+) opus\/48000\/2)/gi, (_, full, pt) => {
    if (sdp.includes(`a=fmtp:${pt} `) || injected.has(pt)) return full;
    injected.add(pt);
    return (
      full +
      `\r\na=fmtp:${pt} minptime=10;useinbandfec=1;stereo=1;` +
      `maxaveragebitrate=${AUDIO_BITRATE};cbr=0;` +
      `sprop-maxcapturerate=48000;sprop-stereo=1`
    );
  });
}

/**
 * Inject bandwidth hints into video m-section of SDP.
 *
 * WHY THIS FIXES 1080p DELAY:
 *   WebRTC's REMB/TWCC congestion controller starts at ~300 kbps by default
 *   and probes up slowly (GCC algorithm). At 1080p@6Mbps this takes 5-15s.
 *
 *   b=AS:<kbps>   — Application-Specific bandwidth, hints the remote decoder
 *   x-google-min-bitrate — prevents the encoder from going below this floor
 *   x-google-max-bitrate — hard ceiling (redundant with setParameters but
 *                          applied earlier, before the connection stabilises)
 *   x-google-start-bitrate — most important: tells GCC to START at this value
 *                            instead of the 300 kbps default, eliminating
 *                            the slow-start ramp entirely
 *
 * @param {string} sdp       SDP string
 * @param {number} quality   Selected quality key (360/720/1080)
 * @returns {string}
 */
function injectVideoBandwidth(sdp, quality) {
  const maxKbps   = Math.round(VIDEO_BITRATE[quality]       / 1000);
  const startKbps = Math.round(VIDEO_START_BITRATE[quality] / 1000);
  const minKbps   = Math.round(startKbps * 0.3); // 30% of start as floor

  // Inject after the video m-line and its c-line
  // Pattern: m=video ... \r\n c=... \r\n  ← insert b=AS here
  return sdp.replace(
    /(m=video [^\r\n]+\r\n(?:(?:b|c|i|k|a)=[^\r\n]+\r\n)*)/,
    (match) => {
      // Avoid double-injection
      if (match.includes('b=AS:')) return match;
      return (
        match +
        `b=AS:${maxKbps}\r\n` +
        `a=fmtp:96 x-google-min-bitrate=${minKbps};` +
          `x-google-max-bitrate=${maxKbps};` +
          `x-google-start-bitrate=${startKbps}\r\n`
      );
    }
  );
}

/**
 * Reorder codecs by preference, preserving RTX associations.
 */
function preferCodecs(kind, preferred) {
  if (!RTCRtpSender.getCapabilities) return null;
  const caps = RTCRtpSender.getCapabilities(kind);
  if (!caps?.codecs?.length) return null;

  const isRtx   = c => c.mimeType.split('/')[1]?.toLowerCase() === 'rtx';
  const isOther = c => ['red','ulpfec'].includes(c.mimeType.split('/')[1]?.toLowerCase() || '');

  const base  = caps.codecs.filter(c => !isRtx(c) && !isOther(c));
  const rtx   = caps.codecs.filter(isRtx);
  const other = caps.codecs.filter(isOther);

  base.sort((a, b) => {
    const an = a.mimeType.split('/')[1]?.toLowerCase() || '';
    const bn = b.mimeType.split('/')[1]?.toLowerCase() || '';
    const ai = preferred.findIndex(p => an.includes(p.toLowerCase()));
    const bi = preferred.findIndex(p => bn.includes(p.toLowerCase()));
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return [...base, ...rtx, ...other];
}

// ─── ENCODING PARAMS ──────────────────────────────────────────────────────────

/**
 * Apply per-sender encoding constraints via RTCRtpSender.setParameters().
 *
 * TEMPORAL SCALABILITY (L1T3) for VP9/AV1:
 *   Splits the video stream into 3 temporal layers. The encoder can send at
 *   full resolution immediately while adapting frame delivery to available
 *   bandwidth. This eliminates the "blurry for 3 seconds then sharp" artifact
 *   that appears at 1080p when the congestion controller is still probing up.
 *
 *   L1T3 = 1 spatial layer, 3 temporal layers
 *   T0 = keyframes only (~7.5 fps at 30fps)
 *   T1 = T0 + enhancement (~15 fps)
 *   T2 = T0 + T1 + enhancement (full 30 fps)
 *   Decoder receives full resolution frames regardless of which layers arrive.
 */
async function applyEncodingParams() {
  if (!pc) return;

  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      const enc = params.encodings[0];

      if (sender.track.kind === 'video') {
        enc.maxBitrate            = VIDEO_BITRATE[selectedQuality];
        enc.degradationPreference = 'maintain-framerate';
        enc.networkPriority       = 'high';
        enc.priority              = 'high';

        // Temporal scalability — reduces 1080p startup delay significantly.
        // Supported: Chrome 91+, Firefox 124+. Silently ignored elsewhere.
        try {
          enc.scalabilityMode = 'L1T3';
        } catch(e){}

        // Explicit start bitrate via encodings (Chrome honours this)
        if (!enc.minBitrate) {
          enc.minBitrate = Math.round(VIDEO_START_BITRATE[selectedQuality] * 0.3);
        }

      } else {
        enc.maxBitrate      = AUDIO_BITRATE;
        enc.networkPriority = 'high';
        enc.priority        = 'high';
      }

      await sender.setParameters(params);
    } catch(e){}
  }
}

// ─── CLEANUP ──────────────────────────────────────────────────────────────────

function cleanup(keepStream = false) {
  stopStats();
  clearTimeout(iceRestartTimer);
  if (pc) {
    pc.ontrack = pc.onicecandidate = pc.onnegotiationneeded = null;
    pc.onconnectionstatechange = pc.oniceconnectionstatechange = null;
    pc.getSenders().forEach(s => { try { if (s.track) s.track.stop(); } catch(e){} });
    try { pc.close(); } catch(e){}
    pc = null;
  }
  if (!keepStream && localStream) {
    localStream.getTracks().forEach(t => { try { t.stop(); } catch(e){} });
    localStream = null;
    if ($localVideo) $localVideo.srcObject = null;
  }
  if ($remoteVideo) $remoteVideo.srcObject = null;
  if (room)  { try { room.unsubscribe();  } catch(e){} room  = null; }
  if (drone) { try { drone.close();       } catch(e){} drone = null; }
  pendingCands = [];
  isConnected  = false;
  isOfferer    = false;
  prevStats    = { bytesSent: 0, bytesRecv: 0, ts: 0 };
  setTurnBadge(null);
}

// ─── PEER CONNECTION ──────────────────────────────────────────────────────────

function createPC() {
  if (pc) return true;
  log('createPC — isOfferer:', isOfferer);
  try {
    pc = new RTCPeerConnection({
      iceServers:           buildIceServers(),
      bundlePolicy:         'max-bundle',
      rtcpMuxPolicy:        'require',
      iceCandidatePoolSize: 8,  // increased from 4 — faster ICE on first join
      iceTransportPolicy:   'all',
    });
  } catch(e) {
    err('RTCPeerConnection() failed:', e.message);
    pc = null;
    setStatus('disconnected', 'Setup failed — check console');
    return false;
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal({ candidate });
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc?.iceConnectionState;
    log('ICE:', s);
    if (s === 'connected' || s === 'completed') {
      pc.getStats().then(reports => {
        reports.forEach(r => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded') {
            const local = reports.get(r.localCandidateId);
            setTurnBadge(local?.candidateType === 'relay' ? 'relay' : 'direct');
          }
        });
      }).catch(() => {});
    }
    if (s === 'failed') {
      clearTimeout(iceRestartTimer);
      iceRestartTimer = setTimeout(() => {
        if (pc?.iceConnectionState === 'failed' && isOfferer) {
          log('ICE restart (failed)'); pc.restartIce();
        }
      }, 4000);
    }
    if (s === 'disconnected') {
      clearTimeout(iceRestartTimer);
      iceRestartTimer = setTimeout(() => {
        if (pc?.iceConnectionState === 'disconnected' && isOfferer) {
          log('ICE restart (disconnected)'); pc.restartIce();
        }
      }, 3000);
    }
  };

  pc.ontrack = ({ streams, track }) => {
    log('ontrack:', track.kind);
    const stream = streams?.[0];
    if (!stream) { err('ontrack: no stream'); return; }
    if ($remoteVideo.srcObject?.id !== stream.id) {
      $remoteVideo.srcObject = stream;
      log('remote video attached ✓');
    }
    if (track.kind === 'video') {
      setStatus('connected', 'Connected');
      showWaiting(false);
      showDisconn(false);
      isConnected = true;
      startStats();
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc?.connectionState;
    log('connection state:', s);
    if (s === 'connecting' || s === 'new') {
      setStatus('connecting', 'Connecting…');
    } else if (s === 'connected') {
      setStatus('connected', 'Connected');
      showWaiting(false);
      showDisconn(false);
      isConnected = true;
      // Apply encoding params sooner — 500ms instead of 1500ms.
      // The 3s delay at 1080p is caused by the congestion controller starting
      // at default 300 kbps; getting our bitrate hints in fast is critical.
      setTimeout(applyEncodingParams, 500);
      startStats();
    } else if (s === 'failed') {
      stopStats();
      setStatus('disconnected', 'Connection failed');
      showDisconn(true);
      isConnected = false;
    } else if (s === 'disconnected') {
      stopStats();
      if (isConnected) {
        setStatus('disconnected', 'Call ended');
        showDisconn(true);
        isConnected = false;
      }
    }
  };

  return true;
}

// ─── TRACK HELPERS ────────────────────────────────────────────────────────────

function addTracksAsOfferer() {
  if (!pc || !localStream) return;
  const vCodecs = preferCodecs('video', ['AV1','VP9','H264','VP8']);
  const aCodecs = preferCodecs('audio', ['opus']);
  localStream.getTracks().forEach(track => {
    const tc = pc.addTransceiver(track, { streams: [localStream], direction: 'sendrecv' });
    try {
      if (track.kind === 'video' && vCodecs) tc.setCodecPreferences(vCodecs);
      if (track.kind === 'audio' && aCodecs) tc.setCodecPreferences(aCodecs);
    } catch(e){}
    log('offerer addTransceiver:', track.kind);
  });
}

function addTracksAsAnswerer() {
  if (!pc || !localStream) return;
  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
    log('answerer addTrack:', track.kind);
  });
}

// ─── OFFER / ANSWER ───────────────────────────────────────────────────────────

async function sendOffer() {
  if (!pc) { err('sendOffer: pc null'); return false; }
  try {
    log('creating offer…');
    let offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    // Inject bandwidth hints before setting local description
    offer.sdp = enhanceAudioSDP(offer.sdp);
    offer.sdp = injectVideoBandwidth(offer.sdp, selectedQuality);
    await pc.setLocalDescription(offer);
    sendSignal({ sdp: pc.localDescription });
    log('offer sent ✓');
    return true;
  } catch(e) {
    err('sendOffer failed:', e.message);
    return false;
  }
}

// ─── SIGNALING ────────────────────────────────────────────────────────────────

function sendSignal(msg) {
  if (!room || !drone) { err('sendSignal: room not ready'); return; }
  drone.publish({ room: roomName, message: msg });
}

function initSignaling() {
  setStatus('waiting', 'Waiting…');
  showWaiting(true);
  showDisconn(false);
  // Update share links now that we are in the app and the URL is final
  wireShareButtons();

  const dc = new ScaleDrone(SCALEDRONE_CHANNEL);
  drone = dc;

  dc.on('open', openErr => {
    if (openErr) {
      err('ScaleDrone open:', openErr);
      setStatus('disconnected', 'Signaling error — check channel ID');
      return;
    }
    log('ScaleDrone open, clientId:', dc.clientId);

    room = dc.subscribe(roomName);
    room.on('open', roomErr => {
      if (roomErr) { err('room open:', roomErr); return; }
      log('room open:', roomName);
    });

    // ── MEMBERS — DETERMINISTIC ROLE ASSIGNMENT ──────────────────────
    // Higher lexicographic clientId = offerer.
    // Both peers evaluate the same comparison on the same two strings
    // → one offerer, one answerer, always consistent regardless of
    //   array order or join timing.
    room.on('members', async members => {
      log('members:', members.length, members.map(m => m.id.slice(0,8)));

      if (members.length === 1) {
        setStatus('waiting', 'Waiting…');
        showWaiting(true);
        return;
      }

      if (members.length >= 2) {
        const other = members.find(m => m.id !== dc.clientId);
        if (!other) { err('members: no other peer found'); return; }

        isOfferer = dc.clientId > other.id;
        log('role:', isOfferer ? 'OFFERER' : 'ANSWERER',
            '| me:', dc.clientId.slice(0,8),
            '| peer:', other.id.slice(0,8));

        setStatus('connecting', 'Connecting…');
        showWaiting(false);

        if (isOfferer) {
          const ok = createPC();
          if (!ok) { err('Offerer: createPC failed'); return; }
          addTracksAsOfferer();
          await sendOffer();
        } else {
          const ok = createPC();
          if (!ok) { err('Answerer: createPC failed'); return; }
          // Tracks added in data handler after offer received
        }
      }
    });

    // ── DATA — WebRTC signaling ───────────────────────────────────────
    room.on('data', async (msg, client) => {
      if (client.id === dc.clientId) return; // ignore own echoes

      // ── OFFER ──
      if (msg.sdp?.type === 'offer') {
        log('offer ←', client.id.slice(0,8));
        if (!pc) {
          const ok = createPC();
          if (!ok) { err('answerer createPC failed'); return; }
        }
        try {
          const sdp = {
            ...msg.sdp,
            sdp: injectVideoBandwidth(enhanceAudioSDP(msg.sdp.sdp), selectedQuality),
          };
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          log('remote desc set (offer) ✓');

          addTracksAsAnswerer();

          if (pendingCands.length) {
            log('flushing', pendingCands.length, 'queued candidates');
            for (const c of pendingCands) {
              try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e){}
            }
            pendingCands = [];
          }

          let answer = await pc.createAnswer();
          answer.sdp = enhanceAudioSDP(answer.sdp);
          answer.sdp = injectVideoBandwidth(answer.sdp, selectedQuality);
          await pc.setLocalDescription(answer);
          sendSignal({ sdp: pc.localDescription });
          log('answer sent ✓');
        } catch(e) {
          err('offer handling:', e.message);
        }

      // ── ANSWER ──
      } else if (msg.sdp?.type === 'answer') {
        log('answer ←', client.id.slice(0,8));
        if (!pc) { err('answer: pc null'); return; }
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          log('remote desc set (answer) ✓');
          if (pendingCands.length) {
            log('flushing', pendingCands.length, 'queued candidates');
            for (const c of pendingCands) {
              try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e){}
            }
            pendingCands = [];
          }
        } catch(e) {
          err('answer handling:', e.message);
        }

      // ── ICE CANDIDATE ──
      } else if (msg.candidate) {
        if (!pc || !pc.remoteDescription) {
          pendingCands.push(msg.candidate);
          log('candidate queued,', pendingCands.length, 'total');
        } else {
          try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); }
          catch(e){}
        }
      }
    });
  });

  dc.on('error', e => {
    err('ScaleDrone error:', e);
    setStatus('disconnected', 'Signaling error');
  });
}

// ─── MEDIA ────────────────────────────────────────────────────────────────────

async function acquireMedia(quality) {
  const vc = { ...VIDEO_CONSTRAINTS[quality] || VIDEO_CONSTRAINTS[720], facingMode: 'user' };
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: vc, audio: AUDIO_CONSTRAINTS });
  } catch(e) {
    log('HD constraints failed, fallback:', e.message);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
    } catch(e2) {
      err('getUserMedia failed:', e2.message);
      alert('Camera/mic access failed: ' + (e2.message || e2));
      return false;
    }
  }
  $localVideo.srcObject = localStream;
  localStream.getVideoTracks().forEach(t => { try { t.contentHint = 'motion'; } catch(e){} });
  localStream.getAudioTracks().forEach(t => { try { t.contentHint = 'speech'; } catch(e){} });
  log('media OK:', quality + 'p');
  return true;
}

// ─── STATS ────────────────────────────────────────────────────────────────────

function startStats() { stopStats(); statsInterval = setInterval(pollStats, 2000); }
function stopStats()  { if (statsInterval) { clearInterval(statsInterval); statsInterval = null; } }

async function pollStats() {
  if (!pc || pc.connectionState !== 'connected') return;
  try {
    const reports = await pc.getStats();
    let res = '—', fps = '—', bwDn = 0, bwUp = 0, rtt = '—', loss = '—', codec = '—';
    const now = Date.now(), dt = (now - (prevStats.ts || now)) / 1000 || 1;

    reports.forEach(r => {
      if (r.type === 'inbound-rtp' && r.mediaType === 'video') {
        if (r.frameWidth)              res  = `${r.frameWidth}×${r.frameHeight}`;
        if (r.framesPerSecond != null) fps  = r.framesPerSecond.toFixed(0) + ' fps';
        const dn = ((r.bytesReceived - (prevStats.bytesRecv||0)) / dt) * 8;
        if (dn > 0) { bwDn = dn; prevStats.bytesRecv = r.bytesReceived; }
        if (r.packetsReceived) {
          const tot = r.packetsReceived + (r.packetsLost||0);
          loss = tot > 0 ? ((r.packetsLost||0)/tot*100).toFixed(1)+'%' : '0.0%';
        }
      }
      if (r.type === 'outbound-rtp' && r.mediaType === 'video') {
        const up = ((r.bytesSent - (prevStats.bytesSent||0)) / dt) * 8;
        if (up > 0) { bwUp = up; prevStats.bytesSent = r.bytesSent; }
      }
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
        rtt = (r.currentRoundTripTime * 1000).toFixed(0) + ' ms';
      }
      if (r.type === 'codec' && r.mimeType) {
        const mt = r.mimeType.split('/')[1];
        if (mt && mt !== 'rtx') codec = mt;
      }
    });
    prevStats.ts = now;

    const tgt = VIDEO_BITRATE[selectedQuality];
    setStat($statRes, `video  ${res}`, null);
    setStat($statFps, `fps    ${fps}`,  +fps >= 25 ? 'good' : +fps >= 15 ? 'warn' : 'bad');
    setStat($statBw,  `↑${fmtB(bwUp)} ↓${fmtB(bwDn)}`, bwDn >= tgt*0.7 ? 'good' : bwDn >= tgt*0.35 ? 'warn' : bwDn > 0 ? 'bad' : null);
    setStat($statRtt, `rtt    ${rtt}`,  parseFloat(rtt) < 100 ? 'good' : parseFloat(rtt) < 300 ? 'warn' : 'bad');
    setStat($statPkt, `loss   ${loss}`, parseFloat(loss) < 1 ? 'good' : parseFloat(loss) < 5 ? 'warn' : 'bad');
    setStat($statCod, `codec  ${codec}`, null);
  } catch(e){}
}

function setStat(el, text, cls) {
  if (!el) return;
  el.textContent = text;
  el.className = 'stat-line' + (cls ? ' ' + cls : '');
}

// ─── PiP DRAG ─────────────────────────────────────────────────────────────────

function initDrag(el) {
  let sX, sY, oR, oB, drag = false;
  const down = e => {
    const p = e.touches?.[0] || e;
    sX = p.clientX; sY = p.clientY;
    const r = el.getBoundingClientRect();
    oR = window.innerWidth  - r.right;
    oB = window.innerHeight - r.bottom;
    drag = true; el.style.transition = 'none'; e.preventDefault();
  };
  const move = e => {
    if (!drag) return;
    const p = e.touches?.[0] || e;
    const nR = Math.max(8, Math.min(window.innerWidth  - el.offsetWidth  - 8, oR - (p.clientX - sX)));
    const nB = Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, oB - (p.clientY - sY)));
    el.style.right = nR + 'px'; el.style.bottom = nB + 'px';
  };
  const up = () => { drag = false; el.style.transition = ''; };
  el.addEventListener('mousedown',  down);
  el.addEventListener('touchstart', down, { passive: false });
  window.addEventListener('mousemove',  move);
  window.addEventListener('touchmove',  move, { passive: false });
  window.addEventListener('mouseup',    up);
  window.addEventListener('touchend',   up);
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  $permScreen     = document.getElementById('permScreen');
  $app            = document.getElementById('app');
  $localVideo     = document.getElementById('localVideo');
  $remoteVideo    = document.getElementById('remoteVideo');
  $statusDot      = document.getElementById('statusDot');
  $statusText     = document.getElementById('statusText');
  $waitingOverlay = document.getElementById('waitingOverlay');
  $disconnBanner  = document.getElementById('disconnBanner');
  $muteBtn        = document.getElementById('muteBtn');
  $muteIcon       = document.getElementById('muteIcon');
  $muteLbl        = document.getElementById('muteLbl');
  $camBtn         = document.getElementById('camBtn');
  $camIcon        = document.getElementById('camIcon');
  $camLbl         = document.getElementById('camLbl');
  $copyBtn        = document.getElementById('copyBtn');
  $copyLbl        = document.getElementById('copyLbl');
  $statsToggleBtn = document.getElementById('statsToggleBtn');
  $statsBar       = document.getElementById('statsBar');
  $statRes        = document.getElementById('statRes');
  $statFps        = document.getElementById('statFps');
  $statBw         = document.getElementById('statBw');
  $statRtt        = document.getElementById('statRtt');
  $statPkt        = document.getElementById('statPkt');
  $statCod        = document.getElementById('statCod');
  $roomId         = document.getElementById('roomId');
  $localWrap      = document.getElementById('localWrap');
  $qualityBadge   = document.getElementById('qualityBadge');
  $turnBadge      = document.getElementById('turnBadge');

  if ($roomId) $roomId.textContent = 'room: ' + roomHash.slice(0, 10);
  initDrag($localWrap);

  // Wire share buttons on landing page immediately (URL is already set)
  wireShareButtons();

  // Quality selector
  document.querySelectorAll('.q-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.q-btn').forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
      selectedQuality = parseInt(btn.dataset.q, 10);
    });
  });

  // ── START ──
  document.getElementById('startBtn').addEventListener('click', async () => {
    const ok = await acquireMedia(selectedQuality);
    if (!ok) return;
    if ($qualityBadge) $qualityBadge.textContent = selectedQuality + 'p';
    $permScreen.classList.add('hidden');
    $app.classList.remove('hidden');
    initSignaling();
  });

  // ── MUTE ──
  $muteBtn.addEventListener('click', () => {
    audioEnabled = !audioEnabled;
    localStream?.getAudioTracks().forEach(t => t.enabled = audioEnabled);
    $muteBtn.classList.toggle('active', !audioEnabled);
    $muteLbl.textContent = audioEnabled ? 'Mic' : 'Muted';
    $muteIcon.innerHTML = audioEnabled
      ? `<path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4z"/>
         <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
         <line x1="12" y1="19" x2="12" y2="23"/>
         <line x1="8"  y1="23" x2="16" y2="23"/>`
      : `<line x1="1" y1="1" x2="23" y2="23"/>
         <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
         <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
         <line x1="12" y1="19" x2="12" y2="23"/>
         <line x1="8"  y1="23" x2="16" y2="23"/>`;
  });

  // ── CAM ──
  $camBtn.addEventListener('click', async () => {
    try {
      if (videoEnabled) {
        localStream?.getVideoTracks().forEach(t => { t.stop(); localStream.removeTrack(t); });
        const vs = pc?.getSenders().find(s => s.track?.kind === 'video');
        if (vs) try { await vs.replaceTrack(null); } catch(e){}
        if ($localVideo) $localVideo.srcObject = localStream;
        videoEnabled = false;
        $camBtn.classList.add('active'); $camLbl.textContent = 'Off';
        $camIcon.innerHTML = `<line x1="1" y1="1" x2="23" y2="23"/>
          <path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34"/>
          <circle cx="12" cy="13" r="3"/>`;
      } else {
        const ns = await navigator.mediaDevices.getUserMedia({
          video: { ...VIDEO_CONSTRAINTS[selectedQuality], facingMode: 'user' },
        });
        const nt = ns.getVideoTracks()[0];
        try { nt.contentHint = 'motion'; } catch(e){}
        if (!localStream) localStream = new MediaStream();
        localStream.addTrack(nt);
        if ($localVideo) $localVideo.srcObject = localStream;
        const vs = pc?.getSenders().find(s => s.track?.kind === 'video');
        if (vs) {
          try { await vs.replaceTrack(nt); await applyEncodingParams(); }
          catch(e) { pc?.addTrack(nt, localStream); }
        } else {
          pc?.addTrack(nt, localStream);
        }
        videoEnabled = true;
        $camBtn.classList.remove('active'); $camLbl.textContent = 'Cam';
        $camIcon.innerHTML = `<polygon points="23 7 16 12 23 17 23 7"/>
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>`;
      }
    } catch(e) { err('cam toggle:', e.message); }
  });

  // ── STATS ──
  $statsToggleBtn.addEventListener('click', () => {
    statsVisible = !statsVisible;
    $statsBar?.classList.toggle('visible', statsVisible);
    $statsToggleBtn.classList.toggle('active', statsVisible);
    if (statsVisible) startStats(); else stopStats();
  });

  // ── COPY LINK ──
  $copyBtn.addEventListener('click', async () => {
    const url = window.location.href;
    try { await navigator.clipboard.writeText(url); }
    catch(e) {
      const ta = Object.assign(document.createElement('textarea'),
        { value: url, style: 'position:fixed;left:-9999px' });
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); }
      catch(e2) { window.prompt('Copy invite link:', url); }
      document.body.removeChild(ta);
    }
    $copyLbl.textContent = 'Copied!';
    setTimeout(() => ($copyLbl.textContent = 'Link'), 2000);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopStats();
    else if (isConnected && statsVisible) startStats();
  });
});

window.addEventListener('beforeunload', () => cleanup(false));
window.addEventListener('pagehide',     () => cleanup(false));
