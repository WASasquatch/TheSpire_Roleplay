import argon2 from "argon2";

const OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // ~19 MiB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, OPTS);
}

export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

/**
 * Burn roughly one argon2-verify's worth of time on a throwaway hash, then
 * always return false. Called on the login "no such user" path so the
 * response time doesn't reveal whether an account/email exists (timing
 * side-channel). The dummy hash is computed once and reused.
 */
let dummyHashPromise: Promise<string> | null = null;
export async function dummyVerifyPassword(plaintext: string): Promise<false> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword("login-timing-equalizer");
  try {
    await argon2.verify(await dummyHashPromise, plaintext);
  } catch {
    /* ignore — the point is the work, not the result */
  }
  return false;
}
