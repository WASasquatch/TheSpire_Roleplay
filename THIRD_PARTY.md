# Third-party notices

The Spire is licensed under the GNU AGPL v3.0 (see [LICENSE](LICENSE)). It
bundles third-party components under their own, more permissive licenses.
Those licenses are compatible in this direction: permissive code may be
combined into an AGPL work, and the combined work ships under the AGPL while
each component keeps its original license and attribution.

This file lists components whose license asks for attribution to travel with
the distributed software. Ordinary build-time-only tooling is not listed; the
full dependency tree with per-package licenses is in `pnpm-lock.yaml` and can
be regenerated at any time with `pnpm licenses list`.

---

## Excalidraw

Powers the **Overlook** canvas on rooms and worlds.

- Package: `@excalidraw/excalidraw`
- Homepage: https://github.com/excalidraw/excalidraw
- License: MIT
- Copyright (c) 2020 Excalidraw

Font files from this package are copied into the web bundle at build time by
`apps/web/scripts/sync-excalidraw-assets.mjs` so they can be self-hosted (the
production CSP blocks the upstream CDN). Those font files carry their own
licenses, shipped inside the package under `dist/prod/fonts` and listed in the
Excalidraw repository: Excalifont, Virgil, Nunito, Lilita One, Comic Shanns,
Cascadia Code, Assistant, and Liberation Sans. The bundled CJK family
(Xiaolai) is deliberately not copied, as the site ships English and Spanish
only.

```
MIT License

Copyright (c) 2020 Excalidraw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Other bundled runtime components

Used as published; copyright remains with the respective authors. See each
project's repository for its full license text.

| Component | License | Used for |
|---|---|---|
| React, React DOM | MIT | the whole client |
| GrapesJS | BSD-3-Clause | the profile designer canvas |
| `@grapesjs/react` | MIT | the profile designer's React bindings |
| TipTap / ProseMirror | MIT | the rich chat + forum composer |
| Lucide (`lucide-react`) | ISC | icons throughout the UI |
| hls.js | Apache-2.0 | Theater live streams |
| react-player | MIT | Theater playback |
| socket.io, socket.io-client | MIT | realtime chat transport |
| Zustand | MIT | client state |
| i18next, react-i18next | MIT | translations |
| DOMPurify | MPL-2.0 OR Apache-2.0 | sanitizing user-authored HTML |
| Tailwind CSS | MIT | styling |
| Fastify | MIT | the HTTP server |
| Drizzle ORM | Apache-2.0 | database access |
| better-sqlite3 | MIT | the SQLite driver |
| Zod | MIT | request validation |
| sharp | Apache-2.0 | server-side image processing |
| nanoid | MIT | id generation |
| argon2 | MIT | password hashing |

DOMPurify is dual-licensed; The Spire uses it under the Apache-2.0 option.
