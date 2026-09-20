import { send } from "./_store.mjs";

const httpUrl = v => {
  try{
    const u = new URL(String(v || ""));
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
  }catch(e){ return ""; }
};

export default function handler(req, res){
  if(req.method !== "GET") return send(res, 405, { error: "method not allowed" });
  const e = process.env;

  const host = String(e.PEER_HOST || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const peerServer = /^[a-z0-9.-]+$/i.test(host) ? {
    host,
    port:   Number(e.PEER_PORT) || 443,
    path:   String(e.PEER_PATH || "/ryzebooth").startsWith("/") ? String(e.PEER_PATH || "/ryzebooth") : "/" + e.PEER_PATH,
    secure: String(e.PEER_SECURE || "true").toLowerCase() !== "false",
    key:    String(e.PEER_KEY || "peerjs")
  } : null;

  return send(res, 200, {
    name: String(e.APP_NAME || "").slice(0, 40),
    discordInviteUrl: httpUrl(e.DISCORD_INVITE_URL),
    githubUrl: httpUrl(e.GITHUB_URL),
    peerServer
  }, { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300" });
}
