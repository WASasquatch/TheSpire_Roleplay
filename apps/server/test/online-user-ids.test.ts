import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { onlineUserIds } from "../src/realtime/broadcast.js";

/**
 * Characterization test for the consolidated `onlineUserIds` helper
 * (apps/server/src/realtime/broadcast.ts, finding M5), extracted
 * byte-identically from three duplicate copies in admin/routes.ts (×2) and
 * earning/eidolonNudge.ts. Pins the "one fetchSockets pass, dedupe by userId,
 * skip sockets with no userId" contract that all three inline copies had.
 */

type FakeSocket = { id: string; data: { userId?: string } };

function fakeIo(sockets: FakeSocket[]): Parameters<typeof onlineUserIds>[0] {
  return { fetchSockets: async () => sockets } as unknown as Parameters<typeof onlineUserIds>[0];
}

describe("onlineUserIds", () => {
  const cases: Array<{ label: string; sockets: FakeSocket[]; expected: string[] }> = [
    { label: "no sockets", sockets: [], expected: [] },
    {
      label: "single user single socket",
      sockets: [{ id: "s1", data: { userId: "u1" } }],
      expected: ["u1"],
    },
    {
      label: "same user across multiple tabs deduped",
      sockets: [
        { id: "s1", data: { userId: "u1" } },
        { id: "s2", data: { userId: "u1" } },
      ],
      expected: ["u1"],
    },
    {
      label: "multiple distinct users",
      sockets: [
        { id: "s1", data: { userId: "u1" } },
        { id: "s2", data: { userId: "u2" } },
      ],
      expected: ["u1", "u2"],
    },
    {
      label: "sockets without a userId are skipped",
      sockets: [
        { id: "s1", data: {} },
        { id: "s2", data: { userId: "u1" } },
        { id: "s3", data: { userId: undefined } },
      ],
      expected: ["u1"],
    },
  ];

  for (const c of cases) {
    test(c.label, async () => {
      const got = await onlineUserIds(fakeIo(c.sockets));
      assert.ok(got instanceof Set, "returns a Set");
      assert.deepEqual([...got].sort(), c.expected.slice().sort());
    });
  }
});
