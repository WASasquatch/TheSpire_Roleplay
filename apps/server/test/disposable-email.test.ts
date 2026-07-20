import "./helpers/env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedEmailDomain, parseBlockedEmailDomains, emailDomain } from "../src/auth/disposableEmail.js";

describe("disposable email blocking", () => {
  test("blocks well-known throwaway providers from the vendored list", () => {
    for (const e of [
      "x@temp-mail.org", "y@10minutemail.com", "z@mailinator.com",
      "a@guerrillamail.net", "b@yopmail.com", "c@trashmail.com",
      "d@throwawaymail.com", "e@fakemailgenerator.com", "f@getnada.com",
    ]) {
      assert.equal(isBlockedEmailDomain(e), true, e);
    }
  });

  test("allows normal providers", () => {
    for (const e of ["me@gmail.com", "me@proton.me", "me@outlook.com", "me@company.co.uk", "me@mycooldomain.dev"]) {
      assert.equal(isBlockedEmailDomain(e), false, e);
    }
  });

  test("catches SUBDOMAINS of a blocked host, not lookalike names", () => {
    assert.equal(isBlockedEmailDomain("a@inbox.mailinator.com"), true, "subdomain of a blocked host");
    // A real domain that merely CONTAINS a blocked label as a substring must NOT match.
    assert.equal(isBlockedEmailDomain("a@mailinator-marketing.com"), false, "lookalike is not blocked");
    assert.equal(isBlockedEmailDomain("a@nottrashmail.example.com"), false, "unrelated domain");
  });

  test("admin extra list extends the block, case/format tolerant", () => {
    const extra = parseBlockedEmailDomains("Burner.example\n  @throwaway.test , spam.example ; https://evil.example/path");
    assert.deepEqual([...extra].sort(), ["burner.example", "evil.example", "spam.example", "throwaway.test"]);
    assert.equal(isBlockedEmailDomain("x@burner.example", extra), true);
    assert.equal(isBlockedEmailDomain("x@sub.spam.example", extra), true, "extra list also matches subdomains");
    assert.equal(isBlockedEmailDomain("x@burner.example"), false, "not blocked without the extra list");
  });

  test("emailDomain handles junk and trailing dots", () => {
    assert.equal(emailDomain("a@b@TEMP-MAIL.ORG."), "temp-mail.org");
    assert.equal(emailDomain("noatsign"), null);
    assert.equal(emailDomain(""), null);
  });
});
