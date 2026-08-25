# CLAUDE.md

Guidance for AI coding agents working in this repository.

## Project

A React single-page app scaffolded with **Vite** and **TypeScript**
(`react-ts` template). UI code lives in `src/`; `index.html` is the Vite entry
and `src/main.tsx` mounts `<App />` into `#root`.

## Environment

This project runs inside the DSH all-in-one container, and two things are
already running when you arrive — do not start a second copy of either:

- **The Vite dev server**, on `127.0.0.1:5173`. The container's entrypoint
  started it with `npm run dev`; its log is `/tmp/vite.log`. Vite hot-reloads,
  so an edit under `src/` is live without restarting anything.
- **Chrome**, headless-desktop with the DevTools protocol on `127.0.0.1:9222`
  and already navigated to the dev server. It is viewable through noVNC and
  drivable with **chrome-devtools-mcp**
  (`chrome-devtools-mcp --browserUrl http://127.0.0.1:9222`).

Node 24, npm 11 (registry: internal Nexus `nexus.jereh.cn`).

## Commands

```bash
npm run build      # tsc -b && vite build -> dist/
npm run lint       # oxlint
npm run preview    # serve the production build
npm run dev        # only if the dev server is not already up
```

## Working with the browser (chrome-devtools-mcp)

The container Chrome is a long-lived shared instance on CDP `9222`. Connect the
MCP to that instance rather than launching a browser:

```bash
chrome-devtools-mcp --browserUrl http://127.0.0.1:9222
```

Then use the MCP tools (`navigate_page`, `list_pages`, `take_snapshot`,
`evaluate_script`, ...) to inspect `http://127.0.0.1:5173/`. After editing
`src/`, Vite has already hot-reloaded — take a fresh snapshot rather than
reloading the page. Only one viewer should drive the desktop at a time.

## Conventions

- TypeScript strict mode is on (see `tsconfig.app.json`); keep it green —
  `npm run build` runs `tsc -b` and must pass before a change is done.
- Run `npm run lint` (oxlint) before finishing; fix what it flags.
- Components in `src/`, PascalCase filenames for components. Prefer function
  components with hooks.
- Keep changes scoped; match the existing style rather than reformatting.

## Verification

Verify against the running app, not just the type checker:

1. `npm run build` compiles clean.
2. The dev server still answers on `127.0.0.1:5173` (HTTP 200).
3. Through chrome-devtools-mcp, confirm the rendered DOM reflects the change
   (`take_snapshot` / `evaluate_script`). A screenshot is not evidence a value
   is correct — read the DOM.
