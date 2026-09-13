# Development

## Setup

```bash
git clone https://github.com/RyanZeeee/dsh-chattree.git
cd dsh-chattree
dsh plugin --profile <name> add "$PWD"
```

`--profile` is required by a plain CLI and `<name>` must not be `desktop`: that profile
belongs to the desktop app and a plain CLI refuses to manage it. Use the profile you
launch (`dsh web` uses `web`). Inside the DSH Desktop terminal the profile defaults to
`desktop` and the desktop CLI allows it, so there it is just `dsh plugin add "$PWD"`.

No third-party dependencies — the plugin runs on DSH's own runtime.

## Checks

```bash
pnpm test        # layout rules + behaviour locks
pnpm run build   # node --check on the three entry points
```

`test/layout.test.mjs` extracts `placeConversationCards` / `layoutConversationGraph` from
`app.js` and runs them for real, so the arrangement rules are asserted against the shipped
code rather than a copy. If you change the layout, that suite is the specification.

### Desktop and plain DSH must both load it

The same plugin has to come up in DSH Desktop and in a plain `dsh web` profile. Desktop
adds two Host services on top of the ordinary DSH contract — `desktopProfiles` and
`desktopPnpm` — and the plugin-development guidance draws the line at three rules:

- a Desktop service must never sit in a top-level required `inject`; check
  `ctx.get('desktopProfiles')` first and scope the pair inside a nested `ctx.inject`, so
  the adapter unloads with either service's generation;
- the Desktop profile must never be inferred from `process.argv`, `ctx.baseUrl`, settings
  or `$DSH_HOME` — in Desktop it is `desktopProfiles.current`;
- `desktopRuntime`, `desktopPnpmBootstrap`, `ELECTRON_RUN_AS_NODE`, `BrowserWindow`, the
  generated shims and the tray registry are internal and stay out of the plugin.

This plugin needs neither Desktop service: the host half injects `webServer` and
`sessions`, the client half injects the web client's own services, and nothing reads a
profile. `test/compatibility.test.mjs` fails if any of those surfaces appears.

Source: <https://github.com/anywhere-labs/dsh-desktop/blob/master/docs/plugin-development.md>

### Do not add an install-time script

`package.json` must stay free of `prepare` / `install` / `postinstall` and friends. pnpm 11
refuses to install a git-hosted package whose build scripts it has not been allowed to run
(`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`), and the `allowBuilds` allowlist is keyed by the
tarball URL — so every new commit is blocked again and the plugin installs for nobody but
its author. Keep the syntax check in `pnpm run build`, where it is run on purpose.
`test/identity.test.mjs` fails if such a script comes back.

## Layout of the code

| File | Runs in | Notes |
|---|---|---|
| `index.js` | DSH host | canvas page + `/chattree/api/*` |
| `client.js` | DSH page | view switch, iframe, `postMessage` bridge |
| `app.js` | iframe | the canvas: state, rendering, layout, gestures |
| `styles.css` | iframe | theme tokens (`--ct-*`) then components |

## Reloading

| Changed | How to see it |
|---|---|
| `app.js`, `styles.css` | refresh the DSH window |
| `index.js`, `client.js` | restart DSH |

The canvas is served with `cache-control: no-store`, so a plain refresh is enough.

## Style

- Comments explain **why**, not what. If a rule looks odd, the reason is usually that
  something else broke first — write that down instead of the mechanism.
- User-visible strings are Chinese; keep identifiers in English.
- Theme values belong in the `--ct-*` token block, not inline.
