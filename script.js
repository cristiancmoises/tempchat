'use strict';
// TempChat — 1-on-1 video call
// Signaling: ScaleDrone observable room (exactly 2 members, proven pattern)
// Offerer/answerer: second person to join is always offerer
// Track flow: offerer uses addTransceiver before offer
//             answerer uses addTrack AFTER setRemoteDescription
// Both sides always end up with both local and remote video.

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const SCALEDRONE_CHANNEL = 'yiS12Ts5RdNhebyM';
const TURN_HOST          = 'YOUR SERVER IP';
const TURN_SECRET        = 'YOUR SECRET KEY';

function buildIceServers() {
  const ttl      = Math.floor(Date.now() / 1000) + 86400;
  const username = `${ttl}:tempchat`;
  return [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.nextcloud.com:3478'  },
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
const VIDEO_BITRATE = { 360: 700_000, 720: 3_000_000, 1080: 6_000_000 };
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
// observable- prefix: ScaleDrone fires `members` event, perfect for 2-person calls
if (!location.hash) {
  location.hash = Math.random().toString(36).slice(2,10) +
                  Math.random().toString(36).slice(2,10);
}
const roomHash = location.hash.substring(1);
const roomName  = 'observable-' + roomHash;

// ─── DOM ──────────────────────────────────────────────────────────────────────
let $permScreen, $app, $localVideo, $remoteVideo;
let $statusDot, $statusText, $waitingOverlay, $disconnBanner;
let $muteBtn, $muteIcon, $muteLbl, $camBtn, $camIcon, $camLbl;
let $copyBtn, $copyLbl, $statsToggleBtn, $statsBar;
let $statRes, $statFps, $statBw, $statRtt, $statPkt, $statCod;
let $roomId, $localWrap, $qualityBadge, $turnBadge;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const log  = (...a) => console.log('[tc]', ...a);
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
  $turnBadge.className    = type ? `show ${type}` : '';
  $turnBadge.textContent  =
    type === 'relay'  ? '⚡ TURN relay' :
    type === 'direct' ? '✓ Direct P2P'  : '';
}

// ─── SDP ──────────────────────────────────────────────────────────────────────
function enhanceAudioSDP(sdp) {
  return sdp.replace(/(a=rtpmap:(\d+) opus\/48000\/2)/gi, (_, full, pt) => {
    if (sdp.includes(`a=fmtp:${pt} `)) return full;
    return full +
      `\r\na=fmtp:${pt} minptime=10;useinbandfec=1;stereo=1;` +
      `maxaveragebitrate=${AUDIO_BITRATE};cbr=0;` +
      `sprop-maxcapturerate=48000;sprop-stereo=1`;
  });
}

function preferCodecs(kind, preferred) {
  if (!RTCRtpSender.getCapabilities) return null;
  const { codecs } = RTCRtpSender.getCapabilities(kind) || {};
  if (!codecs) return null;
  return [...codecs].sort((a, b) => {
    const ai = preferred.findIndex(p => a.mimeType.toLowerCase().includes(p.toLowerCase()));
    const bi = preferred.findIndex(p => b.mimeType.toLowerCase().includes(p.toLowerCase()));
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

// ─── BITRATE ──────────────────────────────────────────────────────────────────
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

// ─── BUILD PEER CONNECTION ────────────────────────────────────────────────────
function createPC() {
  if (pc) return;
  log('createPC — isOfferer:', isOfferer);

  pc = new RTCPeerConnection({
    iceServers:           buildIceServers(),
    bundlePolicy:         'max-bundle',
    rtcpMuxPolicy:        'require',
    iceCandidatePoolSize: 4,
    iceTransportPolicy:   'all',
  });

  // Forward local ICE candidates to remote via signaling
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal({ candidate });
  };

  // Detect TURN relay vs direct path
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
      }).catch(()=>{});
    }
    // ICE restart on failure
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

  // Remote track → show in remoteVideo element
  pc.ontrack = ({ streams, track }) => {
    log('ontrack:', track.kind, '| streams:', streams?.length);
    const stream = streams?.[0];
    if (!stream) return;
    // Only attach if not already showing this stream
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
    log('connection:', s);
    if (s === 'connecting' || s === 'new') {
      setStatus('connecting', 'Connecting…');
    } else if (s === 'connected') {
      setStatus('connected', 'Connected');
      showWaiting(false);
      showDisconn(false);
      isConnected = true;
      setTimeout(applyEncodingParams, 1500);
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
}

// ─── ADD TRACKS: OFFERER ──────────────────────────────────────────────────────
// Called before createOffer(). Uses addTransceiver so we control codec prefs.
function addTracksAsOfferer() {
  if (!pc || !localStream) return;
  const vCodecs = preferCodecs('video', ['VP9','H264','VP8']);
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

// ─── ADD TRACKS: ANSWERER ─────────────────────────────────────────────────────
// Called AFTER setRemoteDescription(offer) so addTrack maps onto the
// offerer's m-lines rather than creating conflicting new ones.
function addTracksAsAnswerer() {
  if (!pc || !localStream) return;
  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
    log('answerer addTrack:', track.kind);
  });
}

// ─── OFFER ────────────────────────────────────────────────────────────────────
async function sendOffer() {
  if (!pc) return;
  try {
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    offer.sdp = enhanceAudioSDP(offer.sdp);
    await pc.setLocalDescription(offer);
    sendSignal({ sdp: pc.localDescription });
    log('offer sent');
  } catch(e) { console.error('sendOffer:', e); }
}

// ─── SIGNALING ────────────────────────────────────────────────────────────────
function sendSignal(msg) {
  if (room && drone) drone.publish({ room: roomName, message: msg });
}

function initSignaling() {
  setStatus('waiting', 'Waiting…');
  showWaiting(true);
  showDisconn(false);

  const dc = new ScaleDrone(SCALEDRONE_CHANNEL);
  drone = dc;

  dc.on('open', err => {
    if (err) { console.error('drone open:', err); return; }
    log('drone open, clientId:', dc.clientId);

    room = dc.subscribe(roomName);
    room.on('open', e => { if (e) { console.error('room open err:', e); return; } log('room open'); });

    // ── members: fires when room membership changes ────────────────────
    // members.length === 1 → we are alone, wait
    // members.length === 2 → second person joined, they become offerer
    room.on('members', members => {
      log('members:', members.length);

      if (members.length === 1) {
        // Alone in room — show waiting, do nothing
        setStatus('waiting', 'Waiting…');
        showWaiting(true);

      } else if (members.length === 2) {
        // Two people in room
        // The SECOND person to join (last in array) is the offerer
        const amILast = members[members.length - 1].id === dc.clientId;
        isOfferer = amILast;
        log('I am', isOfferer ? 'OFFERER' : 'ANSWERER');

        setStatus('connecting', 'Connecting…');
        showWaiting(false);

        if (isOfferer) {
          // Offerer: create PC, add tracks, send offer
          createPC();
          addTracksAsOfferer();
          sendOffer();
        } else {
          // Answerer: create PC, wait for offer
          // Tracks will be added in the data handler after receiving offer
          createPC();
        }
      }
    });

    // ── data: receive signaling messages ──────────────────────────────
    room.on('data', async (msg, client) => {
      // Ignore our own echoed messages
      if (client.id === dc.clientId) return;

      // ── OFFER ──
      if (msg.sdp?.type === 'offer') {
        log('received offer');
        // Answerer path: pc already created in members handler
        if (!pc) createPC();

        try {
          const sdp = { ...msg.sdp, sdp: enhanceAudioSDP(msg.sdp.sdp) };
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          log('remote description set (offer) ✓');

          // ADD TRACKS NOW — after setRemoteDescription, maps onto offer m-lines
          addTracksAsAnswerer();

          // Flush any ICE candidates that arrived before remote desc was ready
          for (const c of pendingCands) {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e){}
          }
          pendingCands = [];

          // Create and send answer
          const answer = await pc.createAnswer();
          answer.sdp = enhanceAudioSDP(answer.sdp);
          await pc.setLocalDescription(answer);
          sendSignal({ sdp: pc.localDescription });
          log('answer sent ✓');

        } catch(e) { console.error('offer handling:', e); }

      // ── ANSWER ──
      } else if (msg.sdp?.type === 'answer') {
        log('received answer');
        if (!pc) return;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          log('remote description set (answer) ✓');
          // Flush queued candidates
          for (const c of pendingCands) {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e){}
          }
          pendingCands = [];
        } catch(e) { console.error('answer handling:', e); }

      // ── ICE CANDIDATE ──
      } else if (msg.candidate) {
        if (!pc || !pc.remoteDescription) {
          pendingCands.push(msg.candidate);
          log('candidate queued, total:', pendingCands.length);
        } else {
          try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); }
          catch(e){}
        }
      }
    });
  });

  dc.on('error', e => {
    console.error('drone error:', e);
    setStatus('disconnected', 'Signaling error');
  });
}

