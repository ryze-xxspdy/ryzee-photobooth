import { redis, dbReady, sameOrigin, limited, clientIp, adminCheck, send, readJson } from "./_store.mjs";

const KEY = "ryzebooth:hiddenPapers";
const MAX_ITEMS = 200;

export default async function handler(req, res){
  if(req.method === "GET"){
    if(!dbReady()) return send(res, 200, { db: false, hiddenPapers: [] });
    try{
      const raw = await redis("GET", KEY);
      const hiddenPapers = raw ? JSON.parse(raw) : [];
      return send(res, 200, { db: true, hiddenPapers: Array.isArray(hiddenPapers) ? hiddenPapers : [] });
    }catch(e){
      return send(res, 200, { db: false, hiddenPapers: [] });
    }
  }

  if(req.method === "PUT"){
    if(!sameOrigin(req)) return send(res, 403, { error: "cross-origin" });
    if(limited("config-put:" + clientIp(req), 20, 60 * 1000))
      return send(res, 429, { error: "too many requests" });

    const check = adminCheck(req);
    if(!check.ok) return send(res, check.status, { error: check.error });
    if(!dbReady()) return send(res, 501, { error: "no-database" });

    const body = readJson(req);
    const list = Array.isArray(body && body.hiddenPapers)
      ? body.hiddenPapers.filter(x => typeof x === "string" && x.length < 80).slice(0, MAX_ITEMS)
      : [];
    try{
      await redis("SET", KEY, JSON.stringify(list));
      return send(res, 200, { hiddenPapers: list });
    }catch(e){
      return send(res, 500, { error: "save failed" });
    }
  }

  return send(res, 405, { error: "method not allowed" });
}
