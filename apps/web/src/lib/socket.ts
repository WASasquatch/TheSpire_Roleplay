import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@thekeep/shared";
import { getSessionToken } from "./http.js";

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

/**
 * Sentinel sessionStorage key the AuthGate writes immediately after a
 * successful login or register submit. The socket's auth callback
 * consumes (reads-then-removes) the value on the very next handshake,
 * passing `intent: "login"` to the server — which is what gates the
 * "X has connected." chat broadcast. Subsequent reconnects (mobile
 * suspend, network blip, page reload) don't have the sentinel and so
 * stay silent in the chat log; the userlist still updates either way.
 *
 * sessionStorage (not localStorage) because the intent is per-tab —
 * a sibling tab opening fresh should NOT inherit a stale login intent
 * from another tab's recent submit.
 */
const LOGIN_INTENT_KEY = "tk_login_intent";

/** Set by AuthGate on form-submit success. One-shot — the next socket
 *  handshake consumes it. */
export function markLoginIntent(): void {
  try { window.sessionStorage.setItem(LOGIN_INTENT_KEY, "1"); }
  catch { /* private-mode — the broadcast just won't fire on this tab */ }
}

/**
 * Lazily instantiate the singleton socket. We pull the per-tab bearer
 * token from sessionStorage *at construction time* and pass it via the
 * Socket.io `auth` handshake field — that's what the server reads in
 * io.use() to authenticate this connection. The token is identical to
 * what fetches send in the Authorization header (same row in the
 * `sessions` table); the two transports just have different envelopes.
 *
 * `autoConnect: true` means the socket starts the handshake as soon as
 * the object is returned. By the time the React tree mounts and
 * registers its event handlers the connect is already in flight,
 * cutting first-message latency by a round-trip.
 *
 * `auth` is evaluated as a function so each reconnect attempt picks up
 * the *current* token from sessionStorage — important after a login on
 * a tab that started anonymous, or a logout that cleared the token. If
 * the function is passed `null` (no token), the handshake fails with
 * `unauthenticated` and the client lands back on the splash.
 *
 * The auth callback also consumes the one-shot `tk_login_intent`
 * sentinel on each call, so the very first handshake after a form
 * submit ships `intent: "login"` and every subsequent reconnect (same
 * tab) goes out silent. Reading + clearing in the same step prevents
 * the intent from sticking around past its one-shot use.
 */
export function getSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  if (socket) return socket;
  socket = io({
    path: "/socket.io",
    autoConnect: true,
    auth: (cb) => {
      const token = getSessionToken() ?? "";
      let intent: "login" | undefined;
      try {
        if (window.sessionStorage.getItem(LOGIN_INTENT_KEY) === "1") {
          intent = "login";
          window.sessionStorage.removeItem(LOGIN_INTENT_KEY);
        }
      } catch { /* private-mode — proceed without intent */ }
      cb(intent ? { token, intent } : { token });
    },
  });
  return socket;
}

/**
 * Tear down the socket. Optional `intentional` flag (set by the Exit
 * button) emits a `me:exit` event first so the server knows to fire
 * the "X has disconnected." chat broadcast. Without the flag the
 * disconnect is treated as transient and stays silent in chat —
 * matches the "mobile suspend / tab close = no chat noise" contract.
 */
export function disconnect(intentional = false): void {
  if (socket) {
    if (intentional && socket.connected) {
      // Fire-and-forget — no ack needed; the server's handler just
      // sets a flag on socket.data that the imminent disconnect
      // handler reads. We don't wait for round-trip confirmation
      // because socket.disconnect() below would race the ack
      // anyway, and the worst case (handshake lost) is just that
      // this Exit goes out silent — same as a tab close.
      socket.emit("me:exit");
    }
    socket.disconnect();
  }
  socket = null;
}
