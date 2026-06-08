/**
 * Client helpers for the global mutual Block list. The profile "Block" button
 * goes through the /block command (App.tsx), so this module only covers the
 * Profile -> Privacy management surface: list + remove.
 */
import { readError } from "./http.js";

export interface BlockedUser {
  userId: string;
  username: string;
  avatarUrl: string | null;
  createdAt: number;
}

/** Everyone the current account has blocked (newest first). */
export async function fetchBlocks(): Promise<BlockedUser[]> {
  const r = await fetch("/me/blocks", { credentials: "include" });
  if (!r.ok) throw new Error(await readError(r));
  const j = (await r.json()) as { blocks: BlockedUser[] };
  return j.blocks;
}

/** Lift a block you created. Idempotent server-side. */
export async function removeBlock(userId: string): Promise<void> {
  const r = await fetch(`/me/blocks/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!r.ok) throw new Error(await readError(r));
}
