import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { redis, pipeline, dbReady, sameOrigin, limited, clientIp, adminCheck, send, readJson } from "./_store.mjs";

const S_IDX = "ryzebooth:community:strips";
const P_IDX = "ryzebooth:community:papers";
const sKey  = id => "ryzebooth:community:strip:" + id;
const oKey  = id => "ryzebooth:community:overlay:" + id;

const MAX_STRIPS = 100;              
const MAX_PAPERS = 300;
const MAX_SHOTS  = 8;              
const MAX_OVERLAY_CHARS = 700_000;   
const PNG_HEAD = "data:image/png;base64,";
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ID_RE = /^[a-z0-9-]{6,40}$/;

const sha = s => createHash("sha256").update(String(s)).digest();

export default async function handler(req, res){
  if(req.method === "GET")    return handleGet(req, res);
  if(req.method === "POST")   return handlePost(req, res);
  if(req.method === "DELETE") return handleDelete(req, res);
  return send(res, 405, { error: "method not allowed" });
}

const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : null;
};

function cleanLabel(v){
  const s = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 26);
  return s || "Custom strip";
}

function cleanLayout(b){
  const f = {
    label: cleanLabel(b.label),
    cols: num(b.cols, 1, 6),   rows: num(b.rows, 1, 8),
    cw:   num(b.cw, 120, 2000), ch:  num(b.ch, 120, 2000),
    pad:  num(b.pad, 0, 200),   gap: num(b.gap, 0, 200),
    foot: num(b.foot, 0, 400),  rad: num(b.rad, 0, 120)
  };
  if(Object.values(f).some(v => v === null)) return null;
  if(f.cols * f.rows > MAX_SHOTS) return null;
  return f;
}

function cleanOverlay(u){
  if(u == null || u === "") return "";
  if(typeof u !== "string" || !u.startsWith(PNG_HEAD) || u.length > MAX_OVERLAY_CHARS) return null;
  const b64 = u.slice(PNG_HEAD.length);
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const head = Buffer.from(b64.slice(0, 16), "base64");
  if(head.length < 8 || !PNG_MAGIC.every((x, i) => head[i] === x)) return null;
  return u;
}

