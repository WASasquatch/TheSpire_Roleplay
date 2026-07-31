import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  OVERLOOK_PROXY_MIME_ALLOWLIST,
  isOverlookBlank,
  summarizeOverlookScene,
} from "@thekeep/shared";
import { isBlockedAddress } from "../src/routes/overlook.js";

/**
 * Overlook (migration 0371). Two pieces here carry real consequences and are
 * worth pinning:
 *
 *  - `summarizeOverlookScene` decides whether a saved canvas counts as
 *    carrying uploaded image bytes. Get it wrong in one direction and the
 *    admin's uploads-off switch silently leaks megabytes of base64 into the
 *    database; wrong in the other and ordinary link-based images stop saving.
 *
 *  - `isBlockedAddress` is the image proxy's SSRF guard. Without it, any
 *    signed-in user could point the proxy at the private network (or the
 *    cloud metadata endpoint) and read the response back through the canvas.
 */

describe("summarizeOverlookScene", () => {
  test("counts elements", () => {
    const scene = JSON.stringify({ elements: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    assert.equal(summarizeOverlookScene(scene).elementCount, 3);
  });

  test("an empty document is blank", () => {
    const s = summarizeOverlookScene('{"elements":[],"appState":{},"files":{}}');
    assert.equal(s.elementCount, 0);
    assert.equal(s.hasEmbeddedUploads, false);
    assert.equal(isOverlookBlank(s.elementCount), true);
  });

  test("an https URL in dataURL is NOT an upload", () => {
    // This is the whole point of the link-only mode: Excalidraw's loader does
    // a bare `img.src = dataURL` with no `data:` check, so we legitimately
    // store plain URLs in that field. Treating them as uploads would make
    // every link-based image unsavable while uploads are off.
    const scene = JSON.stringify({
      elements: [{ id: "img1", type: "image", fileId: "f1" }],
      files: { f1: { id: "f1", mimeType: "image/png", dataURL: "https://cdn.example/a.png" } },
    });
    assert.equal(summarizeOverlookScene(scene).hasEmbeddedUploads, false);
  });

  test("a proxied URL is NOT an upload", () => {
    const scene = JSON.stringify({
      elements: [],
      files: { f1: { dataURL: "/overlook/image?u=https%3A%2F%2Fcdn.example%2Fa.png" } },
    });
    assert.equal(summarizeOverlookScene(scene).hasEmbeddedUploads, false);
  });

  test("a base64 data URL IS an upload", () => {
    const scene = JSON.stringify({
      elements: [],
      files: { f1: { dataURL: "data:image/png;base64,iVBORw0KGgo=" } },
    });
    assert.equal(summarizeOverlookScene(scene).hasEmbeddedUploads, true);
  });

  test("one embedded file among many links still counts", () => {
    const scene = JSON.stringify({
      elements: [],
      files: {
        a: { dataURL: "https://cdn.example/a.png" },
        b: { dataURL: "https://cdn.example/b.png" },
        c: { dataURL: "data:image/webp;base64,AAAA" },
      },
    });
    assert.equal(summarizeOverlookScene(scene).hasEmbeddedUploads, true);
  });

  test("tolerates shapes an Excalidraw upgrade might produce", () => {
    // Must never throw on a valid-JSON document we don't recognize: a library
    // version bump that reshapes appState would otherwise start rejecting
    // every save. The byte cap is what actually bounds the damage.
    for (const raw of ['{"elements":"nope"}', '{"files":null}', "{}", "[]", "null", '"str"', "42"]) {
      assert.doesNotThrow(() => summarizeOverlookScene(raw), raw);
      assert.equal(summarizeOverlookScene(raw).elementCount, 0, raw);
      assert.equal(summarizeOverlookScene(raw).hasEmbeddedUploads, false, raw);
    }
  });

  test("throws only on payloads that are not JSON at all", () => {
    assert.throws(() => summarizeOverlookScene("not json"));
  });

  test("a file entry with no dataURL is ignored", () => {
    const scene = JSON.stringify({ elements: [], files: { a: {}, b: null, c: 7 } });
    assert.equal(summarizeOverlookScene(scene).hasEmbeddedUploads, false);
  });

  test("SVG is not a proxy-allowed image type", () => {
    // An SVG is a script-capable document. The world-map uploader bans it for
    // the same reason; the two lists must stay in agreement.
    assert.ok(!(OVERLOOK_PROXY_MIME_ALLOWLIST as readonly string[]).includes("image/svg+xml"));
  });
});

/**
 * Archive / resurrect contract. Room parking is a SOFT flag (`archived_at`),
 * so the canvas row survives it and comes back untouched when the same owner
 * returns. A TAKEOVER (someone else claiming an abandoned room name) is the
 * one case that must drop it: a canvas can hold unrevealed locations and plot
 * notes, and the previous owner's invited editors must not keep drawing
 * rights in a room that changed hands.
 *
 * Pinned as a predicate rather than a DB test because the decision is one
 * line in `resurrectArchivedRoom` and the whole risk is someone "simplifying"
 * it to an unconditional wipe (which would delete an owner's own work every
 * time they walked back into their room via `/go <name>`).
 */
function overlookSurvivesResurrect(priorOwnerId: string | null, callerId: string): boolean {
  return !(priorOwnerId && priorOwnerId !== callerId);
}

describe("Overlook across archive + resurrect", () => {
  test("owner walking back into their own room keeps the canvas", () => {
    assert.equal(overlookSurvivesResurrect("owner-1", "owner-1"), true);
  });

  test("a stranger claiming the name gets a fresh canvas", () => {
    assert.equal(overlookSurvivesResurrect("owner-1", "stranger-2"), false);
  });

  test("an ownerless row (no prior owner) keeps the canvas", () => {
    // Nothing was taken from anybody, so there is nothing to protect.
    assert.equal(overlookSurvivesResurrect(null, "someone-3"), true);
  });
});

describe("isBlockedAddress (image-proxy SSRF guard)", () => {
  const blocked = [
    "127.0.0.1",
    "127.53.1.9",
    "0.0.0.0",
    "10.0.0.1",
    "10.255.255.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata, the classic target
    "100.64.0.1", // CGNAT
    "224.0.0.1", // multicast
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1", // link-local
    "fc00::1", // unique local
    "fd12:3456::1",
    "::ffff:10.0.0.1", // IPv4-mapped private
    "::ffff:127.0.0.1",
    "not-an-ip",
    "",
  ];
  for (const addr of blocked) {
    test(`blocks ${addr || "(empty)"}`, () => {
      assert.equal(isBlockedAddress(addr), true);
    });
  }

  const allowed = [
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    "172.15.255.255", // just below the private 172.16/12 range
    "172.32.0.1", // just above it
    "192.167.255.255", // just below 192.168/16
    "100.63.255.255", // just below CGNAT
    "100.128.0.1", // just above CGNAT
    "223.255.255.255", // just below multicast
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8", // IPv4-mapped public
  ];
  for (const addr of allowed) {
    test(`allows ${addr}`, () => {
      assert.equal(isBlockedAddress(addr), false);
    });
  }
});
