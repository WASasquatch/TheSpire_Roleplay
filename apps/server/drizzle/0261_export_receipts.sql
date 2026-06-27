-- Tamper-evident chat-export receipts (migration 0261).
--
-- Every `/export` records a tiny receipt here so a downloaded log can be
-- proven authentic against the server — even after its messages age out of
-- retention. The row stores ONLY metadata + a content hash, never message
-- bodies, so it is privacy-safe to keep indefinitely. The hash is the
-- SHA-256 of the same canonical payload the server HMAC-signs into the
-- file's manifest; staff verification recomputes both and cross-checks.
--
-- `id` is the human-facing Verification ID (e.g. `EXP-...`) printed in the
-- log footer. `signature` is kept so a receipt alone can re-confirm a file.
CREATE TABLE `export_receipts` (
  `id` TEXT PRIMARY KEY,
  `room_id` TEXT REFERENCES `rooms`(`id`) ON DELETE SET NULL,
  `room_name` TEXT NOT NULL,
  `exported_by_user_id` TEXT REFERENCES `users`(`id`) ON DELETE SET NULL,
  `exported_by_username` TEXT NOT NULL,
  `generated_at` INTEGER NOT NULL,
  `window_ms` INTEGER NOT NULL,
  `range_start` INTEGER NOT NULL,
  `range_end` INTEGER NOT NULL,
  `message_count` INTEGER NOT NULL,
  `truncated` INTEGER NOT NULL DEFAULT 0,
  `content_hash` TEXT NOT NULL,
  `signature` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
-- Confirm a submitted file by its embedded hash without knowing the id.
CREATE INDEX `export_receipts_hash_idx` ON `export_receipts` (`content_hash`);
--> statement-breakpoint
-- Browse a user's or room's recent exports newest-first.
CREATE INDEX `export_receipts_room_idx` ON `export_receipts` (`room_id`, `generated_at`);
--> statement-breakpoint
-- Verifying a submitted export is an admin-content action; seed it to the
-- `admin` role (masteradmin bypasses). Lower roles get it only if granted.
INSERT OR IGNORE INTO `role_permission_grants` (`role`, `permission_key`) VALUES
  ('admin', 'verify_export_logs');
