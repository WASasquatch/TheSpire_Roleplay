import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

/**
 * Characterization test for the three consolidated client-persistence factories
 * (apps/web/src/lib/*), each of which absorbed several hand-rolled copies that
 * MUST keep byte-identical behavior at every call site:
 *
 *   - persistedDimension  — clamp-vs-reject out-of-range, optional max (a
 *     floor-only dimension has NO ceiling), and the SSR guard.
 *   - pendingDestination  — JSON `{slug,name}` vs legacy plain-slug read, and
 *     the JSON writer.
 *   - persistedToggleStore — boolean `"1"/"0"` vs three-state `auto/on/off`
 *     serde, the `compute()` verdict, class-stamp, and subscriber notify.
 *
 * These are web modules (they touch `localStorage`/`window`/`document`), so we
 * stub those globals. The toggle store's React hook (`use()`) is exercised in
 * the app, not here; every non-hook surface is pinned below.
 */

// ---- global stubs -------------------------------------------------------

class FakeStorage {
  store = new Map<string, string>();
  throwOnGet = false;
  throwOnSet = false;
  getItem(k: string): string | null {
    if (this.throwOnGet) throw new Error("blocked");
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    if (this.throwOnSet) throw new Error("blocked");
    this.store.set(k, String(v));
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
}

let storage: FakeStorage;
let classList: Set<string>;

beforeEach(() => {
  storage = new FakeStorage();
  classList = new Set<string>();
  (globalThis as Record<string, unknown>).localStorage = storage;
  (globalThis as Record<string, unknown>).window = { localStorage: storage };
  (globalThis as Record<string, unknown>).document = {
    documentElement: {
      classList: {
        toggle(cls: string, on: boolean) {
          if (on) classList.add(cls);
          else classList.delete(cls);
        },
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
});

const { createPersistedDimension } = await import("../../web/src/lib/persistedDimension.ts");
const { createPendingDestination } = await import("../../web/src/lib/pendingDestination.ts");
const { createPersistedToggleStore } = await import("../../web/src/lib/persistedToggleStore.ts");

// ---- persistedDimension -------------------------------------------------

describe("persistedDimension", () => {
  // MessagesModal: clamp into [min,max] with an SSR guard.
  const messages = () =>
    createPersistedDimension({
      key: "messagesModal:listWidth",
      min: 220,
      max: 560,
      default: 280,
      outOfRange: "clamp",
      ssrGuard: true,
    });
  // RoomsTree: reject out-of-range back to the default.
  const rooms = () =>
    createPersistedDimension({
      key: "tk_userlist_width",
      min: 200,
      max: 480,
      default: 256,
      outOfRange: "reject",
    });
  // TheaterPanel: floor only — NO ceiling.
  const theater = () =>
    createPersistedDimension({
      key: "tk:theaterHeight:v1",
      min: 160,
      default: 340,
      outOfRange: "clamp",
    });

  test("clamp mode: in-range kept, below floored, above capped", () => {
    const d = messages();
    storage.store.set("messagesModal:listWidth", "300");
    assert.equal(d.load(), 300);
    storage.store.set("messagesModal:listWidth", "100");
    assert.equal(d.load(), 220);
    storage.store.set("messagesModal:listWidth", "9999");
    assert.equal(d.load(), 560);
  });

  test("clamp mode: missing / empty / non-numeric → default", () => {
    const d = messages();
    assert.equal(d.load(), 280); // missing
    storage.store.set("messagesModal:listWidth", "");
    assert.equal(d.load(), 280);
    storage.store.set("messagesModal:listWidth", "abc");
    assert.equal(d.load(), 280);
  });

  test("ssrGuard: window undefined → default without touching storage", () => {
    const d = messages();
    storage.store.set("messagesModal:listWidth", "300");
    const savedWindow = (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).window;
    try {
      assert.equal(d.load(), 280);
    } finally {
      (globalThis as Record<string, unknown>).window = savedWindow;
    }
  });

  test("reject mode: in-range kept; below/above/zero → default (not clamped)", () => {
    const d = rooms();
    storage.store.set("tk_userlist_width", "300");
    assert.equal(d.load(), 300);
    storage.store.set("tk_userlist_width", "100");
    assert.equal(d.load(), 256);
    storage.store.set("tk_userlist_width", "9999");
    assert.equal(d.load(), 256);
    storage.store.set("tk_userlist_width", "0");
    assert.equal(d.load(), 256);
    storage.store.set("tk_userlist_width", "abc");
    assert.equal(d.load(), 256);
  });

  test("no-max mode: floors at min but never caps above", () => {
    const d = theater();
    storage.store.set("tk:theaterHeight:v1", "500");
    assert.equal(d.load(), 500);
    storage.store.set("tk:theaterHeight:v1", "99999");
    assert.equal(d.load(), 99999); // divergence: no ceiling
    storage.store.set("tk:theaterHeight:v1", "100");
    assert.equal(d.load(), 160); // floored
    storage.store.set("tk:theaterHeight:v1", "0");
    assert.equal(d.load(), 160);
    storage.store.set("tk:theaterHeight:v1", "abc");
    assert.equal(d.load(), 340);
  });

  test("read throwing (private mode) → default", () => {
    const d = rooms();
    storage.throwOnGet = true;
    assert.equal(d.load(), 256);
  });

  test("save writes String(value); set throwing is swallowed", () => {
    const d = theater();
    d.save(432);
    assert.equal(storage.store.get("tk:theaterHeight:v1"), "432");
    storage.throwOnSet = true;
    assert.doesNotThrow(() => d.save(500));
  });
});

// ---- pendingDestination -------------------------------------------------

describe("pendingDestination", () => {
  const KEY = "spire:return-server";
  const make = () => createPendingDestination(KEY);

  test("reads JSON {slug,name}", () => {
    storage.store.set(KEY, JSON.stringify({ slug: "abyss", name: "The Abyss" }));
    assert.deepEqual(make().read(), { slug: "abyss", name: "The Abyss" });
  });

  test("JSON without name → name null", () => {
    storage.store.set(KEY, JSON.stringify({ slug: "abyss" }));
    assert.deepEqual(make().read(), { slug: "abyss", name: null });
  });

  test("JSON without slug → null", () => {
    storage.store.set(KEY, JSON.stringify({ name: "nope" }));
    assert.equal(make().read(), null);
  });

  test("legacy plain-slug value → {slug, name:null}", () => {
    storage.store.set(KEY, "legacy-slug");
    assert.deepEqual(make().read(), { slug: "legacy-slug", name: null });
  });

  test("missing → null; malformed JSON → null; read throwing → null", () => {
    assert.equal(make().read(), null);
    storage.store.set(KEY, "{not json");
    assert.equal(make().read(), null);
    storage.store.set(KEY, "x");
    storage.throwOnGet = true;
    assert.equal(make().read(), null);
  });

  test("write stores JSON {slug,name} and round-trips; set throwing swallowed", () => {
    const pd = make();
    pd.write("abyss", "The Abyss");
    assert.equal(storage.store.get(KEY), JSON.stringify({ slug: "abyss", name: "The Abyss" }));
    assert.deepEqual(pd.read(), { slug: "abyss", name: "The Abyss" });
    pd.write("plain", null);
    assert.deepEqual(pd.read(), { slug: "plain", name: null });
    storage.throwOnSet = true;
    assert.doesNotThrow(() => pd.write("x", null));
  });

  test("storageKey is exposed unchanged", () => {
    assert.equal(make().storageKey, KEY);
  });
});

// ---- persistedToggleStore -----------------------------------------------

describe("persistedToggleStore", () => {
  test("boolean serde: '1'→true, '0'/null→false; setToggle persists '1'/'0'", () => {
    storage.store.set("k.bool", "1");
    const s = createPersistedToggleStore<boolean>({
      storageKey: "k.bool",
      rootClass: "bool-on",
      read: (raw) => raw === "1",
      serialize: (on) => (on ? "1" : "0"),
      compute: (t) => t,
    });
    assert.equal(s.getToggle(), true);
    assert.equal(s.enabled(), true);
    // The factory does NOT stamp the class on construction (each module does
    // that afterward via applyRootClass), so nothing is stamped yet.
    assert.ok(!classList.has("bool-on"));
  });

  test("boolean store: initial false when '0' or missing", () => {
    storage.store.set("k.bool", "0");
    const s = createPersistedToggleStore<boolean>({
      storageKey: "k.bool",
      rootClass: "bool-on",
      read: (raw) => raw === "1",
      serialize: (on) => (on ? "1" : "0"),
      compute: (t) => t,
    });
    assert.equal(s.getToggle(), false);
    s.setToggle(true);
    assert.equal(storage.store.get("k.bool"), "1");
    assert.equal(s.enabled(), true);
    s.setToggle(false);
    assert.equal(storage.store.get("k.bool"), "0");
    assert.equal(s.enabled(), false);
  });

  test("three-state serde: on/off/auto and unknown/null → auto; serialize identity", () => {
    const build = () =>
      createPersistedToggleStore<"auto" | "on" | "off">({
        storageKey: "k.tri",
        rootClass: "tri-on",
        read: (raw) => (raw === "on" || raw === "off" ? raw : "auto"),
        serialize: (v) => v,
        compute: (t) => t === "on",
      });
    storage.store.set("k.tri", "on");
    assert.equal(build().getToggle(), "on");
    storage.store.set("k.tri", "off");
    assert.equal(build().getToggle(), "off");
    storage.store.set("k.tri", "weird");
    assert.equal(build().getToggle(), "auto");
    storage.store.delete("k.tri");
    assert.equal(build().getToggle(), "auto");
    const s = build();
    s.setToggle("off");
    assert.equal(storage.store.get("k.tri"), "off");
  });

  test("read throwing (private mode) falls back to read(null)", () => {
    storage.throwOnGet = true;
    const s = createPersistedToggleStore<"auto" | "on" | "off">({
      storageKey: "k.tri",
      rootClass: "tri-on",
      read: (raw) => (raw === "on" || raw === "off" ? raw : "auto"),
      serialize: (v) => v,
      compute: (t) => t === "on",
    });
    assert.equal(s.getToggle(), "auto");
  });

  test("setToggle refreshes snapshot, stamps class, and notifies subscribers", () => {
    const s = createPersistedToggleStore<boolean>({
      storageKey: "k.bool",
      rootClass: "bool-on",
      read: (raw) => raw === "1",
      serialize: (on) => (on ? "1" : "0"),
      compute: (t) => t,
    });
    let hits = 0;
    const off = s.subscribe(() => { hits += 1; });
    s.setToggle(true);
    assert.equal(hits, 1);
    assert.ok(classList.has("bool-on"));
    s.setToggle(false);
    assert.equal(hits, 2);
    assert.ok(!classList.has("bool-on"));
    off();
    s.setToggle(true);
    assert.equal(hits, 2); // unsubscribed
  });

  test("refresh is a no-op (no notify) when the verdict is unchanged", () => {
    const s = createPersistedToggleStore<boolean>({
      storageKey: "k.bool",
      rootClass: "bool-on",
      read: (raw) => raw === "1",
      serialize: (on) => (on ? "1" : "0"),
      compute: () => false, // constant verdict, independent of toggle
    });
    let hits = 0;
    s.subscribe(() => { hits += 1; });
    s.setToggle(true); // toggle changes but compute stays false
    assert.equal(hits, 0);
    assert.equal(s.enabled(), false);
  });

  test("compute reads external state live on refresh (OR-of-signals pattern)", () => {
    let external = false;
    const s = createPersistedToggleStore<boolean>({
      storageKey: "k.bool",
      rootClass: "bool-on",
      read: (raw) => raw === "1",
      serialize: (on) => (on ? "1" : "0"),
      compute: (t) => t || external,
    });
    assert.equal(s.enabled(), false);
    let hits = 0;
    s.subscribe(() => { hits += 1; });
    external = true;
    s.refresh();
    assert.equal(s.enabled(), true);
    assert.equal(hits, 1);
  });

  test("applyRootClass stamps from the current snapshot", () => {
    storage.store.set("k.bool", "1");
    const s = createPersistedToggleStore<boolean>({
      storageKey: "k.bool",
      rootClass: "bool-on",
      read: (raw) => raw === "1",
      serialize: (on) => (on ? "1" : "0"),
      compute: (t) => t,
    });
    assert.ok(!classList.has("bool-on"));
    s.applyRootClass();
    assert.ok(classList.has("bool-on"));
  });
});
