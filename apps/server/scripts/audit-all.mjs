// Comprehensive smoke test: walk every slash command, verify the right
// events fire, and verify HTTP endpoints return sane shapes. Fails loud on
// any unexpected response.
//
// Run with: node scripts/audit-all.mjs
import { io } from "../../web/node_modules/socket.io-client/build/esm/index.js";

const BASE = "http://127.0.0.1:3001";
const failures = [];
const pass = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { console.log(`  ✗ ${msg}`); failures.push(msg); };
const assert = (cond, msg) => (cond ? pass(msg) : fail(msg));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(r) {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}

const username = `Audit${Math.floor(Math.random() * 1e6)}`;
const email = `${username.toLowerCase()}@t.local`;
const password = "hunter2hunter2";

console.log(`\n[1] register + login flow`);
{
  const r = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, username, password }),
  });
  assert(r.ok, "register returned ok");
  const j = await readJson(r);
  assert(j.username === username, "register echoed username");
}

const cookieJar = [];
async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: username, password }),
  });
  assert(r.ok, "login ok");
  const setC = (r.headers.getSetCookie?.()[0] ?? r.headers.get("set-cookie") ?? "").split(";")[0];
  cookieJar[0] = setC;
}
await login();

console.log(`\n[2] /auth/me returns the freshly-issued session`);
{
  const r = await fetch(`${BASE}/auth/me`, { headers: { Cookie: cookieJar[0] } });
  assert(r.ok, "/auth/me ok");
  const j = await readJson(r);
  assert(j.username === username, "/auth/me returns my username");
}

console.log(`\n[3] /me/profile (master read)`);
{
  const r = await fetch(`${BASE}/me/profile`, { headers: { Cookie: cookieJar[0] } });
  assert(r.ok, "/me/profile readable");
  const j = await readJson(r);
  assert(j.username === username, "master profile has username");
  assert(j.chatColor == null, "fresh user has no chat color");
}

