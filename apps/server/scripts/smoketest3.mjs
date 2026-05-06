// Smoke test: /refresh, /refresh N, /refresh off, bad input.
import { io } from "../../web/node_modules/socket.io-client/build/esm/index.js";
const BASE = "http://127.0.0.1:3001";
const u = `Eve${Math.floor(Math.random() * 1e6)}`;
const r = await fetch(`${BASE}/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: `eve+${Date.now()}@example.com`, username: u, password: "hunter2hunter2" }),
});
if (!r.ok) { console.error(r.status, await r.text()); process.exit(1); }
const cookie = (r.headers.getSetCookie?.()[0] ?? r.headers.get("set-cookie") ?? "").split(";")[0];
const sock = io(BASE, { extraHeaders: { Cookie: cookie }, transports: ["websocket"] });
const events = [];
sock.onAny((ev, ...payload) => events.push({ ev, payload }));
await new Promise((res, rej) => {
  sock.once("connect", res);
  sock.once("connect_error", (e) => rej(e));
});
await new Promise((res) => setTimeout(res, 300));
const roomId = events.find((e) => e.ev === "room:state").payload[0].room.id;
const send = (text) => new Promise((res) => sock.emit("chat:input", { roomId, text }, res));
console.log("--- /refresh");
console.log(await send("/refresh"));
console.log("--- /refresh 30");
console.log(await send("/refresh 30"));
console.log("--- /refresh 2 (too low)");
console.log(await send("/refresh 2"));
console.log("--- /refresh banana (bad)");
console.log(await send("/refresh banana"));
console.log("--- /refresh off");
console.log(await send("/refresh off"));
console.log("--- /refresh 0 (== off)");
console.log(await send("/refresh 0"));
await new Promise((res) => setTimeout(res, 300));
console.log("\n=== events ===");
for (const { ev, payload } of events) {
  if (ev === "ui:hint") console.log(`ui:hint ${payload[0].kind} ${JSON.stringify(payload[0])}`);
  else if (ev === "error:notice") console.log(`notice [${payload[0].code}] ${payload[0].message}`);
  else if (ev === "room:state") console.log(`room:state ${payload[0].room.name}`);
  else if (ev === "presence:update") console.log(`presence:update (${payload[0].occupants.length} occ)`);
  else if (ev === "message:bulk") console.log(`message:bulk (${payload[0].length})`);
}
sock.close();
process.exit(0);
