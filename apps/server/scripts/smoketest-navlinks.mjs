// Smokes the nav-links endpoints.
//   - public GET /nav-links works without auth
//   - admin POST/PATCH/DELETE require admin
//   - Exit always present in client (not tested here)
//
// Logs in as a brand-new admin we promote inline (or any existing admin if you
// pass --user / --pass).

const BASE = "http://127.0.0.1:3001";
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a) => {
    const m = /^--([^=]+)=?(.*)$/.exec(a);
    return m ? [[m[1], m[2] || true]] : [];
  }),
);

const username = args.user ?? `Admin${Math.floor(Math.random() * 1e6)}`;
const password = args.pass ?? "hunter2hunter2";

console.log("logging in as", username);
let cookie;
{
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: username, password }),
  });
  if (r.ok) {
    cookie = (r.headers.getSetCookie?.()[0] ?? r.headers.get("set-cookie") ?? "").split(";")[0];
    console.log("logged in");
  } else {
    console.log("login failed, registering");
    const reg = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `${username.toLowerCase()}@test.local`, username, password }),
    });
    if (!reg.ok) {
      console.error("register failed:", reg.status, await reg.text());
      process.exit(1);
    }
    cookie = (reg.headers.getSetCookie?.()[0] ?? reg.headers.get("set-cookie") ?? "").split(";")[0];
    console.log("registered. NOTE: not yet admin — promote with scripts/promote-admin.mjs");
    if (!args.skipAdminCheck) process.exit(0);
  }
}

const headers = { "Content-Type": "application/json", Cookie: cookie };

console.log("\n--- public GET /nav-links ---");
console.log(await (await fetch(`${BASE}/nav-links`)).text());

console.log("\n--- POST /admin/nav-links (Rules) ---");
const r1 = await fetch(`${BASE}/admin/nav-links`, {
  method: "POST",
  headers,
  body: JSON.stringify({ label: "Rules", href: "/rules", position: 10, target: "_self" }),
});
console.log(r1.status, await r1.text());

console.log("\n--- POST /admin/nav-links (Discord) ---");
const r2 = await fetch(`${BASE}/admin/nav-links`, {
  method: "POST",
  headers,
  body: JSON.stringify({ label: "Discord", href: "https://discord.gg/example", position: 20 }),
});
console.log(r2.status, await r2.text());
const id2 = (await (await fetch(`${BASE}/admin/nav-links`, { headers: { Cookie: cookie } })).json()).links.find(
  (l) => l.label === "Discord",
)?.id;

console.log("\n--- POST bad URL ---");
const rb = await fetch(`${BASE}/admin/nav-links`, {
  method: "POST",
  headers,
  body: JSON.stringify({ label: "Bad", href: "javascript:alert(1)" }),
});
console.log(rb.status, await rb.text());

console.log("\n--- PATCH disable Discord ---");
const rp = await fetch(`${BASE}/admin/nav-links/${id2}`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ enabled: false }),
});
console.log(rp.status, await rp.text());

console.log("\n--- public GET /nav-links (Discord should be hidden) ---");
console.log(await (await fetch(`${BASE}/nav-links`)).text());

console.log("\n--- admin GET /admin/nav-links (still shows Discord) ---");
console.log(await (await fetch(`${BASE}/admin/nav-links`, { headers: { Cookie: cookie } })).text());

console.log("\n--- DELETE Discord ---");
const rd = await fetch(`${BASE}/admin/nav-links/${id2}`, { method: "DELETE", headers: { Cookie: cookie } });
console.log(rd.status, await rd.text());

process.exit(0);
