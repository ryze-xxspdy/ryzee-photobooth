import { createHash, timingSafeEqual } from "node:crypto";

const env = () => ({
  url:   (process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL   || "").replace(/\/+$/, ""),
  token:  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || ""
});
export const dbReady = () => { const e = env(); return !!(e.url && e.token); };

async function call(path, body){
  const { url, token } = env();
  const r = await fetch(url + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error("redis " + r.status + " " + (j && j.error || ""));
  return j;
}

export async function redis(...cmd){
  const j = await call("", cmd);
  if(j.error) throw new Error(j.error);
  return j.result;
}

export async function pipeline(cmds){
  const j = await call("/pipeline", cmds);
  return j.map(x => { if(x && x.error) throw new Error(x.error); return x && x.result; });
}

export function send(res, status, obj, headers = {}){
  res.setHeader("Cache-Control", "no-store");
  for(const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(status).json(obj);
}
export const clientIp = req =>
  String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "?";


export function sameOrigin(req){
  const o = req.headers.origin;
  if(!o) return false;
  let host; try{ host = new URL(o).host; }catch(e){ return false; }
  if(host === (req.headers["x-forwarded-host"] || req.headers.host)) return true;
  const extra = (process.env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  return extra.some(e => { try{ return new URL(e).host === host; }catch(_){ return false; } });
}

const hits = new Map();
export function limited(key, max, windowMs){
  const now = Date.now();
  if(hits.size > 5000) for(const [k, v] of hits) if(v.reset < now) hits.delete(k);
  let h = hits.get(key);
  if(!h || h.reset < now){ h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  h.n++;
  return h.n > max;
}

export function adminCheck(req){
  const real = process.env.ADMIN_PASS;
  if(!real) return { ok: false, status: 501, error: "ADMIN_PASS is not set" };
  const key = "adm-fail:" + clientIp(req);
  const rec = hits.get(key);
  if(rec && rec.reset > Date.now() && rec.n >= 10)
    return { ok: false, status: 429, error: "too many tries" };
  let given = "";
  try{ given = decodeURIComponent(String(req.headers["x-admin-pass"] || "")); }catch(e){}
  const h = s => createHash("sha256").update(String(s)).digest();   // equal length → timingSafeEqual is safe
  if(timingSafeEqual(h(given), h(real))){ hits.delete(key); return { ok: true }; }
  limited(key, 10, 10 * 60 * 1000);                                 // only wrong guesses count
  return { ok: false, status: 401, error: "wrong passcode" };
}

export function readJson(req){
  const b = req.body;
  if(b && typeof b === "object" && !Buffer.isBuffer(b)) return b;
  if(typeof b === "string"){ try{ return JSON.parse(b); }catch(e){ return null; } }
  return null;
}
