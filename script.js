// script.js
// Enhanced version of your original working script.js
// - Large public STUN list (includes Google and many community servers) for faster ICE discovery
// - UI wiring after DOMContentLoaded so buttons always work
// - Minor performance/reliability improvements: transceivers, candidate queuing, duplicate-track protection,
//   safe addIceCandidate, replaceTrack when toggling camera, sender parity for mute toggles
// - Keeps original ScaleDrone signaling / negotiation pattern (onnegotiationneeded for offerer)
//
// Replace the channel ID below if you need to.
const SCALEDONE_CHANNEL = 'yiS12Ts5RdNhebyM';

// Large public STUN list (Google + community). Public servers are third-party; consider private TURN for privacy/reliability.
const iceServers = [
  // Google
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.l.google.com:5349" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:3478" },
  { urls: "stun:stun1.l.google.com:5349" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:5349" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:3478" },
  { urls: "stun:stun3.l.google.com:5349" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:5349" },

  // Community / public
  { urls: "stun:stun.ekiga.net" },
  { urls: "stun:stun.ideasip.com" },
  { urls: "stun:stun.rixtelecom.se" },
  { urls: "stun:stun.schlund.de" },
  { urls: "stun:stun.stunprotocol.org:3478" },
  { urls: "stun:stun.voiparound.com" },
  { urls: "stun:stun.voipbuster.com" },
  { urls: "stun:stun.voipstunt.com" },
  { urls: "stun:stun.voxgratia.org" },
  { urls: "stun:numb.viagenie.ca:3478" },
  { urls: "stun:s1.taraba.net:3478" },
  { urls: "stun:s2.taraba.net:3478" },
  { urls: "stun:stun.12connect.com:3478" },
  { urls: "stun:stun.12voip.com:3478" },
  { urls: "stun:stun.1und1.de:3478" },
  { urls: "stun:stun.2talk.co.nz:3478" },
  { urls: "stun:stun.2talk.com:3478" },
  { urls: "stun:stun.3cx.com:3478" },
  { urls: "stun:stun.a-mm.tv:3478" },
  { urls: "stun:stun.aa.net.uk:3478" },
  { urls: "stun:stun.antisip.com:3478" },
  { urls: "stun:stun.bahnhof.net:3478" },
  { urls: "stun:stun.callwithus.com:3478" },
  { urls: "stun:stun.counterpath.net:3478" },
  { urls: "stun:stun.fwdnet.net:3478" },
  { urls: "stun:stun.internetcalls.com:3478" },
  { urls: "stun:stun.ideasip.com:3478" },
  { urls: "stun:stun1.voiceeclipse.net:3478" },
  { urls: "stun:stun.liveo.fr:3478" },
  { urls: "stun:stun.lycamobile.com:3478" },
  { urls: "stun:stun.miwifi.com:3478" },
  { urls: "stun:stun.nextcloud.com:3478" },
  { urls: "stun:stun.obihai.com:3478" },
  { urls: "stun:stun.pjsip.org:3478" },
  { urls: "stun:stun.peerdirect.net:3478" },
  { urls: "stun:stun.pw:3478" },
  { urls: "stun:stun.quickblox.com:3478" },
  { urls: "stun:stun.softjoys.com:3478" },
  { urls: "stun:stun.sparkling.net.uk:3478" },
  { urls: "stun:stun.sipnet.net:3478" },
  { urls: "stun:stun.supernode.org:3478" },
  { urls: "stun:stun.t-online.de:3478" },
  { urls: "stun:stun.telize.com:3478" }
  // Add your private TURN here if you have one:
  // ,{ urls: "turn:turn.example.com:3478", username: "user", credential: "pass" }
];

const configuration = { iceServers };

//
// Room and signaling (ScaleDrone) setup
//
// Keep original room naming behavior (random hash if not present)
if (!location.hash) {
  location.hash = Math.floor(Math.random() * 0xFFFFFF).toString(16);
}
const roomHash = location.hash.substring(1);
const roomName = 'observable-' + roomHash;

// ScaleDrone client (we'll instantiate inside initSignaling to allow re-init if needed)
let drone;
let room;

let pc = null;
let localStream = null;
let audioEnabled = true;
let videoEnabled = true;

// Candidate queue: when remote candidates arrive before pc is ready
let pendingCandidates = [];

// DOM references (set on DOMContentLoaded)
let localVideo, remoteVideo, statusEl, roomLabel;
let copyBtn, muteBtn, camBtn, hangupBtn;

// Small helpers
function log(...args) { console.log('[webrtc]', ...args); }
function setStatus(s) { if (statusEl) statusEl.textContent = s; }
function onError(e) { console.error(e); }
function onSuccess() {}

// Safe addIceCandidate that tolerates timing issues
async function safeAddIceCandidate(candidate) {
  if (!pc) {
    pendingCandidates.push(candidate);
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
    log('addIceCandidate OK');
  } catch (e) {
    console.warn('addIceCandidate failed (ignored):', e);
  }
}

