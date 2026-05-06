import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@thekeep/shared";

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

export function getSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  if (socket) return socket;
  socket = io({
    path: "/socket.io",
    withCredentials: true,
    autoConnect: true,
  });
  return socket;
}

export function disconnect(): void {
  socket?.disconnect();
  socket = null;
}
