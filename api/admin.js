import { sameOrigin, limited, clientIp, adminCheck, send, readJson } from "./_store.mjs";

export default async function handler(req, res){
  if(req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  if(!sameOrigin(req))      return send(res, 403, { error: "cross-origin" });
  if(limited("admin-req:" + clientIp(req), 30, 60 * 1000))
    return send(res, 429, { error: "too many requests" });

  const body = readJson(req);
  const pass = body && typeof body.pass === "string" ? body.pass : "";

  req.headers["x-admin-pass"] = encodeURIComponent(pass);
  const check = adminCheck(req);
  if(!check.ok) return send(res, check.status, { error: check.error });
  return send(res, 200, { ok: true });
}
