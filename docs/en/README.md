# Chat Tree

**Turn a linear chat log into a conversation map you can read at a glance and click into.**

Chat Tree is a plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH). It adds a **Chat Tree** view: every turn becomes a node on a canvas, so where a question came from and what grew out of it are visible at once.

## The interface

**Dot mode** — only nodes and connectors, with no text on a node; hover to bring up the question you asked. The whole shape reads at once.

![The dot canvas](../images/dot-mode.png)

**Card mode** — every node is a card, so the turn reads directly. Select one node and the whole path from the root to it highlights.

![The card canvas](../images/card-mode.png)

The right-hand panel shows the selected turn in full, and you can ask on from there — which forks a new line out of that turn.

## What it solves

Chat in DSH for long enough and the record becomes one very long line: to find "which turn was that plan in" you scroll back through everything, and to **take a different direction from a turn** you risk tangling the context you already have.

Chat Tree turns both into something you can see and click: **one turn is one node, and every question is a new branch** — the original line is always kept, and a new idea grows out of the fork.

## Features

### Canvas and nodes
- **One turn = one card node**, laid out top to bottom in order, joined parent to child by a smooth curve
- **Every question forks**: asking on from a turn grows a new line out of that turn without touching the original
- **Click a node to read it**: the right-hand panel shows the full turn, and you can ask from there
- **Branch highlight**: selecting a node highlights the whole path from the root to it, so you can see where that turn came from
- **Archive**: hides a node and everything downstream of it from the canvas (the DSH session is never deleted)
- **Tidy**: re-arrange by level in one click; **Locate**: bring the view back to the newest turn
- **Drag and zoom**: drag to pan, wheel or trackpad to zoom, drag a node to move it (the position is remembered)

### The rail: workspaces, then canvases

The rail has two levels: **workspaces** (directories DSH knows about), and the **canvases** inside each one.

- Clicking a workspace row **folds or unfolds** it; the workspace holding the current canvas stays open, and the folded state is remembered
- Clicking a canvas row opens that canvas
- **⋯** at the end of either row → **rename**. The name is **written back to DSH**, so DSH's own sidebar shows the same one, and renaming on either side is the same rename
- **+** beside the workspace heading opens the system directory picker and adds the chosen directory as a workspace (one that is already there is reported, not added twice)
- **New canvas** at the top asks **which workspace** first, then creates the session in that directory

### The buttons around the composer

Bottom of the right-hand panel:

| Button | What it does |
|---|---|
| **Attach** | Sends files with this question |
| **Permission** | Switches DSH's permission preset; a preset that **lifts the sandbox / stops asking each time** asks you to confirm first |
| **Model** | Picks the model and reasoning effort for this session (grouped by provider) |
| **Context** | The ring is context occupancy; open it for the percentage and how much of it is **system prompt / tools / conversation** |
| **Send** | Enter sends, Shift+Enter adds a newline |

When the matching DSH interface is missing (a build with no model catalogue, say), that button is absent and the menu says why.

### Compacting the context

**Compact context** in the context menu calls DSH's `/compact`: the session history is replaced by a summary, and the conversation carries on above it.

It leaves a **green node** on the canvas — a green card in card mode, a green dot in dot mode — headed *context compacted*, holding that summary. **You can continue the conversation from it**: ask there and the new branch's history starts at the summary.

## Install

### Requirements
- DeepSeek Harness **2.0.9 or newer**
- Node.js **22.19+**

### From GitHub (recommended)

**DSH Desktop**: open the terminal inside DSH Desktop, where the profile is `desktop` by default:

```bash
dsh plugin add "github:RyanZeeee/dsh-chattree"
```

**Plain command line** (`dsh web` and other profiles): `--profile` is required:

```bash
dsh plugin --profile <name> add "github:RyanZeeee/dsh-chattree"
```

Restart that profile and **Chat Tree** appears in the view switcher at the top.

