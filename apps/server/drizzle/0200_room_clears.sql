-- Per-user, per-room "cleared my scrollback at" marker for `/clear`.
--
-- `/clear` used to be a purely client-side buffer wipe: the server
-- emitted a UI hint, the tab emptied its local message list, and the
-- next backlog resend (room rejoin / me:resync / scroll-up page) handed
-- the full history straight back. This table makes the clear DURABLE:
-- `/clear` records `cleared_at = now` for (user, room), and every
-- backlog source filters to `messages.created_at > cleared_at` for that
-- viewer, so cleared scrollback stays gone until new messages arrive.
--
-- It is a per-VIEWER marker, not a delete - other users are unaffected,
-- and no message rows are touched. Absence of a row = "never cleared."
CREATE TABLE `room_clears` (
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `room_id` TEXT NOT NULL REFERENCES `rooms`(`id`) ON DELETE CASCADE,
  `cleared_at` INTEGER NOT NULL,
  PRIMARY KEY (`user_id`, `room_id`)
);
--> statement-breakpoint
CREATE INDEX `room_clears_room_idx` ON `room_clears` (`room_id`);
