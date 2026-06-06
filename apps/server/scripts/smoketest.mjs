// End-to-end smoke test:
//   1. register Alice
//   2. open a Socket.IO connection with the session cookie
//   3. send "/me waves at the room" and observe the broadcast
//   4. send "/char create Sigrid" and observe ui:hint
//   5. exit
import { io } from "../../web/node_modules/socket.io-client/build/esm/index.js";

const BASE = "http://127.0.0.1:3001";
const creds = {
  email: `alice+${Date.now()}@example.com`,
  username: `Alice${Math.floor(Math.random() * 1e6)}`,
  password: "hunter2hunter2",
};

console.log("registering", creds.username);
const r = await fetch(`${BASE}/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(creds),
});
if (!r.ok) {
  console.error("register failed", r.status, await r.text());
  process.exit(1);
}
const sessionCookie = r.headers.getSetCookie?.()[0] ?? r.headers.get("set-cookie") ?? "";
console.log("registered ok, cookie present:", !!sessionCookie);

const sock = io(BASE, {
  extraHeaders: { Cookie: sessionCookie.split(";")[0] },
  transports: ["websocket"],
});

const events = [];
sock.onAny((ev, ...payload) => events.push({ ev, payload }));

await new Promise((res, rej) => {
  sock.once("connect", res);
  sock.once("connect_error", (e) => rej(new Error(`connect_error: ${e.message}`)));
});
console.log("socket connected", sock.id);

await new Promise((res) => setTimeout(res, 500));

// Find the room id from the room:state event
const roomState = events.find((e) => e.ev === "room:state");
if (!roomState) {
  console.error("no room:state event received yet");
  console.error("events so far:", events.map((e) => e.ev));
  process.exit(2);
}
const roomId = roomState.payload[0].room.id;
const roomName = roomState.payload[0].room.name;
console.log("auto-joined room:", roomName, roomId);

// /me action
sock.emit("chat:input", { roomId, text: "/me waves at the room" }, (ack) => {
  console.log("ack /me:", ack);
});
await new Promise((res) => setTimeout(res, 400));

// /char create
sock.emit("chat:input", { roomId, text: "/char create Sigrid" }, (ack) => {
  console.log("ack /char create:", ack);
});
await new Promise((res) => setTimeout(res, 400));

// /char switch
sock.emit("chat:input", { roomId, text: "/char switch Sigrid" }, (ack) => {
  console.log("ack /char switch:", ack);
});
await new Promise((res) => setTimeout(res, 400));

// /me again, should now display as "Sigrid"
sock.emit("chat:input", { roomId, text: "/she draws a long sword from its scabbard" }, (ack) => {
  console.log("ack /she:", ack);
});
await new Promise((res) => setTimeout(res, 400));

// /profile self
sock.emit("chat:input", { roomId, text: "/profile" }, (ack) => {
  console.log("ack /profile:", ack);
});
await new Promise((res) => setTimeout(res, 400));

// Print summary of received events
console.log("\n=== events received ===");
for (const { ev, payload } of events) {
  if (ev === "message:new") {
    const m = payload[0];
    console.log(`message:new  kind=${m.kind}  ${m.displayName} :: ${m.body}`);
  } else if (ev === "message:bulk") {
    console.log(`message:bulk (${payload[0].length} backlog msgs)`);
  } else if (ev === "presence:update") {
    const occ = payload[0].occupants.map((o) => o.displayName).join(", ");
    console.log(`presence:update [${occ}]`);
  } else if (ev === "room:state") {
    console.log(`room:state ${payload[0].room.name} (${payload[0].occupants.length} occupants)`);
  } else if (ev === "ui:hint") {
    console.log(`ui:hint ${payload[0].kind}`);
  } else if (ev === "error:notice") {
    console.log(`error:notice [${payload[0].code}] ${payload[0].message.slice(0, 80)}`);
  } else {
    console.log(ev, JSON.stringify(payload).slice(0, 100));
  }
}

sock.close();
process.exit(0);