// ─── MEDIA ────────────────────────────────────────────────────────────────────
async function acquireMedia(quality) {
  const vc = { ...VIDEO_CONSTRAINTS[quality] || VIDEO_CONSTRAINTS[720], facingMode: 'user' };
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: vc, audio: AUDIO_CONSTRAINTS });
    $localVideo.srcObject = localStream;
    localStream.getVideoTracks().forEach(t => { try { t.contentHint = 'motion'; } catch(e){} });
    localStream.getAudioTracks().forEach(t => { try { t.contentHint = 'speech'; } catch(e){} });
    log('media acquired:', quality + 'p');
    return true;
  } catch(e) {
    log('HD constraints failed, trying fallback:', e.message);
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
      $localVideo.srcObject = localStream;
      log('media acquired: fallback');
      return true;
    } catch(e2) {
      alert('Camera/mic access failed: ' + (e2.message || e2));
      return false;
    }
  }
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
          video: { ...VIDEO_CONSTRAINTS[selectedQuality], facingMode: 'user' }
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
    } catch(e) { console.error('cam toggle:', e); }
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
      try { document.execCommand('copy'); } catch(e2) { window.prompt('Copy link:', url); }
      document.body.removeChild(ta);
    }
    $copyLbl.textContent = 'Copied!';
    setTimeout(() => ($copyLbl.textContent = 'Link'), 2000);
  });

  // Pause stats when app goes to background (mobile)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopStats();
    else if (isConnected && statsVisible) startStats();
  });
});

window.addEventListener('beforeunload', () => cleanup(false));
window.addEventListener('pagehide',     () => cleanup(false));
