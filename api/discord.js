import { json, sameOrigin, clientIp, rateLimited } from "./_guard.js";

export const config = { runtime: "edge" };

const BOT_NAME = "ryze 📸";
const MESSAGE  = "Fresh from the booth ✨";
const MAX_BYTES = 8 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export default async function handler(req) {
  if (req.method !== "POST") {
    return json({ ok: false, error: "Use POST" }, 405);
  }
  if (!sameOrigin(req)) {
    return json({ ok: false, error: "Forbidden" }, 403);
  }
  if (rateLimited("discord:" + clientIp(req), 8, 60_000)) {
    return json({ ok: false, error: "Too many uploads — wait a minute" }, 429, { "retry-after": "60" });
  }

  const hook = process.env.DISCORD_WEBHOOK;
  if (!hook) {
    
    return json({ ok: false, error: "No webhook configured" }, 501);
  }

  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BYTES + 64 * 1024) {
    return json({ ok: false, error: "Image is too large" }, 413);
  }

  let file;
  try {
    const form = await req.formData();
    file = form.get("file");
  } catch {
    return json({ ok: false, error: "Could not read the upload" }, 400);
  }

  if (!file || typeof file === "string") {
    return json({ ok: false, error: "No image in the request" }, 400);
  }
  if (file.size > MAX_BYTES) {
    return json({ ok: false, error: "Image is too large" }, 413);
  }

  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (head.length < 8 || !PNG_MAGIC.every((b, i) => head[i] === b)) {
    return json({ ok: false, error: "Only PNG images are accepted" }, 415);
  }

  const out = new FormData();
  out.append("file", file, `strip-${Date.now()}.png`);
  out.append("payload_json", JSON.stringify({
    username: BOT_NAME,
    content: MESSAGE,
    allowed_mentions: { parse: [] }
  }));

  try {
    const res = await fetch(hook, { method: "POST", body: out });
    if (!res.ok) {
      return json({ ok: false, error: `Discord replied ${res.status}` }, 502);
    }
    return json({ ok: true });
  } catch {
    return json({ ok: false, error: "Could not reach Discord" }, 502);
  }
}
