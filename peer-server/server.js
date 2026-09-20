import { PeerServer } from "peer";

const allowed = (process.env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
if (!allowed.length) {
  console.error("Refusing to start: set ALLOWED_ORIGIN to your booth's URL.");
  process.exit(1);
}

const port = Number(process.env.PORT) || 9000;

PeerServer({
  port,
  path: "/ryzebooth",                
  key: process.env.PEER_KEY || "peerjs",
  proxied: true,                      
  allow_discovery: false,           
  concurrent_limit: 500,
  alive_timeout: 60000,
  corsOptions: { origin: allowed }
});

console.log(`RyzeBooth peer server listening on :${port}`);
