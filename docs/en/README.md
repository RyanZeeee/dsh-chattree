# Chat Tree

**Turn a linear chat log into a conversation map you can read at a glance and click into.**

Chat Tree is a plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH). It adds a
**Chat Tree** view: every turn becomes a node on a canvas, so where a question came from and
what grew out of it are visible at once.

## The interface

**Dot canvas** — only nodes and lines. The nodes carry no text; hovering one brings up the
question you asked. The whole shape reads in one look.

![The dot canvas](../images/dot-mode.png)

**Card canvas** — every node is a card, so you read the turns directly. Selecting a node
highlights the whole path from it back to the first turn.

![The card canvas](../images/card-mode.png)

The panel on the right shows the full question and answer for the selected turn, and you can
keep asking from there — which grows a new branch out of that turn.

## What it solves

Chat long enough in DSH and the record becomes one long line: to find "which turn was that
plan discussed in" you scroll upward, and to take a different direction from some turn you
risk disturbing the context around it.

Chat Tree turns both into something you can see: **every turn is a node, every question is a
new branch**. The original line is always kept; a new idea grows out of the fork.

## Features

### Canvas and nodes
- **One turn, one card node**, laid out top to bottom in order, joined parent to child by a
  smooth curve
- **Every question forks**: asking on from a turn grows a new line out of that turn without
  touching the original
- **Click a node to read it**: the right-hand panel shows the full turn, and you can ask from
  there
- **Branch highlight**: selecting a node highlights the whole path from the root to it, so you
  can see where that turn came from
- **Archive**: hides a node and everything downstream of it from the canvas (the DSH session
  is never deleted)
- **Tidy**: re-arrange by level in one click; **Locate**: bring the view back to the newest turn
- **Drag and zoom**: drag to pan, wheel or trackpad to zoom, drag a node to move it (the
  position is remembered)

### Dot canvas (minimal view)
One click from the bottom-left. In dot mode there are **no cards**, only dots and lines:

- one dot = one turn, with **no text on the node**
- **hover** to bring up **the question you asked** (elided past 50 characters)
- the tooltip **does not scale with the canvas**, so it stays the same size at every zoom
- zooms out to **10%** (the card canvas stops at 60%), for taking in the whole graph

### Both modes share one arrangement
Switching modes **never moves a node**. The rules are always: a child sits one row below its
parent, each row is filled left to right with no gaps, and **a child sits beside its parent's
column** (so connectors never cross).

## Install

### Requirements
- DeepSeek Harness **2.0.9 or newer**
- Node.js **22.19+**

### From GitHub (recommended)

**DSH Desktop**: open the DSH Desktop terminal, where the profile defaults to `desktop`:

```bash
dsh plugin add "github:RyanZeeee/dsh-chattree"
```

**Plain CLI** (`dsh web` and friends): `--profile` is required, and `desktop` is not a
valid value there:

```bash
dsh plugin --profile <name> add "github:RyanZeeee/dsh-chattree"
```

Append `#v1.1.0` to pin a version. Restart that profile. A **Chat Tree** button appears in
the view switch at the top of the window.

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

pnpm install     # no third-party dependencies; only needed for the scripts
pnpm test        # layout rules + behaviour locks
pnpm run build   # syntax check on the three JS files
```

After changing `app.js` or `styles.css`: refresh the DSH window.
After changing `index.js` or `client.js`: restart DSH.

The plugin is not on npm yet, so installing by package name
(`dsh plugin add dsh-chattree`) does not work — install it from GitHub.

## Usage

1. Open any DSH conversation
2. Click **Chat Tree** in the middle of the top bar
3. Start talking — every question adds a node to the canvas

| What you want | How |
|---|---|
| Read a turn in full | Click it |
| Take a different direction from a turn | Click it → ask in the right-hand panel (forks automatically) |
| Change how the canvas looks | Last button in the bottom-left (dot / card) |
| Re-arrange | **Tidy** in the bottom-left |
| Go back to the newest turn | **Locate** in the bottom-left |
| Zoom out for the whole picture | Wheel / trackpad; dot mode goes to 10% |
| Send from the right-hand panel | **Enter** sends, **Shift+Enter** for a newline |
| Collapse the left rail | Button at the top of the rail (leaves one icon) |
| Lay nodes out yourself | Drag them; positions are remembered (**Tidy** restores the standard arrangement) |

### Reading the state

| What you see | What it means |
|---|---|
| A node **pulsing** | The assistant is replying |
| A node in **red** | That turn failed; open it for the reason |
| A **solid blue** node | The one you selected |
| A **pale blue** node | It lies on the path to your selection |
| A **dark blue** connector | Belongs to the selected node's line |

## Where your data lives

- Canvas structure (node links, arrangement, archive roots) is stored in DSH's own data directory
- **Conversation content is still kept by DSH**; the plugin neither changes nor copies it
- The plugin **does not use the network**: every request goes back to DSH itself
  (`/chattree/api/*`), with no external calls

## Permissions and bounds

DSH STORE inspects the runtime source statically at a fixed commit. The four things it asks for are
stated here in one place.

**Dependencies**: none at runtime. The host half uses only Node built-ins (`node:fs/promises`,
`node:crypto`, `node:path`, `node:url`) and imports no `@deepseek-ai/*` package; it talks to DSH
through service names (`webServer`, `sessions`) and the `remote.*` namespaces. The client half
(`client.js`) injects `@deepseek-ai/dsh-client-runtime` (`dsh.client.inject`) — supplied by DSH's
client module loader, not an npm dependency.

**Permissions** — this is the whole list:

| Surface | What it actually does |
|---|---|
| Files | Writes exactly one file: `$DSH_HOME/chattree/workspaces.json` (overridable through the profile's `dataFile`, see `cordis.patch.yml`); one `workspaces.json.lock` beside it (a PID lock, released on exit, stale locks reclaimed); and reads its own `app.js` / `styles.css` from its install directory to serve them. It does not read DSH's session files and touches no other path |
| Network | **Makes no outbound request.** The host half registers same-origin routes (`/chattree/…`) on DSH's own web server and the canvas page calls them by relative path; any `Host` outside the allowlist (`localhost`, `127.0.0.1`, plus whatever a profile adds to `trustedHosts`) gets a 403 |
| Commands | No subprocess, no shell |
| Credentials | No secrets read from the environment, no token held |

**External services**: none. No third-party host, no telemetry, no model call of its own — every
model call happens inside the DSH session you are already using.

**Failure bounds**:

- Data file missing → an empty graph is created; your sessions are untouched
- Data file corrupt or unreadable → the read is refused and **the path is reported**; your data is
  not silently overwritten. Canvas requests fail, DSH itself keeps running — mounting the plugin
  does not depend on that read
- Two instances at once → the PID lock stops them overwriting each other; a lock whose owner is gone
  is reclaimed, with one warning on stderr
- An optional DSH interface missing (model catalogue, command list) → those buttons stay out of the
  composer and say why in the menu; everything else works
- One unreadable session history → a warning is logged and that session is skipped; live projection
  is unaffected
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

Works in DSH Desktop and in a plain `dsh web` profile alike: the plugin only uses the
ordinary DSH contract and never touches Desktop's `desktopProfiles` / `desktopPnpm`.

## License

MIT
