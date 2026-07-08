import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isModeratorRole, roleRank, type Role } from "@thekeep/shared";

/**
 * Characterization test for the existing `isModeratorRole` helper
 * (packages/shared/src/profile.ts, finding E1). Five call sites had
 * re-derived the same predicate as `roleRank(x) >= roleRank("mod")`
 * (rooms.ts, staff.ts negated, commands/profile.ts, ProfileModal.tsx x2)
 * and were consolidated onto `isModeratorRole`. This pins that the two
 * forms produce identical results across every role so the move stays
 * behavior-preserving: mod/admin/masteradmin are moderators; user/trusted
 * are not.
 */
describe("isModeratorRole", () => {
  const roles: Role[] = ["user", "trusted", "mod", "admin", "masteradmin"];

  const expected: Record<Role, boolean> = {
    user: false,
    trusted: false,
    mod: true,
    admin: true,
    masteradmin: true,
  };

  for (const role of roles) {
    test(`${role} => ${expected[role]}`, () => {
      assert.equal(isModeratorRole(role), expected[role]);
    });

    test(`${role} matches roleRank(x) >= roleRank("mod")`, () => {
      assert.equal(isModeratorRole(role), roleRank(role) >= roleRank("mod"));
    });
  }
});
