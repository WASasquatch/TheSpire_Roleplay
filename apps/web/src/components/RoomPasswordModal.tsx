import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { Modal } from "./Modal.js";

interface Props {
  roomId: string;
  roomName: string;
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  onClose: () => void;
}

/**
 * Password prompt for joining a private room from the rail UI. The server
 * emits `ui:hint { kind: "prompt-room-password" }` whenever a non-member
 * tries to join a private room without a password; without this modal, the
 * click silently fails and the user has to know to type
 * `/go <room> <password>`.
 *
 * On submit we re-emit `room:join` with the password and rely on the
 * server's per-user brute-force window (5 fails / 60s) to throttle. The
 * modal stays open while the input is wrong so the user can retry without
 * navigating back to the rail.
 */
export function RoomPasswordModal({ roomId, roomName, socket, onClose }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!password) return;
    setSubmitting(true);
    setError(null);
    socket.emit("room:join", { roomId, password }, (res) => {
      setSubmitting(false);
      if (res.ok) {
        onClose();
        return;
      }
      // Common ack codes: BAD_PASSWORD, RATE_LIMIT, NO_ROOM, AUTH.
      // Let the user retry on bad-password; close on terminal errors so
      // they aren't stuck inside the modal.
      setError(res.message);
      setPassword("");
      if (res.code !== "BAD_PASSWORD") {
        // RATE_LIMIT keeps the modal open (user reads the cooldown), but
        // NO_ROOM / AUTH have nothing actionable here.
        if (res.code !== "RATE_LIMIT") onClose();
      }
    });
  }

  return (
    <Modal onClose={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-[min(420px,96vw)] rounded border border-keep-border bg-keep-bg p-5 text-keep-text shadow-xl"
      >
        <h2 className="font-action text-lg">Private room</h2>
        <p className="mt-1 text-sm text-keep-muted">
          <b>{roomName}</b> requires a password to join.
        </p>
        <input
          ref={inputRef}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="mt-3 block w-full rounded border border-keep-rule bg-keep-bg px-2 py-1 text-base outline-none focus:border-keep-action md:text-sm"
          placeholder="Password"
        />
        {error ? (
          <div className="mt-2 rounded border border-keep-accent/40 bg-keep-accent/10 px-2 py-1 text-xs text-keep-accent">
            {error}
          </div>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="keep-button rounded border border-keep-rule bg-keep-bg px-3 py-1 text-sm hover:bg-keep-banner"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !password}
            className="rounded border border-keep-action/60 bg-keep-action/10 px-3 py-1 text-sm font-semibold text-keep-action hover:bg-keep-action/20 disabled:opacity-50"
          >
            {submitting ? "Joining…" : "Join"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
