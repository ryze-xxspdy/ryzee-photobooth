import { redis, dbReady, sameOrigin, limited, clientIp, adminCheck, send, readJson } from "./_store.mjs";

const KEY = "ryzebooth:design";
const DEFAULT_DESIGN = {
  theme: "dark",
  frame: "strip4",
  look: "none",
  timer: 3,
  logoSize: 1.2,
  enableSoloDuo: true
};

export default async function handler(req, res){
  if(req.method === "GET"){
    if(!dbReady()) return send(res, 200, { db: false, design: DEFAULT_DESIGN });
    try{
      const raw = await redis("GET", KEY);
      const stored = raw ? JSON.parse(raw) : {};
      const design = { ...DEFAULT_DESIGN, ...stored };
      return send(res, 200, { db: true, design });
    }catch(e){
      return send(res, 200, { db: false, design: DEFAULT_DESIGN });
    }
  }

  if(req.method === "PUT"){
    if(!sameOrigin(req)) return send(res, 403, { error: "cross-origin" });
    if(limited("design-put:" + clientIp(req), 20, 60 * 1000))
      return send(res, 429, { error: "too many requests" });

    const check = adminCheck(req);
    if(!check.ok) return send(res, check.status, { error: check.error });
    if(!dbReady()) return send(res, 501, { error: "no-database" });

    const body = readJson(req);
    const design = { ...DEFAULT_DESIGN };
    
    if(typeof body?.theme === "string" && body.theme.length < 40) 
      design.theme = body.theme;
    if(typeof body?.frame === "string" && body.frame.length < 40) 
      design.frame = body.frame;
    if(typeof body?.look === "string" && body.look.length < 40) 
      design.look = body.look;
    if(typeof body?.timer === "number" && body.timer > 0 && body.timer < 60) 
      design.timer = body.timer;
    if(typeof body?.logoSize === "number" && body.logoSize > 0.5 && body.logoSize < 3) 
      design.logoSize = body.logoSize;
    if(typeof body?.enableSoloDuo === "boolean") 
      design.enableSoloDuo = body.enableSoloDuo;

    try{
      await redis("SET", KEY, JSON.stringify(design));
      return send(res, 200, design);
    }catch(e){
      return send(res, 500, { error: "save failed" });
    }
  }

  return send(res, 405, { error: "method not allowed" });
}