function cleanPaper(p){
  if(typeof p !== "string") return null;
  const s = p.trim();
  if(/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  const m = /^grad:(#[0-9a-f]{6}),(#[0-9a-f]{6}),(\d{1,3})$/i.exec(s);
  if(!m) return null;
  const ang = Number(m[3]);
  if(ang > 360) return null;
  return `grad:${m[1].toUpperCase()},${m[2].toUpperCase()},${ang}`;
}

const ownerOf = req => {
  const o = String(req.headers["x-owner"] || "");
  return /^[A-Za-z0-9_-]{16,80}$/.test(o) ? o : "";
};

const publicStrip = r => ({
  id: r.id, at: r.at, label: r.label,
  cols: r.cols, rows: r.rows, cw: r.cw, ch: r.ch, pad: r.pad, gap: r.gap, foot: r.foot, rad: r.rad,
  overlay: r.ov ? "/api/community?overlay=" + r.id : null
});

async function handleGet(req, res){
  if(limited("community-get:" + clientIp(req), 120, 60 * 1000))
    return send(res, 429, { error: "too many requests" });
  if(!dbReady()) return send(res, 200, { db: false, strips: [], papers: [] });

  const url = new URL(req.url, "http://x");
  const overlayId = url.searchParams.get("overlay");

  if(overlayId){
    if(!ID_RE.test(overlayId)) return send(res, 400, { error: "bad id" });
    try{
      const data = await redis("GET", oKey(overlayId));
      if(!data || !data.startsWith(PNG_HEAD)) return send(res, 404, { error: "not found" });
      const buf = Buffer.from(data.slice(PNG_HEAD.length), "base64");
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.status(200).end(buf);
    }catch(e){
      return send(res, 500, { error: "load failed" });
    }
  }

  try{
    const [ids, papers] = await pipeline([
      ["ZREVRANGE", S_IDX, 0, MAX_STRIPS - 1],
      ["ZREVRANGE", P_IDX, 0, MAX_PAPERS - 1]
    ]);
    const rows = ids && ids.length ? await redis("MGET", ...ids.map(sKey)) : [];
    const strips = [];
    for(const raw of rows || []){
      if(!raw) continue;
      try{ strips.push(publicStrip(JSON.parse(raw))); }catch(e){}
    }
    return send(res, 200, { db: true, strips, papers: papers || [] },
      { "Cache-Control": "public, max-age=0, s-maxage=10, stale-while-revalidate=30" });
  }catch(e){
    return send(res, 200, { db: false, strips: [], papers: [] });
  }
}

async function handlePost(req, res){
  if(!sameOrigin(req)) return send(res, 403, { error: "cross-origin" });
  const body = readJson(req);
  const type = body && body.type;
  if(type !== "strip" && type !== "paper") return send(res, 400, { error: "bad request" });

  const [max, win] = type === "strip" ? [10, 60_000] : [30, 60_000];
  if(limited("community-post-" + type + ":" + clientIp(req), max, win))
    return send(res, 429, { error: "too many requests" });
  if(!dbReady()) return send(res, 501, { error: "no-database" });

  if(type === "paper"){
    const paper = cleanPaper(body.paper);
    if(!paper) return send(res, 400, { error: "bad colour" });
    try{
      await redis("ZADD", P_IDX, "NX", Date.now(), paper);
      trim(P_IDX, MAX_PAPERS, () => []).catch(() => {});
      return send(res, 200, { ok: true, paper });
    }catch(e){
      return send(res, 500, { error: "save failed" });
    }
  }

  const owner = ownerOf(req);
  if(!owner) return send(res, 400, { error: "missing owner" });
  const layout = cleanLayout(body);
  if(!layout) return send(res, 400, { error: "bad layout" });
  const overlay = cleanOverlay(body.overlay);
  if(overlay === null) return send(res, 400, { error: "bad overlay" });

  const id = Date.now().toString(36) + "-" + randomUUID().slice(0, 8);
  const at = Date.now();
  const record = { id, at, ...layout, ov: !!overlay, o: sha(owner).toString("hex") };
  const cmds = [
    ["SET", sKey(id), JSON.stringify(record)],
    ["ZADD", S_IDX, at, id]
  ];
  if(overlay) cmds.push(["SET", oKey(id), overlay]);

  try{
    await pipeline(cmds);
    trim(S_IDX, MAX_STRIPS, old => old.flatMap(x => [["DEL", sKey(x)], ["DEL", oKey(x)]])).catch(() => {});
    return send(res, 200, { ok: true, strip: publicStrip(record) });
  }catch(e){
    return send(res, 500, { error: "save failed" });
  }
}

async function trim(idx, keep, extraCmds){
  const count = await redis("ZCARD", idx);
  if(!count || count <= keep) return;
  const old = await redis("ZRANGE", idx, 0, count - keep - 1);
  if(!old || !old.length) return;
  await pipeline([["ZREM", idx, ...old], ...extraCmds(old)]);
}

async function handleDelete(req, res){
  if(!sameOrigin(req)) return send(res, 403, { error: "cross-origin" });
  if(limited("community-del:" + clientIp(req), 30, 60 * 1000))
    return send(res, 429, { error: "too many requests" });
  if(!dbReady()) return send(res, 501, { error: "no-database" });

  const url  = new URL(req.url, "http://x");
  const type = url.searchParams.get("type");

  let admin = false;
  if(req.headers["x-admin-pass"]){
    const check = adminCheck(req);
    if(!check.ok) return send(res, check.status, { error: check.error });
    admin = true;
  }

  if(type === "paper"){
    if(!admin) return send(res, 401, { error: "admin only" });
    const paper = cleanPaper(url.searchParams.get("value"));
    if(!paper) return send(res, 400, { error: "bad colour" });
    try{
      await redis("ZREM", P_IDX, paper);
      return send(res, 200, { ok: true });
    }catch(e){ return send(res, 500, { error: "delete failed" }); }
  }

  if(type === "strip"){
    const id = url.searchParams.get("id") || "";
    if(!ID_RE.test(id)) return send(res, 400, { error: "bad id" });
    try{
      if(!admin){
        const owner = ownerOf(req);
        const raw = owner ? await redis("GET", sKey(id)) : null;
        let ok = false;
        if(raw){
          try{
            const rec = JSON.parse(raw);
            ok = typeof rec.o === "string" && rec.o.length === 64 &&
                 timingSafeEqual(Buffer.from(rec.o, "hex"), sha(owner));
          }catch(e){}
        }
        if(!ok) return send(res, 403, { error: "not yours to delete" });
      }
      await pipeline([["ZREM", S_IDX, id], ["DEL", sKey(id)], ["DEL", oKey(id)]]);
      return send(res, 200, { ok: true });
    }catch(e){ return send(res, 500, { error: "delete failed" }); }
  }

  return send(res, 400, { error: "bad request" });
}