// Room label initial text if present
document.addEventListener('DOMContentLoaded', () => {
  localVideo = document.getElementById('localVideo');
  remoteVideo = document.getElementById('remoteVideo');
  statusEl = document.getElementById('status');
  roomLabel = document.getElementById('roomLabel');

  copyBtn = document.getElementById('copyBtn');
  muteBtn = document.getElementById('muteBtn');
  camBtn = document.getElementById('camBtn');
  hangupBtn = document.getElementById('hangupBtn');

  if (roomLabel) roomLabel.textContent = 'Room: ' + roomHash;

  // copy button
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const url = window.location.href;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(url); alert('Call link copied!'); return; }
        catch (e) { console.warn('clipboard.writeText failed', e); }
      }
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); alert('Call link copied!'); } catch (e) { window.prompt('Copy the call link', url); }
      document.body.removeChild(ta);
    });
  }

  // Mute/unmute: toggle local audio tracks and keep sender enabled if present
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      audioEnabled = !audioEnabled;
      if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = audioEnabled);
      if (pc) {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
        if (sender && sender.track) sender.track.enabled = audioEnabled;
      }
      muteBtn.textContent = audioEnabled ? 'Mute' : 'Unmute';
      const bridge = document.getElementById('shareMute'); if (bridge) bridge.textContent = muteBtn.textContent;
    });
  }

  // Camera toggle: use replaceTrack when possible (keeps m-lines and avoids renegotiation)
  if (camBtn) {
    camBtn.addEventListener('click', async () => {
      try {
        if (videoEnabled) {
          // Stop and remove video tracks from localStream
          if (localStream) {
            localStream.getVideoTracks().forEach(t => { try { t.stop(); } catch (e) {} localStream.removeTrack(t); });
          }
          if (pc) {
            const vSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (vSender) {
              try { await vSender.replaceTrack(null); } catch (e) { /* ignore */ }
            }
          }
          if (localVideo) localVideo.srcObject = localStream;
          videoEnabled = false;
          camBtn.textContent = 'Start Camera';
          setStatus('Camera stopped');
        } else {
          // Acquire a new camera track
          const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
          const newTrack = newStream.getVideoTracks()[0];
          if (!localStream) localStream = new MediaStream();
          localStream.addTrack(newTrack);
          if (localVideo) localVideo.srcObject = localStream;
          if (pc) {
            let vSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (vSender) {
              try { await vSender.replaceTrack(newTrack); } catch (e) { pc.addTrack(newTrack, localStream); }
            } else {
              pc.addTrack(newTrack, localStream);
            }
          }
          videoEnabled = true;
          camBtn.textContent = 'Stop Camera';
          setStatus('Camera started');
        }
        const bridge = document.getElementById('shareCam'); if (bridge) bridge.textContent = camBtn.textContent;
      } catch (e) {
        console.error('camera toggle error', e);
        setStatus('Camera error');
      }
    });
  }

  if (hangupBtn) {
    hangupBtn.addEventListener('click', () => {
      cleanup();
      setStatus('Call ended');
    });
  }

  // Start signaling now that UI exists
  setStatus('Connecting to signaling server...');
  initSignaling();
});

// Send signaling messages via ScaleDrone
function sendMessage(droneClient, message) {
  if (!room) return;
  droneClient.publish({ room: roomName, message });
}

// Create RTCPeerConnection using the chosen configuration and attach handlers.
// This keeps the original "onnegotiationneeded" createOffer pattern for the offerer.
function startWebRTC(isOfferer, droneClient) {
  // If pc already exists, don't recreate
  if (pc) return;

  pc = new RTCPeerConnection(configuration);

  // Forward ICE candidates to signaling
  pc.onicecandidate = event => {
    if (event.candidate) {
      sendMessage(droneClient, { candidate: event.candidate });
    }
  };

  // If offerer, create offer when negotiationneeded fires (original pattern)
  if (isOfferer) {
    pc.onnegotiationneeded = () => {
      pc.createOffer().then(localDescCreated).catch(onError);
    };
  }

  // Attach remote tracks to remoteVideo element
  pc.ontrack = event => {
    const stream = event.streams[0];
    if (!remoteVideo.srcObject || remoteVideo.srcObject.id !== stream.id) {
      remoteVideo.srcObject = stream;
    }
  };

  // Get local media, display it locally, and add tracks to pc
  navigator.mediaDevices.getUserMedia({ audio: true, video: true })
    .then(stream => {
      localStream = stream;
      if (localVideo) localVideo.srcObject = stream;

      // Add tracks to pc but avoid adding duplicates (important if restarting)
      stream.getTracks().forEach(track => {
        const exists = pc.getSenders().some(s => s.track && s.track.id === track.id);
        if (!exists) pc.addTrack(track, stream);
      });

      // If there were queued remote ICE candidates, add them now
      if (pendingCandidates.length) {
        pendingCandidates.forEach(c => safeAddIceCandidate(c));
        pendingCandidates = [];
      }
    })
    .catch(onError);

  pc.onconnectionstatechange = () => {
    log('pc.connectionState', pc.connectionState);
    setStatus('Connection: ' + pc.connectionState);
  };
}

