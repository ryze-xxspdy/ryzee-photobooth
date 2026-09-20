/* ══════════════════════════════════════════════════════════════
   ice.js — connection toolkit for the Duo Booth
   ──────────────────────────────────────────────────────────────
   Loaded BEFORE app.js. Exposes one global: ICE.

   What it does
   • Fetches short-lived TURN credentials from /api/ice, so no
     relay password ever sits in the page source.
   • Caches them for the session; if the endpoint is down it falls
     back to the list app.js hands over, so a call is never blocked
     on our own server.
   • Can force "relay-only" mode. When a direct path fails twice,
     the next dial goes through TURN only — that is the setting
     that turns a black screen into a working (if relayed) video.
   • Probes the network so we can warn early instead of failing late.
   • Caps video bitrate so a mobile-data partner doesn't stall.
   ══════════════════════════════════════════════════════════════ */
(function(){
  "use strict";

  const CACHE_KEY = "ryze.ice.v2";
  const ENDPOINT  = "/api/ice";
  const FETCH_MS  = 2500;   // don't make the first dial wait long on a slow provider —
                             // fall back to the built-in STUN/TURN list quickly instead

  let fallback = [{ urls: "stun:stun.l.google.com:19302" }];
  let inflight = null;

  /* Only accept well-formed stun/turn/turns URLs from the network. */
  function clean(list){
    if(!Array.isArray(list)) return [];
    const out = [];
    for(const s of list){
      if(!s || typeof s !== "object") continue;
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls])
        .filter(u => typeof u === "string" && /^(stun|turn|turns):[^\s]+$/i.test(u))
        .slice(0, 8);
      if(!urls.length) continue;
      const entry = { urls };
      if(typeof s.username === "string"   && s.username.length   < 512) entry.username   = s.username;
      if(typeof s.credential === "string" && s.credential.length < 512) entry.credential = s.credential;
      out.push(entry);
    }
    return out;
  }

  function readCache(){
    try{
      const c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
      if(c && c.exp > Date.now() + 60000){
        const s = clean(c.servers);
        if(s.length) return s;
      }
    }catch(e){}
    return null;
  }
  function writeCache(servers, ttlSec){
    try{
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        servers, exp: Date.now() + Math.min(ttlSec || 3600, 3600) * 1000
      }));
    }catch(e){}
  }

  async function fetchFresh(){
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FETCH_MS);
    try{
      const res = await fetch(ENDPOINT, { cache: "no-store", signal: ctl.signal, credentials: "same-origin" });
      if(!res.ok) throw new Error("ice endpoint " + res.status);
      const j = await res.json();
      const servers = clean(j && j.iceServers);
      if(!servers.length) throw new Error("ice endpoint returned nothing usable");
      return { servers, ttl: +j.ttl || 3600, provider: j.provider || "unknown", degraded: !!j.degraded };
    }finally{ clearTimeout(t); }
  }

  /* Never rejects. Always resolves with something dialable. */
  function get(){
    const cached = readCache();
    if(cached) return Promise.resolve(cached);
    if(inflight) return inflight;
    inflight = fetchFresh()
      .then(r => {
        if(!r.degraded) writeCache(r.servers, r.ttl);
        console.log("[ice] servers from", r.provider + (r.degraded ? " (degraded)" : ""));
        return r.servers;
      })
      .catch(err => {
        console.warn("[ice] using built-in fallback:", err && err.message);
        return clean(fallback);
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  function rtcConfig(servers, relayOnly){
    return {
      iceServers: servers,
      iceCandidatePoolSize: relayOnly ? 0 : 4,
      iceTransportPolicy: relayOnly ? "relay" : "all",
      bundlePolicy: "max-bundle"
    };
  }

  /* PeerJS 1.x builds every RTCPeerConnection from peer.options.config,
     so changing it here affects the NEXT call. Wrapped in try/catch
     because it leans on a PeerJS internal. */
  function setRelayOnly(peer, on){
    try{
      if(!peer || !peer.options) return false;
      peer.options.config = Object.assign({}, peer.options.config, {
        iceTransportPolicy: on ? "relay" : "all",
        iceCandidatePoolSize: on ? 0 : 4
      });
      return true;
    }catch(e){ return false; }
  }

  /* Gathers candidates for a few seconds and reports which kinds we got.
     `relay` = we can reach the TURN server, which is the safety net. */
  function probe(servers, ms){
    return new Promise(resolve => {
      const seen = { host: 0, srflx: 0, relay: 0 };
      const t0 = Date.now();
      let pc, done = false;
      const finish = () => {
        if(done) return; done = true;
        try{ pc && pc.close(); }catch(e){}
        resolve({ ...seen, ms: Date.now() - t0 });
      };
      try{
        pc = new RTCPeerConnection(rtcConfig(servers, false));
        pc.createDataChannel("probe");
        pc.onicecandidate = e => {
          if(!e.candidate){ finish(); return; }
          const m = / typ (host|srflx|relay) /.exec(e.candidate.candidate);
          if(m) seen[m[1]]++;
          if(seen.relay) setTimeout(finish, 400);   // got what we came for
        };
        pc.createOffer().then(o => pc.setLocalDescription(o)).catch(finish);
        setTimeout(finish, ms || 5000);
      }catch(e){ finish(); }
    });
  }

  /* Keep the outgoing video inside what the path can carry. */
  async function capBitrate(pc, kbps){
    try{
      for(const sender of pc.getSenders()){
        if(!sender.track || sender.track.kind !== "video") continue;
        const p = sender.getParameters();
        if(!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = kbps * 1000;
        p.degradationPreference = "maintain-framerate";
        await sender.setParameters(p);
      }
    }catch(e){ /* not supported everywhere — harmless */ }
  }

  window.ICE = {
    get, rtcConfig, setRelayOnly, probe, capBitrate,
    prefetch(){ get(); },
    setFallback(list){ const c = clean(list); if(c.length) fallback = c; }
  };
})();