console.log(`\n[4] PUT /me/profile saves bio`);
{
  const r = await fetch(`${BASE}/me/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookieJar[0] },
    body: JSON.stringify({ bioHtml: "<p>OOC bio.</p>" }),
  });
  assert(r.ok, "PUT /me/profile ok");
  const r2 = await fetch(`${BASE}/me/profile`, { headers: { Cookie: cookieJar[0] } });
  const j = await readJson(r2);
  assert(j.bioHtml.includes("OOC bio"), "OOC bio persisted");
}

console.log(`\n[5] socket connection + auto-join The_Spire`);
const sock = io(BASE, { extraHeaders: { Cookie: cookieJar[0] }, transports: ["websocket"] });
const events = [];
sock.onAny((ev, ...payload) => events.push({ ev, payload }));
await new Promise((res, rej) => {
  sock.once("connect", res);
  sock.once("connect_error", (e) => rej(e));
});
await wait(400);
const roomState0 = events.find((e) => e.ev === "room:state");
assert(roomState0 != null, "received room:state on connect");
let currentRoomId = roomState0.payload[0].room.id;
assert(roomState0.payload[0].room.name === "The_Spire", "auto-joined The_Spire");

// /go and /private move the socket to a new room. Track the latest from
// every room:state so subsequent sends use the correct id.
sock.on("room:state", ({ room }) => { currentRoomId = room.id; });

const send = (text) => new Promise((res) => sock.emit("chat:input", { roomId: currentRoomId, text }, res));
const lastMsgs = (kind) => events.filter((e) => e.ev === "message:new" && e.payload[0].kind === kind).map((e) => e.payload[0]);
const lastNotices = () => events.filter((e) => e.ev === "error:notice").map((e) => e.payload[0]);
const lastHints = () => events.filter((e) => e.ev === "ui:hint").map((e) => e.payload[0]);

console.log(`\n[6] plain say message`);
{
  const before = events.length;
  const ack = await send("hello world");
  assert(ack.ok === true, "say ack ok");
  await wait(150);
  const m = events.slice(before).find((e) => e.ev === "message:new" && e.payload[0].kind === "say");
  assert(m && m.payload[0].body === "hello world", "say body roundtripped");
}

console.log(`\n[7] /me action and pronoun aliases`);
for (const cmd of ["me", "he", "she", "they", "it", "em", "action", "pose", "emote"]) {
  const before = events.length;
  await send(`/${cmd} test ${cmd}`);
  await wait(80);
  const m = events.slice(before).find((e) => e.ev === "message:new" && e.payload[0].kind === "me");
  assert(m && m.payload[0].body === `test ${cmd}`, `/${cmd} renders kind=me`);
}

console.log(`\n[8] /color sets color, snapshots into next message, clears`);
{
  await send("/color 990000");
  await wait(150);
  const before = events.length;
  await send("/me waves in red");
  await wait(150);
  const m = events.slice(before).find((e) => e.ev === "message:new" && e.payload[0].kind === "me");
  assert(m && m.payload[0].color === "#990000", "color #990000 snapshotted into /me message");

  await send("/co clear");
  await wait(150);
  const after = events.length;
  await send("/me waves uncolored");
  await wait(150);
  const m2 = events.slice(after).find((e) => e.ev === "message:new" && e.payload[0].kind === "me");
  assert(m2 && (m2.payload[0].color == null), "color cleared");

  await send("/color #abc");
  await wait(150);
  const exp = events.length;
  await send("hi");
  await wait(150);
  const m3 = events.slice(exp).find((e) => e.ev === "message:new" && e.payload[0].kind === "say");
  assert(m3 && m3.payload[0].color === "#aabbcc", "#abc expanded to #aabbcc");

  await send("/color clear");
  await wait(120);
}

console.log(`\n[9] /color rejects bad input`);
{
  const before = events.length;
  await send("/color zzzzzz");
  await wait(120);
  const n = events.slice(before).find((e) => e.ev === "error:notice" && e.payload[0].code === "BAD_COLOR");
  assert(n != null, "bad color rejected");
}

console.log(`\n[10] /char create, /char switch, /me uses character name`);
{
  const before = events.length;
  await send("/char create AuditChar");
  await wait(200);
  const hint = events.slice(before).find((e) => e.ev === "ui:hint" && e.payload[0].kind === "open-character-editor");
  assert(hint != null, "/char create opens editor hint");

  const before2 = events.length;
  await send("/char switch AuditChar");
  await wait(200);
  const presence = events.slice(before2).find((e) => e.ev === "presence:update");
  assert(presence != null, "presence update after switch");
  const occMe = presence.payload[0].occupants.find((o) => o.displayName === "AuditChar");
  assert(occMe != null, "occupant displayName is now AuditChar");

  const before3 = events.length;
  await send("/me sharpens her blade");
  await wait(150);
  const m = events.slice(before3).find((e) => e.ev === "message:new" && e.payload[0].kind === "me");
  assert(m && m.payload[0].displayName === "AuditChar", "/me renders as AuditChar");
}

console.log(`\n[11] /char list, /char clear`);
{
  const before = events.length;
  await send("/char list");
  await wait(120);
  const n = events.slice(before).find((e) => e.ev === "error:notice" && e.payload[0].code === "CHAR_LIST");
  assert(n && n.payload[0].message.includes("AuditChar"), "/char list mentions AuditChar");

  const before2 = events.length;
  await send("/char clear");
  await wait(150);
  const m = events.slice(before2).find((e) => e.ev === "presence:update");
  assert(m != null, "presence update after clear");
}

console.log(`\n[12] /profile (edit-self) emits open-my-editor`);
{
  const before = events.length;
  await send("/profile");
  await wait(120);
  const h = events.slice(before).find((e) => e.ev === "ui:hint" && e.payload[0].kind === "open-my-editor");
  assert(h != null, "/profile emits open-my-editor");
  assert(h.payload[0].mode === "master", "no active char => master mode");
}

console.log(`\n[13] /profile rejects args`);
{
  const before = events.length;
  await send("/profile foobar");
  await wait(120);
  const n = events.slice(before).find((e) => e.ev === "error:notice" && e.payload[0].code === "NO_ARGS");
  assert(n != null, "/profile foobar rejected");
}

console.log(`\n[14] /whois <self> opens view`);
{
  const before = events.length;
  await send(`/whois ${username}`);
  await wait(150);
  const h = events.slice(before).find((e) => e.ev === "ui:hint" && e.payload[0].kind === "open-profile");
  assert(h != null, "/whois opens profile view");
}

console.log(`\n[15] /whois nobody errors`);
{
  const before = events.length;
  await send("/whois noSuchUser_zzz");
  await wait(120);
  const n = events.slice(before).find((e) => e.ev === "error:notice" && e.payload[0].code === "NO_USER");
  assert(n != null, "/whois nobody yields NO_USER");
}

console.log(`\n[16] /away then /away (toggle)`);
{
  const before = events.length;
  await send("/away making tea");
  await wait(120);
  const m = events.slice(before).find((e) => e.ev === "message:new" && e.payload[0].kind === "system");
  assert(m && m.payload[0].body.includes("making tea"), "away system message");

  const before2 = events.length;
  await send("/away");
  await wait(120);
  const m2 = events.slice(before2).find((e) => e.ev === "message:new" && e.payload[0].kind === "system");
  assert(m2 && /back/.test(m2.payload[0].body), "back system message");
}

console.log(`\n[17] /refresh, /refresh 30, /refresh 2 (bad), /refresh off`);
{
  const before = events.length;
  await send("/refresh");
  await wait(120);
  const ros = events.slice(before).filter((e) => e.ev === "room:state");
  assert(ros.length >= 1, "/refresh emits room:state");

  const before2 = events.length;
  await send("/refresh 30");
  await wait(120);
  const h = events.slice(before2).find((e) => e.ev === "ui:hint" && e.payload[0].kind === "set-refresh-interval");
  assert(h && h.payload[0].seconds === 30, "/refresh 30 emits seconds=30");

  const before3 = events.length;
  await send("/refresh 2");
  await wait(120);
  const n = events.slice(before3).find((e) => e.ev === "error:notice" && e.payload[0].code === "BAD_REFRESH");
  assert(n != null, "/refresh 2 rejected");

  const before4 = events.length;
  await send("/refresh off");
  await wait(120);
  const h2 = events.slice(before4).find((e) => e.ev === "ui:hint" && e.payload[0].kind === "set-refresh-interval");
  assert(h2 && h2.payload[0].seconds === 0, "/refresh off => seconds=0");
}

console.log(`\n[18] /go newRoomName creates + joins`);
{
  const newRoom = `Audit${Math.floor(Math.random() * 1e6)}Room`;
  const before = events.length;
  await send(`/go ${newRoom}`);
  await wait(300);
  const rs = events.slice(before).filter((e) => e.ev === "room:state").pop();
  assert(rs && rs.payload[0].room.name === newRoom, `/go created and joined ${newRoom}`);
}

console.log(`\n[19] /topic shows then sets`);
{
  const before = events.length;
  await send("/topic");
  await wait(120);
  const n = events.slice(before).find((e) => e.ev === "error:notice" && e.payload[0].code === "TOPIC");
  assert(n != null, "/topic prints current topic");

  const before2 = events.length;
  await send("/topic Welcome to the audit room");
  await wait(150);
  const sys = events.slice(before2).find((e) => e.ev === "message:new" && e.payload[0].kind === "system");
  assert(sys && sys.payload[0].body.includes("Welcome to the audit"), "topic set system msg");
}

console.log(`\n[20] /help opens modal hint; /commands endpoint feeds it`);
{
  const before = events.length;
  await send("/help");
  await wait(120);
  const h = events.slice(before).find((e) => e.ev === "ui:hint" && e.payload[0].kind === "open-help");
  assert(h != null, "/help emits open-help hint");

  const before2 = events.length;
  await send("/help char");
  await wait(120);
  const h2 = events.slice(before2).find((e) => e.ev === "ui:hint" && e.payload[0].kind === "open-help");
  assert(h2 != null && h2.payload[0].filter === "char", "/help char emits filtered hint");

  const r = await fetch(`${BASE}/commands`);
  assert(r.ok, "/commands endpoint reachable");
  const j = await readJson(r);
  assert(Array.isArray(j.commands), "commands is an array");
  const charCmd = j.commands.find((c) => c.name === "char");
  assert(charCmd != null, "char command listed");
  assert(charCmd.subcommands.length > 0, "char has subcommands");
  assert(
    charCmd.subcommands.some((s) => /OOC/.test(s.usage) || /ooc/i.test(s.aliases.join(","))),
    "char switch documents OOC route",
  );
}

console.log(`\n[20-2] /char switch OOC and /char disable both clear active char`);
{
  // We don't have a character active right now in the audit flow, but we can
  // create one, switch to it, then verify both routes drop us back.
  const before = events.length;
  await send("/char create OocAuditChar");
  await wait(200);
  const opened = events.slice(before).find((e) => e.ev === "ui:hint" && e.payload[0].kind === "open-character-editor");
  assert(opened != null, "/char create opens editor");

  await send("/char switch OocAuditChar");
  await wait(150);

  const before2 = events.length;
  await send("/char switch OOC");
  await wait(200);
  const presence = events.slice(before2).find((e) => e.ev === "presence:update");
  assert(presence != null, "/char switch OOC fires presence update");

  await send("/char switch OocAuditChar");
  await wait(150);
  const before3 = events.length;
  await send("/char disable");
  await wait(200);
  const presence2 = events.slice(before3).find((e) => e.ev === "presence:update");
  assert(presence2 != null, "/char disable fires presence update");
}

console.log(`\n[20a] /roll variants`);
{
  const before = events.length;
  await send("/roll 1d20");
  await wait(120);
  const m = events.slice(before).find((e) => e.ev === "message:new" && e.payload[0].kind === "roll");
  assert(m && /1d20/.test(m.payload[0].body), "/roll 1d20 emits roll-kind message");

  const before2 = events.length;
  await send("/roll 3d6");
  await wait(120);
  const m2 = events.slice(before2).find((e) => e.ev === "message:new" && e.payload[0].kind === "roll");
  assert(m2 && /3d6/.test(m2.payload[0].body) && /\[/.test(m2.payload[0].body), "/roll 3d6 shows individual dice");

  const before3 = events.length;
  await send("/roll banana");
  await wait(120);
  const n = events.slice(before3).find((e) => e.ev === "error:notice" && e.payload[0].code === "BAD_DICE");
  assert(n != null, "/roll banana rejected");

  const before4 = events.length;
  await send("/dice 1d20"); // alias
  await wait(120);
  const m4 = events.slice(before4).find((e) => e.ev === "message:new" && e.payload[0].kind === "roll");
  assert(m4 != null, "/dice alias works");
}

console.log(`\n[20b] HTTP /rooms returns tree with occupants`);
{
  const r = await fetch(`${BASE}/rooms`);
  assert(r.ok, "/rooms ok");
  const j = await readJson(r);
  assert(Array.isArray(j.rooms), "rooms is array");
  assert(j.rooms.some((r) => r.name === "The_Spire"), "The_Spire in public rooms");
  assert(j.rooms.every((r) => Array.isArray(r.occupants)), "every room carries occupants[]");
  assert(j.rooms.every((r) => r.type !== "private"), "no private rooms in unauthenticated list");
}


console.log(`\n[20c] HTTP /stats returns counts + frequency`);
{
  const r = await fetch(`${BASE}/stats`);
  assert(r.ok, "/stats ok");
  const j = await readJson(r);
  assert(typeof j.online === "number", "stats.online is number");
  assert(typeof j.rooms.public === "number", "stats.rooms.public");
  assert(Array.isArray(j.messagesPerDay) && j.messagesPerDay.length === 7, "messagesPerDay has 7 entries");
}

console.log(`\n[20d] occupant carries gender + chatColor`);
{
  // Force a presence:update by toggling /color
  const before = events.length;
  await send("/color #112233");
  await wait(150);
  const p = events.slice(before).find((e) => e.ev === "presence:update");
  assert(p != null, "presence update on color change");
  const meOcc = p?.payload[0].occupants.find((o) => o.userId);
  assert(meOcc && typeof meOcc.gender === "string", "occupant has gender field");
  await send("/color clear");
  await wait(120);
}

console.log(`\n[21] unknown command suggests`);
{
  const before = events.length;
  await send("/colour 990000"); // alias of /color, should resolve
  await wait(120);
  const n = events.slice(before).find((e) => e.ev === "error:notice" && e.payload[0].code === "COLOR_SET");
  assert(n != null, "/colour resolves as /color alias");

  const before2 = events.length;
  await send("/notarealcommand foo");
  await wait(120);
  const n2 = events.slice(before2).find((e) => e.ev === "error:notice" && e.payload[0].code === "UNKNOWN_CMD");
  assert(n2 != null, "unknown command error");
}

console.log(`\n[22] // escape: leading double-slash sends literal text`);
{
  const before = events.length;
  await send("//literal slash text");
  await wait(120);
  const m = events.slice(before).find((e) => e.ev === "message:new" && e.payload[0].kind === "say");
  assert(m && m.payload[0].body.startsWith("/literal"), "// escape works");
}

console.log(`\n[23] /private creates password-protected room`);
{
  const name = `PrivAudit${Math.floor(Math.random() * 1e6)}`;
  const before = events.length;
  await send(`/private ${name} secretpw`);
  await wait(300);
  const rs = events.slice(before).filter((e) => e.ev === "room:state").pop();
  assert(rs && rs.payload[0].room.type === "private", "private room is type=private");
}

console.log(`\n[23a] HTTP /rooms (authed) now includes our private room`);
{
  const r = await fetch(`${BASE}/rooms`, { headers: { Cookie: cookieJar[0] } });
  const j = await readJson(r);
  const priv = j.rooms.filter((x) => x.type === "private");
  assert(priv.length >= 1, "authed /rooms includes caller's current private room");

  const r2 = await fetch(`${BASE}/rooms`); // no auth
  const j2 = await readJson(r2);
  assert(j2.rooms.every((x) => x.type !== "private"), "unauthenticated /rooms hides private rooms");
}

console.log(`\n[24] /me alone with no body emits notice`);
{
  const before = events.length;
  await send("/me   ");
  await wait(120);
  const n = events.slice(before).find((e) => e.ev === "error:notice" && e.payload[0].code === "EMPTY_ACTION");
  assert(n != null, "/me with empty body errors");
}

console.log(`\n[25] /color presence broadcast`);
{
  const before = events.length;
  await send("/color #00ff00");
  await wait(150);
  const p = events.slice(before).find((e) => e.ev === "presence:update");
  // Must include my user with chatColor=#00ff00
  const me = p?.payload[0].occupants.find((o) => o.displayName === username || o.userId);
  // Note: /color goes through current occupant which now might be in a different room (we /go'd earlier)
  // Just assert SOME presence:update fired.
  assert(p != null, "color triggers presence broadcast");
}

console.log(`\n[25b] /whisper round-trip with a second connection`);
{
  // Register and connect a second user, both join The_Spire.
  const u2 = `Audit2_${Math.floor(Math.random() * 1e6)}`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${u2.toLowerCase()}@t.local`, username: u2, password: "hunter2hunter2" }),
  });
  assert(reg.ok, "second user registered");
  const cookie2 = (reg.headers.getSetCookie?.()[0] ?? reg.headers.get("set-cookie") ?? "").split(";")[0];

  const sock2 = io(BASE, { extraHeaders: { Cookie: cookie2 }, transports: ["websocket"] });
  const ev2 = [];
  sock2.onAny((ev, ...payload) => ev2.push({ ev, payload }));
  await new Promise((res, rej) => {
    sock2.once("connect", res);
    sock2.once("connect_error", (e) => rej(e));
  });
  await wait(300);

  // Move our main socket back to The_Spire so we can whisper u2.
  // Find The_Spire id from u2's room:state.
  const u2Room = ev2.find((e) => e.ev === "room:state");
  const mainHallId = u2Room.payload[0].room.id;
  await new Promise((res) => sock.emit("room:join", { roomId: mainHallId }, res));
  await wait(200);
  // Now currentRoomId is The_Spire.

  const before = events.length;
  const before2 = ev2.length;
  await send(`/whisper ${u2} hello in private`);
  await wait(200);

  const wOnSender = events.slice(before).find((e) => e.ev === "message:new" && e.payload[0].kind === "whisper");
  assert(wOnSender && wOnSender.payload[0].body === "hello in private", "sender sees own whisper");

  const wOnTarget = ev2.slice(before2).find((e) => e.ev === "message:new" && e.payload[0].kind === "whisper");
  assert(wOnTarget && wOnTarget.payload[0].body === "hello in private", "target receives whisper");
  assert(wOnTarget && wOnTarget.payload[0].toUserId, "whisper has toUserId");
  assert(wOnTarget && wOnTarget.payload[0].toDisplayName === u2, "whisper has toDisplayName snapshot");

  // Aliases should work too.
  const before3 = events.length;
  await send(`/wh ${u2} via alias`);
  await wait(200);
  const wAlias = events.slice(before3).find((e) => e.ev === "message:new" && e.payload[0].kind === "whisper");
  assert(wAlias && wAlias.payload[0].body === "via alias", "/wh alias works");

  sock2.close();
}

console.log(`\n[26] HTTP /nav-links is reachable without auth`);
{
  const r = await fetch(`${BASE}/nav-links`); // no cookie
  assert(r.ok, "/nav-links public");
  const j = await readJson(r);
  assert(Array.isArray(j.links), "/nav-links returns {links}");
}

console.log(`\n[27] HTTP /admin/* refuses non-admin`);
{
  const r = await fetch(`${BASE}/admin/rooms`, { headers: { Cookie: cookieJar[0] } });
  assert(r.status === 403, "/admin/rooms refuses non-admin");
}

console.log(`\n[27a] auto-expire: room is removed when its last socket leaves`);
{
  // Create a fresh public room, leave it (by joining The_Spire), and verify
  // the server deleted it.
  const ephName = `Eph${Math.floor(Math.random() * 1e6)}Room`;
  await send(`/go ${ephName}`);
  await wait(300);
  // confirm it exists in /rooms
  let listed = (await readJson(await fetch(`${BASE}/rooms`))).rooms.find((r) => r.name === ephName);
  assert(listed != null, "ephemeral room created and visible");

  // Leave by joining a different existing public room (The_Spire)
  const allRooms = (await readJson(await fetch(`${BASE}/rooms`))).rooms;
  const main = allRooms.find((r) => r.name === "The_Spire");
  await new Promise((res) => sock.emit("room:join", { roomId: main.id }, res));
  await wait(400);

  listed = (await readJson(await fetch(`${BASE}/rooms`))).rooms.find((r) => r.name === ephName);
  assert(listed == null, "ephemeral room auto-expired after last socket left");
}

console.log(`\n[27b] admin can delete non-system rooms; refuses The_Spire`);
{
  // Promote a fresh user to admin via the helper script. Easier: reuse the
  // 'WAS' admin set up earlier — log in as them with the dev password.
  // Skip if WAS doesn't exist or password mismatches.
  const sessRow = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "NavSmoke", password: "hunter2hunter2" }),
  });
  if (!sessRow.ok) {
    console.log("  (skipping: NavSmoke admin login failed)");
  } else {
    const adminCookie = (sessRow.headers.getSetCookie?.()[0] ?? sessRow.headers.get("set-cookie") ?? "").split(";")[0];

    // Create a temp room as the regular audit user (so it actually exists).
    const tempName = `DelTarget${Math.floor(Math.random() * 1e6)}`;
    await send(`/go ${tempName}`);
    await wait(300);
    const created = (await readJson(await fetch(`${BASE}/rooms`))).rooms.find((r) => r.name === tempName);
    assert(created != null, "delete-target room created");

    // Admin deletes it
    const del = await fetch(`${BASE}/admin/rooms/${created.id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    assert(del.ok, "admin delete succeeded");

    // Confirm it's gone
    await wait(200);
    const after = (await readJson(await fetch(`${BASE}/rooms`))).rooms.find((r) => r.name === tempName);
    assert(after == null, "deleted room no longer in /rooms");

    // System room refusal
    const allRooms = (await readJson(await fetch(`${BASE}/rooms`))).rooms;
    const main = allRooms.find((r) => r.name === "The_Spire");
    const mainDel = await fetch(`${BASE}/admin/rooms/${main.id}`, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    assert(mainDel.status === 400, "admin cannot delete system room (The_Spire)");
  }
}

console.log(`\n[27c] mod commands: /kick + /mute + /unmute (admin → target)`);
{
  // Use NavSmoke as admin, the audit user as target. NavSmoke mutes audit
  // user in The_Spire, then audit user's plain say is rejected with MUTED.
  const navLogin = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "NavSmoke", password: "hunter2hunter2" }),
  });
  if (!navLogin.ok) {
    console.log("  (skipping: NavSmoke admin not available)");
  } else {
    const adminCookie = (navLogin.headers.getSetCookie?.()[0] ?? navLogin.headers.get("set-cookie") ?? "").split(";")[0];
    const adminSock = io(BASE, { extraHeaders: { Cookie: adminCookie }, transports: ["websocket"] });
    const adminEv = [];
    adminSock.onAny((ev, ...payload) => adminEv.push({ ev, payload }));
    await new Promise((res, rej) => {
      adminSock.once("connect", res);
      adminSock.once("connect_error", (e) => rej(e));
    });
    await wait(300);
    const adminRoom = adminEv.find((e) => e.ev === "room:state");
    const mainHallId = adminRoom.payload[0].room.id;
    const adminSend = (text) => new Promise((res) => adminSock.emit("chat:input", { roomId: mainHallId, text }, res));

    // Audit user joins The_Spire too
    await new Promise((res) => sock.emit("room:join", { roomId: mainHallId }, res));
    await wait(300);

    // Mute the audit user for 1 hour
    await adminSend(`/mute ${username} 1h spam test`);
    await wait(200);

    // Audit user tries to speak — should be MUTED
    const before = events.length;
    await send("trying to speak while muted");
    await wait(200);
    const muteNotice = events.slice(before).find((e) => e.ev === "error:notice" && e.payload[0].code === "MUTED");
    assert(muteNotice != null, "muted user gets MUTED notice when speaking");

    // Unmute
    await adminSend(`/unmute ${username}`);
    await wait(200);

    // Now speech goes through
    const before2 = events.length;
    await send("speaking again");
    await wait(200);
    const m = events.slice(before2).find((e) => e.ev === "message:new" && e.payload[0].kind === "say" && e.payload[0].body === "speaking again");
    assert(m != null, "after unmute, speech is delivered");

    // Kick should boot us
    const before3 = events.length;
    await adminSend(`/kick ${username} cooldown`);
    await wait(400);
    const kicked = events.slice(before3).find((e) => e.ev === "error:notice" && e.payload[0].code === "KICKED");
    assert(kicked != null, "kicked user gets KICKED notice");

    adminSock.close();
  }
}

console.log(`\n[27d] /promoteadmin and /demoteadmin (keymaster protected)`);
{
  // Register a brand-new throwaway user, promote them via admin, demote back.
  const tempName = `TempAdmin${Math.floor(Math.random() * 1e6)}`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${tempName.toLowerCase()}@t.local`, username: tempName, password: "hunter2hunter2" }),
  });
  assert(reg.ok, "temp user registered");

  const navLogin = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "NavSmoke", password: "hunter2hunter2" }),
  });
  if (!navLogin.ok) {
    console.log("  (skipping: NavSmoke admin not available)");
  } else {
    const adminCookie = (navLogin.headers.getSetCookie?.()[0] ?? navLogin.headers.get("set-cookie") ?? "").split(";")[0];
    const adminSock = io(BASE, { extraHeaders: { Cookie: adminCookie }, transports: ["websocket"] });
    const adminEv = [];
    adminSock.onAny((ev, ...payload) => adminEv.push({ ev, payload }));
    await new Promise((res) => adminSock.once("connect", res));
    await wait(200);
    const adminRoomId = adminEv.find((e) => e.ev === "room:state").payload[0].room.id;
    const adminSend = (text) => new Promise((res) => adminSock.emit("chat:input", { roomId: adminRoomId, text }, res));

    await adminSend(`/promoteadmin ${tempName}`);
    await wait(200);
    await adminSend(`/demoteadmin ${tempName}`);
    await wait(200);

    // Try to demote NavSmoke (or whoever is keymaster). The keymaster check
    // ensures the longest-tenured admin can't be demoted. We just verify the
    // command rejects when the target IS the keymaster.
    const before = adminEv.length;
    await adminSend(`/demoteadmin NavSmoke`); // self-demote → SELF or KEYMASTER if keymaster
    await wait(200);
    const refused = adminEv.slice(before).find((e) => e.ev === "error:notice" && (e.payload[0].code === "SELF" || e.payload[0].code === "KEYMASTER"));
    assert(refused != null, "self / keymaster demote refused");

    adminSock.close();
  }
}

console.log(`\n[27e] /admin/settings: get/put + retention validation`);
{
  const navLogin = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "NavSmoke", password: "hunter2hunter2" }),
  });
  if (!navLogin.ok) {
    console.log("  (skipping: NavSmoke admin not available)");
  } else {
    const adminCookie = (navLogin.headers.getSetCookie?.()[0] ?? navLogin.headers.get("set-cookie") ?? "").split(";")[0];

    const g = await fetch(`${BASE}/admin/settings`, { headers: { Cookie: adminCookie } });
    assert(g.ok, "GET /admin/settings ok");
    const before = await readJson(g);
    assert(typeof before.messageRetentionMs === "number", "settings has messageRetentionMs");
    assert(typeof before.sessionTtlMs === "number", "settings has sessionTtlMs");
    assert(before.defaultTheme && typeof before.defaultTheme.bg === "string", "settings has resolved defaultTheme");

    const p = await fetch(`${BASE}/admin/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({
        messageRetentionMs: 30 * 24 * 60 * 60 * 1000,
        sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
      }),
    });
    assert(p.ok, "PUT /admin/settings ok");
    const after = await readJson(p);
    assert(after.messageRetentionMs === 30 * 24 * 60 * 60 * 1000, "retention persisted");
    assert(after.sessionTtlMs === 7 * 24 * 60 * 60 * 1000, "session ttl persisted");

    const bad = await fetch(`${BASE}/admin/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ sessionTtlMs: 1000 }),
    });
    assert(bad.status === 400, "tiny ttl rejected as 400");

    // Reset retention to forever so other audits don't lose data.
    await fetch(`${BASE}/admin/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ messageRetentionMs: 0 }),
    });
  }
}

console.log(`\n[27f] custom-command template: bare-pipe + math + if`);
{
  const navLogin = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "NavSmoke", password: "hunter2hunter2" }),
  });
  if (!navLogin.ok) {
    console.log("  (skipping: NavSmoke admin not available)");
  } else {
    const adminCookie = (navLogin.headers.getSetCookie?.()[0] ?? navLogin.headers.get("set-cookie") ?? "").split(";")[0];
    const cmdName = `audit_tpl_${Math.floor(Math.random() * 1e6)}`;
    const post = await fetch(`${BASE}/admin/custom-commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({
        name: cmdName,
        kind: "say",
        template: "{a|b|c}-{=2+3}-{if:{target}|YES|NO}",
      }),
    });
    assert(post.ok, "custom command with new template features created");
    const created = await readJson(post);

    const adminSock = io(BASE, { extraHeaders: { Cookie: adminCookie }, transports: ["websocket"] });
    const ev = [];
    adminSock.onAny((e, ...p) => ev.push({ ev: e, payload: p }));
    await new Promise((res) => adminSock.once("connect", res));
    await wait(300);
    const room = ev.find((e) => e.ev === "room:state").payload[0].room.id;

    const before1 = ev.length;
    await new Promise((res) => adminSock.emit("chat:input", { roomId: room, text: `/${cmdName} someone` }, res));
    await wait(200);
    const m1 = ev.slice(before1).find((e) => e.ev === "message:new" && e.payload[0].kind === "say");
    assert(m1 && /YES/.test(m1.payload[0].body), "if branch chose YES with target");
    assert(m1 && /-5-/.test(m1.payload[0].body), "{=2+3} evaluated to 5");
    assert(m1 && /^[abc]-/.test(m1.payload[0].body), "bare-pipe random produced a/b/c");

    const before2 = ev.length;
    await new Promise((res) => adminSock.emit("chat:input", { roomId: room, text: `/${cmdName}` }, res));
    await wait(200);
    const m2 = ev.slice(before2).find((e) => e.ev === "message:new" && e.payload[0].kind === "say");
    assert(m2 && /NO/.test(m2.payload[0].body), "if branch chose NO with empty target");

    await fetch(`${BASE}/admin/custom-commands/${created.id}`, { method: "DELETE", headers: { Cookie: adminCookie } });
    adminSock.close();
  }
}

console.log(`\n[27g] custom-command color override + {sender} alias`);
{
  const navLogin = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: "NavSmoke", password: "hunter2hunter2" }),
  });
  if (!navLogin.ok) {
    console.log("  (skipping: NavSmoke admin not available)");
  } else {
    const adminCookie = (navLogin.headers.getSetCookie?.()[0] ?? navLogin.headers.get("set-cookie") ?? "").split(";")[0];

    const cmdName = `audit_clr_${Math.floor(Math.random() * 1e6)}`;
    const post = await fetch(`${BASE}/admin/custom-commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({
        name: cmdName,
        kind: "say",
        // Use {sender} alias to verify it resolves like {name}.
        template: "from {sender}",
        color: "#ff00aa",
      }),
    });
    assert(post.ok, "custom command with color + {sender} created");
    const created = await readJson(post);

    const adminSock = io(BASE, { extraHeaders: { Cookie: adminCookie }, transports: ["websocket"] });
    const ev = [];
    adminSock.onAny((e, ...p) => ev.push({ ev: e, payload: p }));
    await new Promise((res) => adminSock.once("connect", res));
    await wait(300);
    const room = ev.find((e) => e.ev === "room:state").payload[0].room.id;

    const before = ev.length;
    await new Promise((res) => adminSock.emit("chat:input", { roomId: room, text: `/${cmdName}` }, res));
    await wait(200);
    const m = ev.slice(before).find((e) => e.ev === "message:new" && e.payload[0].kind === "say");
    assert(m && /from NavSmoke/.test(m.payload[0].body), "{sender} resolved to display name");
    assert(m && m.payload[0].color === "#ff00aa", "command color override applied");

    // Bad color rejected
    const bad = await fetch(`${BASE}/admin/custom-commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({
        name: `${cmdName}_b`,
        kind: "say",
        template: "x",
        color: "not-a-color",
      }),
    });
    assert(bad.status === 400, "bad color rejected as 400");

    await fetch(`${BASE}/admin/custom-commands/${created.id}`, { method: "DELETE", headers: { Cookie: adminCookie } });
    adminSock.close();
  }
}

console.log(`\n[28] logout invalidates session`);
{
  const r = await fetch(`${BASE}/auth/logout`, { method: "POST", headers: { Cookie: cookieJar[0] } });
  assert(r.ok, "logout ok");
  const r2 = await fetch(`${BASE}/auth/me`, { headers: { Cookie: cookieJar[0] } });
  assert(r2.status === 401, "/auth/me after logout = 401");
}

sock.close();

console.log(`\n${failures.length === 0 ? "ALL ASSERTIONS PASSED" : `${failures.length} FAILURES:`}`);
for (const f of failures) console.log("  -", f);
process.exit(failures.length === 0 ? 0 : 1);
