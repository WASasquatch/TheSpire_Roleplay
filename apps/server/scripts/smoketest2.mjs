// Phase-2 smoke test: verifies /color, /whois, /profile (edit-self),
// /away, /refresh, and that messages carry a `color` field.
import { io } from "../../web/node_modules/socket.io-client/build/esm/index.js";

const BASE = "http://127.0.0.1:3001";
const u = `Bob${Math.floor(Math.random() * 1e6)}`;

console.log("registering", u);
const r = await fetch(`${BASE}/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: `bob+${Date.now()}@example.com`,
    username: u,
    password: "hunter2hunter2",
  }),
});
if (!r.ok) {
  console.error("register failed", r.status, await r.text());
  process.exit(1);
}
const cookie = (r.headers.getSetCookie?.()[0] ?? r.headers.get("set-cookie") ?? "").split(";")[0];

const sock = io(BASE, { extraHeaders: { Cookie: cookie }, transports: ["websocket"] });
const events = [];
sock.onAny((ev, ...payload) => events.push({ ev, payload }));

await new Promise((res, rej) => {
  sock.once("connect", res);
  sock.once("connect_error", (e) => rej(new Error(`connect_error: ${e.message}`)));
});
await new Promise((res) => setTimeout(res, 400));

const roomState = events.find((e) => e.ev === "room:state");
const roomId = roomState.payload[0].room.id;
const send = (text) =>
  new Promise((res) => sock.emit("chat:input", { roomId, text }, (ack) => res(ack)));

console.log("\n--- /color 990000 ---");
console.log(await send("/color 990000"));
await new Promise((res) => setTimeout(res, 300));

console.log("\n--- /me waves ---");
console.log(await send("/me waves"));
await new Promise((res) => setTimeout(res, 300));

console.log("\n--- plain say ---");
console.log(await send("hello in red"));
await new Promise((res) => setTimeout(res, 300));

console.log("\n--- /co clear ---");
console.log(await send("/co clear"));
await new Promise((res) => setTimeout(res, 300));

console.log("\n--- /me waves again ---");
console.log(await send("/me waves again"));
await new Promise((res) => setTimeout(res, 300));

console.log("\n--- /profile (edit me) ---");
console.log(await send("/profile"));
await new Promise((res) => setTimeout(res, 300));

console.log("\n--- /whois <self> ---");
console.log(await send(`/whois ${u}`));
await new Promise((res) => setTimeout(res, 300));

console.log("\n--- /away brewing tea ---");
console.log(await send("/away brewing tea"));
await new Promise((res) => setTimeout(res, 300));

console.log("\n--- /away (toggle off) ---");
console.log(await send("/away"));
await new Promise((res) => setTimeout(res, 300));

console.log("\n--- /refresh ---");
console.log(await send("/refresh"));
await new Promise((res) => setTimeout(res, 300));

console.log("\n=== events ===");
for (const { ev, payload } of events) {
  if (ev === "message:new") {
    const m = payload[0];
    console.log(
      `message:new  kind=${m.kind}  color=${m.color ?? "-"}  ${m.displayName} :: ${m.body}`,
    );
  } else if (ev === "presence:update") {
    const o = payload[0].occupants[0];
    console.log(
      `presence:update  ${o?.displayName} away=${o?.away}  color=${o?.chatColor ?? "-"}  awayMsg=${o?.awayMessage ?? "-"}`,
    );
  } else if (ev === "ui:hint") {
    console.log(`ui:hint  ${payload[0].kind}  ${JSON.stringify(payload[0]).slice(0, 80)}`);
  } else if (ev === "error:notice") {
    console.log(`error:notice  [${payload[0].code}]  ${payload[0].message.slice(0, 80)}`);
  } else if (ev === "room:state") {
    console.log(`room:state  ${payload[0].room.name}`);
  } else if (ev === "message:bulk") {
    console.log(`message:bulk  (${payload[0].length})`);
  }
}

sock.close();
process.exit(0);
