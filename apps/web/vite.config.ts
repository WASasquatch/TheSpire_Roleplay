import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/auth": "http://localhost:3001",
      "/admin": "http://localhost:3001",
      "/characters": "http://localhost:3001",
      "/profiles": "http://localhost:3001",
      "/nav-links": "http://localhost:3001",
      "/rooms": "http://localhost:3001",
      "/stats": "http://localhost:3001",
      "/commands": "http://localhost:3001",
      "/messages": "http://localhost:3001",
      "/reports": "http://localhost:3001",
      "/push": "http://localhost:3001",
      "/affiliates": "http://localhost:3001",
      "/worlds": "http://localhost:3001",
      "/stories": "http://localhost:3001",
      "/me": "http://localhost:3001",
      "/health": "http://localhost:3001",
      "/users": "http://localhost:3001",
      "/site": "http://localhost:3001",
      "/rules": "http://localhost:3001",
      "/thesaurus": "http://localhost:3001",
      "/earning": "http://localhost:3001",
      "/mentions": "http://localhost:3001",
      // Emoticon catalog + reaction toggle endpoints. /emoticons is
      // GET only (anyone reads); /reactions/toggle is POST. Without
      // these in the proxy, dev mode silently 404s the catalog fetch
      // (the picker reports "no emoticon sheets installed") and
      // reaction toggles drop on the floor.
      "/emoticons": "http://localhost:3001",
      "/reactions": "http://localhost:3001",
      // Admin-uploaded files (profile BGs, emoticon sheet images,
      // story covers, etc.). Served from disk by fastify-static
      // in prod; the dev proxy needs the same passthrough so an
      // admin's uploaded sheet image isn't a 404 at /uploads/...
      "/uploads": "http://localhost:3001",
      "/socket.io": {
        target: "http://localhost:3001",
        ws: true,
      },
    },
  },
});