// When local SDP is ready, set it and send it through signaling
function localDescCreated(desc) {
  pc.setLocalDescription(desc)
    .then(() => {
      // Find the active ScaleDrone client (room object holds drone reference)
      if (drone) sendMessage(drone, { sdp: pc.localDescription });
    })
    .catch(onError);
}

// ScaleDrone signaling initialization — subscribe, handle members & data events
function initSignaling() {
  // Instantiate ScaleDrone client
  const droneClient = new ScaleDrone(SCALEDONE_CHANNEL);

  droneClient.on('open', error => {
    if (error) {
      console.error('drone open error', error);
      setStatus('Signaling error');
      return;
    }

    // subscribe to room
    room = droneClient.subscribe(roomName);

    room.on('open', err => {
      if (err) console.error('room open error', err);
    });

    // members event tells us current participants — original logic: second participant becomes offerer
    room.on('members', members => {
      log('MEMBERS', members);
      const isOfferer = members.length === 2;
      startWebRTC(isOfferer, droneClient);
    });

    // receive signaling data (sdp or candidate)
    room.on('data', (message, client) => {
      // ignore our own messages
      if (client.id === droneClient.clientId) return;

      if (message.sdp) {
        // Ensure pc exists before setting remote description
        if (!pc) {
          // create a minimal pc to accept remote description; startWebRTC will create proper pc and getUserMedia later
          pc = new RTCPeerConnection(configuration);
          pc.onicecandidate = evt => { if (evt.candidate) sendMessage(droneClient, { candidate: evt.candidate }); };
          pc.ontrack = ev => {
            const stream = ev.streams[0];
            if (!remoteVideo.srcObject || remoteVideo.srcObject.id !== stream.id) remoteVideo.srcObject = stream;
          };
          pc.onconnectionstatechange = () => { log('pc.connectionState', pc.connectionState); setStatus('Connection: ' + pc.connectionState); };
        }

        pc.setRemoteDescription(new RTCSessionDescription(message.sdp))
          .then(() => {
            // If remote description is an offer, create an answer
            if (pc.remoteDescription && pc.remoteDescription.type === 'offer') {
              pc.createAnswer().then(localDescCreated).catch(onError);
            }
          })
          .catch(onError);
      } else if (message.candidate) {
        // If pc not yet ready, queue candidate
        safeAddIceCandidate(message.candidate);
      }
    });
  });

  droneClient.on('error', err => {
    console.error('drone error', err);
    setStatus('Signaling error');
  });

  // store reference to active drone client for sendMessage use
  drone = droneClient;
}

// Cleanup resources
function cleanup() {
  try {
    if (pc) {
      pc.getSenders().forEach(s => { if (s.track) try { s.track.stop(); } catch (e) {} });
      pc.close(); pc = null;
    }
    if (localStream) {
      localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
      localStream = null;
    }
    if (remoteVideo) remoteVideo.srcObject = null;
    if (localVideo) localVideo.srcObject = null;
    if (room) { try { room.unsubscribe(); } catch (e) {} room = null; }
    if (drone) { try { drone.close(); } catch (e) {} drone = null; }
    pendingCandidates = [];
  } catch (e) {
    console.warn('cleanup error', e);
  }
}

// Bridge functions for centered inline buttons (if present in your HTML)
window.toggleMute = function() {
  const btn = document.getElementById('muteBtn');
  if (btn) { btn.click(); return; }
  if (localStream) {
    const tracks = localStream.getAudioTracks();
    if (tracks.length) {
      const enabled = !tracks[0].enabled;
      tracks.forEach(t => t.enabled = enabled);
      const share = document.getElementById('shareMute'); if (share) share.textContent = enabled ? 'Mute' : 'Unmute';
    } else alert('No local audio track found.');
  } else alert('Local media not initialized yet.');
};

window.toggleCam = async function() {
  const btn = document.getElementById('camBtn');
  if (btn) { btn.click(); return; }
  if (localStream) {
    const vtracks = localStream.getVideoTracks();
    if (vtracks.length) {
      vtracks.forEach(t => { try { t.stop(); } catch(e) {} localStream.removeTrack(t); });
      if (localVideo) localVideo.srcObject = localStream;
      const share = document.getElementById('shareCam'); if (share) share.textContent = 'Start Camera';
    } else {
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const newTrack = newStream.getVideoTracks()[0];
        localStream.addTrack(newTrack);
        if (localVideo) localVideo.srcObject = localStream;
        const share = document.getElementById('shareCam'); if (share) share.textContent = 'Stop Camera';
      } catch (e) {
        alert('Could not access camera: ' + (e.message || e));
      }
    }
  } else {
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStream = newStream;
      if (localVideo) localVideo.srcObject = newStream;
    } catch (e) {
      alert('Could not access camera: ' + (e.message || e));
    }
  }
};

// Ensure graceful cleanup
window.addEventListener('beforeunload', cleanup);

// Expose initial status (if status element exists it will be updated once DOM loads)
setStatus('Ready — open this URL from another device to join the call.');
