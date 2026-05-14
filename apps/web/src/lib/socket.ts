import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@thekeep/shared";
import { getSessionToken } from "./http.js";

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

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
 */
export function getSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  if (socket) return socket;
  socket = io({
    path: "/socket.io",
    autoConnect: true,
    auth: (cb) => cb({ token: getSessionToken() ?? "" }),
  });
  return socket;
}

export function disconnect(): void {
  socket?.disconnect();
  socket = null;
}