### From a clone

```bash
git clone https://github.com/RyanZeeee/dsh-chattree.git
cd dsh-chattree
dsh plugin --profile <name> add "$PWD"
```

### Local development

```bash
git clone https://github.com/RyanZeeee/dsh-chattree.git
cd dsh-chattree
dsh plugin --profile <name> add "$PWD"

pnpm install     # no third-party dependencies; only for the scripts
pnpm test        # arrangement rules + behaviour locks
pnpm run build   # syntax check of the three JS files
```

Changing `app.js` or `styles.css`: refresh the DSH page.
Changing `index.js` or `client.js`: restart DSH.

## Where your data lives

- Canvas structure (node links, arrangement, archive roots) is stored in DSH's own data directory
- **Conversation content is still kept by DSH**; the plugin neither changes nor copies it
- View preferences (node positions, rail folds, canvas mode and zoom, quick phrases, panel width) stay in the browser
- The plugin **does not use the network**: every request goes back to DSH itself (`/chattree/api/*`), with no external calls

## Permissions and bounds

**Dependencies**: none at runtime. The host half uses only Node built-ins (`node:fs/promises`, `node:crypto`, `node:path`, `node:url`) and imports no `@deepseek-ai/*` package; it talks to DSH through service names (`webServer`, `sessions`) and the `remote.*` namespaces. The client half (`client.js`) injects `@deepseek-ai/dsh-client-runtime` (`dsh.client.inject`) — supplied by DSH's client module loader, not an npm dependency.

**Permissions** — this is the whole list:

| Surface | What it actually does |
|---|---|
| Files | Writes exactly one file: `$DSH_HOME/chattree/workspaces.json` (overridable through the profile's `dataFile`, see `cordis.patch.yml`); one `workspaces.json.lock` beside it (a PID lock, released on exit, stale locks reclaimed); and reads its own `app.js` / `styles.css` from its install directory to serve them. It does not read DSH's session files and touches no other path |
| Network | **Makes no outbound request.** The host half registers same-origin routes (`/chattree/…`) on DSH's own web server and the canvas page calls them by relative path; any `Host` outside the allowlist (`localhost`, `127.0.0.1`, plus whatever a profile adds to `trustedHosts`) gets a 403 |
| Commands | No subprocess, no shell |
| Credentials | No secrets read from the environment, no token held |

**External services**: none. No third-party host, no telemetry, no model call of its own — every model call happens inside the DSH session you are already using.

**Failure bounds**:

- Data file missing → an empty graph is created; your sessions are untouched
- Data file corrupt or unreadable → the read is refused and **the path is reported**; your data is not silently overwritten. Canvas requests fail, DSH itself keeps running — mounting the plugin does not depend on that read
- Two instances at once → the PID lock stops them overwriting each other; a lock whose owner is gone is reclaimed, with one warning on stderr
- An optional DSH interface missing (model catalogue, command list) → those buttons stay out of the composer and say why in the menu; everything else works
- One unreadable session history → a warning is logged and that session is skipped; live projection is unaffected
- Uninstall → the routes go with it; `workspaces.json` is left in place (delete it to remove it)

**To check it yourself** (in a disposable profile, leaving your own alone):

```bash
dsh --profile chattree-check --from-default-profile web                  # disposable profile
dsh plugin --profile chattree-check add github:RyanZeeee/dsh-chattree    # install
dsh --profile chattree-check                                             # start: Chat Tree appears
dsh plugin --profile chattree-check remove dsh-chattree                  # uninstall
rm -rf ~/.dsh/profiles/chattree-check                                    # remove every trace
```

## Requirements

- DeepSeek Harness 2.0.9 or newer
- Node.js 22.19+

Both DSH Desktop and a plain `dsh web` profile work: the plugin depends only on the official DSH contract, and uses no Desktop-specific `desktopProfiles` / `desktopPnpm`.

## License

MIT
