# Architecture

Chat Tree is one plugin with three JavaScript entry points and one stylesheet.

```
index.js     host side   — serves the canvas page and the JSON API
client.js    DSH page    — injects the view switch and the canvas iframe
app.js       canvas app  — the whole canvas, running inside that iframe
styles.css   canvas app  — theme layer for the canvas
```

## Why an iframe

The canvas owns its own document. That keeps the plugin's CSS out of DSH's layout, lets the
canvas be panned and scaled with plain transforms, and means a canvas re-render can never
disturb the host page. The two sides talk over `postMessage`, and both directions check the
origin before acting.

```
DSH page ── chattree:* ──▶ iframe   (workspace data, session echo, live replies)
DSH page ◀── chattree:* ── iframe   (ready, open session, activate session, fork, send)
```

`index.js` also exposes the canvas's own data API under `/chattree/api/*`. Every call is
relative — the plugin makes no network requests of its own.

## The canvas data model

A **card** is one question and its answer. Cards belong to a **thread** (one DSH session)
and are chained by `parentId`:

- inside a thread, turn *n* points at turn *n-1*;
- a thread that forked from another starts at the turn it forked from, resolved from
  `sourceSeedLength` (the seed length recorded when the fork was created). Falling back to
  the parent's last card is only for older data.

Because every question forks, a thread is always a straight line of turns. All the branching
lives in `parentId`.

## Layout

`layoutConversationGraph(cards, threads)` is the single source of truth for positions, and
it runs on the **scoped** card set — one conversation family, not the whole workspace:

1. each card's row is its depth in the `parentId` tree, so a child is always one row below
   its parent;
2. rows are filled left to right, with no gaps;
3. inside a row, cards are ordered by their **parent's column**, then by creation order.

Rule 3 is what keeps the connectors from crossing: a branch is placed beside the card it
grew from rather than at the end of the row. Positions are derived, never stored — the only
stored position data is the user's own drag offsets, which `整理` clears.

## Two faces, one graph

`state.canvasStyle` is either `card` or `dot`, remembered in local storage. The same
positions drive both:

- `conversationCard()` renders a full card;
- `dotNode()` renders an empty node — position and state only, with the question kept in a
  `data-question` attribute;
- connectors switch from the card-to-card curve to a centre-to-centre curve.

Dots are centred on their card's box with a negative margin, so the grid is shared and the
mode toggle is instant. The hover tooltip is a single element that lives **outside** the
transformed layer: a `position: fixed` element inside a scaled ancestor would be scaled with
it.

The canvas is virtualised: only cards inside the viewport (plus a margin) are mounted, and
`syncCanvasViewport()` mounts and unmounts as the camera moves. Both mount paths go through
the current mode.

## Rendering

The shell is built once and patched from then on; `render()` never replaces the document.

- `ensureShell()` writes the skeleton (sidebar, topbar, stage, canvas, card layer, dot tooltip)
  a single time. Every later render patches a region of it.
- Two regions hold state a rebuild would throw away — the **card layer**, where every answer is
  its own scroller, and the **panel** — so those are reconciled element by element. A card is
  replaced only when the markup it was given changed, and the panel's regions are compared the
  same way. Everything else (sidebar, topbar, the floating status and question) is markup that
  can simply be rewritten in place.
- The comparison is against **the markup we wrote**, never against a live `outerHTML`: the
  browser re-serializes SVG, so a card full of icons would read as changed on every render and
  be replaced forever.
- Nothing carries a scroll offset across a render. The element that owns the offset is never
  destroyed, so there is nothing to carry — which is also why the panel keeps the caret in its
  composer.

A card's identity is the turn's position in its thread (`<thread>:turn-index:<n>`), not its DSH
sequence number: a pending message has no sequence yet, and re-keying on it dropped every
reference filed under the old id. Threads only ever append, so the index never moves. Older
`workspaces.json` files are moved onto it by `retargetCardIds`, under state `version` 5.

The panel is in one of two modes, and which one decides the turn it shows:

- **following a line** (`inspectorFollowNewest`) — set by sending a question, which hands the
  panel to the line that received it. The turn it resolves to is that line's newest, so what is
  on screen is the question just asked and the answer streaming into it;
- **pinned to a card** — set by clicking a node, which clears the follow flag.

Handing the panel over therefore has to *drop* the card it was reading. `prepareCanvas()`
re-derives the panel's thread from whatever card it is showing, so a card left behind as the
panel changes lines puts it straight back on the previous conversation. For the same reason the
selection hand-over compares the turn it lands on rather than waiting for a newer one: a turn
keeps its id from the moment it is asked for, so "nothing changed" is not "nothing to do".

The composer's three option buttons — permission, model (with its reasoning effort in the same
menu, since an effort only means anything next to the model that declares it), and the context
ring — follow from the same rule. What the reader changes while working (a label, the ring, the
open state) is **written onto the elements after the patch**, and each menu is its own region of
the panel parked above the composer. Anything dynamic left in the composer's markup would make
the region read as changed and replace the textarea inside it, which costs the caret — the exact
failure the typed-text rule above exists to prevent. The jump-to-bottom button is in that same
region, so it is rendered plain and dressed by `syncInspectorJump()` for the same reason.

Compaction is the one write in the context menu, and it acts on the **session**, not on the
board: the canvas draws events the Host already projected into `workspaces.json`, and compaction
replaces a range of the session's *surface* rather than deleting anything, so no card moves or
disappears. What it changes is how much history the next turn carries — and because a fork seeds
its child with the parent's log, and `foldSurface()` replays that log including the replacement,
compressing a line before branching is what makes the branch lighter. Compress first, then
branch. The guards stay on the Host's side (`/compact` refuses while a turn is open, and when
there is nothing left to compact); the button only mirrors the idle half of that so it is not
offered a click it cannot honour.

## Camera rules

`state.activeId` identifies which canvas is on screen, so anything that reassigns it changes
what the user sees. The rules that keep that predictable:

- DSH's `current-session` echo may take over the canvas **only** when the canvas is not
  already showing that conversation, and never while a canvas-initiated switch is in flight;
- a projection refresh keeps the camera and keeps the active canvas unless the conversation
  it was showing has disappeared;
- a new node becomes selected, and the panel follows it, but **the camera does not move** —
  `定位` is the explicit way to bring a branch into view.

## Testing

`pnpm test` runs `node --test`. Two kinds of suite sit in `test/`:

- the functions that are pure get **extracted from `app.js` and run for real** — `layout` (the
  arrangement), `identity` and `migration` (card ids), `stream` (what a turn renders while it is
  being written), `focus` (where the panel and the selection land after a question is sent);
- `features` and `compatibility` lock the wiring that cannot be exercised without a browser —
  forks, the dot canvas, the tooltip, Enter-to-send, camera rules, naming.
