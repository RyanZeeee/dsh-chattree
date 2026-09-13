// Behaviour locks for the parts that cannot be unit-tested without a browser: the canvas
// lives inside an iframe and talks to DSH over postMessage, so these assertions read the
// shipped source and check the wiring is intact.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = name => readFileSync(join(root, name), 'utf8')
const app = read('app.js')
const client = read('client.js')
const host = read('index.js')
const css = read('styles.css')

const has = (haystack, needle, label = needle) =>
  assert.ok(haystack.includes(needle), `missing: ${label}`)

test('the canvas never talks to the network', () => {
  const remote = app.match(/https?:\/\/(?!127\.0\.0\.1|localhost)[^\s'"`)]+/g) ?? []
  assert.deepEqual(remote, [], `external URLs found: ${remote.join(', ')}`)
  assert.ok(!/fetch\(\s*['"`]http/.test(app), 'a fetch uses an absolute URL')
})

test('every question forks a new session instead of continuing in place', () => {
  has(app, "dshRpc('chattree:fork-session'", 'forks through the host')
  has(app, 'sourceSeedLength', 'sends the seed length')
  has(app, 'anchorCardId', 'sends the anchor card')
})

test('the canvas shows one conversation family: scope first, then arrange', () => {
  has(app, 'layoutConversationGraph(scopedCards(', 'scope before arrange')
})

test('a branch is anchored to the turn it forked from', () => {
  has(app, 'inheritedTurn', 'seed-derived anchor')
  has(app, 'card.parentId = inheritedTurn?.id', 'the seed anchor wins')
})

test('the dot canvas draws one node per turn with no text in it', () => {
  has(app, 'function dotNode(card) {')
  has(css, 'content: attr(data-label)', 'the node label rides on hover')
  const dot = app.slice(app.indexOf('function dotNode(card) {'))
  const body = dot.slice(0, dot.indexOf('\n}'))
  // The node is an empty element: it carries position and state, and nothing between its
  // tags. Reading answer.pending for the pulse is fine; rendering prose is not.
  // The question reaches the DOM only as an attribute (the tooltip reads it back); the
  // element itself is empty, which is what keeps the dot canvas quiet.
  assert.ok(body.includes('></button>`'), 'the dot renders content between its tags')
  const attributes = body.slice(body.indexOf('<button'), body.indexOf('></button>'))
  assert.ok(!/>/.test(attributes.replace(/^<button[^>]*/, '')), 'the dot nests visible markup')
})

test('the dot tooltip stays one size at every zoom', () => {
  // It has to live outside the transformed layer, or a scaled ancestor shrinks it.
  has(app, '</div></div><div class="dot-tooltip" hidden></div></section>', 'outside .canvas-content')
  has(app, 'const x = event.clientX + 14', 'tracking the pointer')
  has(app, 'characters.length > 50', 'elided past 50 characters')
  has(css, '.dot-tooltip {')
})

test('the panel is mounted once and patched, never rebuilt', () => {
  // It is the one surface the reader reads *while* it changes. Rebuilding it handed back a
  // scroll container parked at 0, and no remember-then-restore in a later frame beat just
  // keeping the element.
  has(app, "document.createElement('aside')", 'the panel element is created once')
  has(app, "patchSlot(inspectorPanel.querySelector('.card-inspector-scroll'), model.scroll)", 'the scroller is patched, not replaced')
  has(app, 'writtenHtml.get(element) === html', 'a patch writes only on a real change')
  // The typed text stays out of the markup: with it in, every keystroke would change the
  // composer's HTML and the patch would rewrite the box, taking the caret with it.
  has(app, 'function applyComposerValues()', 'the typed text is applied after the patch')
  has(app, 'if (field.value !== stored) field.value = stored', 'a box already holding the text is left alone')
  const composer = app.slice(app.indexOf('function inspectorComposer('))
  assert.ok(!composer.slice(0, composer.indexOf('\n}')).includes('${escapeHtml(text)}'), 'the composer markup still carries the typed text')
  has(app, 'syncInspectorPanel(inspectorModel)', 'render() mounts it outside the canvas string')
  const canvas = app.slice(app.indexOf('function prepareCanvas()'))
  assert.ok(!canvas.slice(0, canvas.indexOf('\n}')).includes('${inspector}'), 'the canvas still renders the panel into its own string')
})

test('the shell is built once and its regions are patched', () => {
  // Everything a rebuild would throw away -- a scrolled answer, a caret, a drag in flight --
  // lives under the shell, so the shell itself is only ever created once.
  has(app, 'function ensureShell()', 'the shell has a single build path')
  has(app, 'if (shell !== null && shell.isConnected) return shell', 'it is reused while it is live')
  // The sidebar goes through syncSidebar() so a live rename box can hold the region still; the
  // patch is still the only thing that writes it.
  has(app, 'function syncSidebar(shellElement, rail) {', 'the sidebar has a sync path')
  has(app, "patchSlot(sidebar, sidebarHtml(rail))", 'and it is still patched, not rebuilt')
  has(app, 'syncCanvasCards(prepared.cards, prepared.graph)', 'cards are reconciled rather than rebuilt')
  has(app, 'writtenHtml.get(existing) === html', 'an unchanged card is left alone')
  // Comparing against a live outerHTML cannot work: the browser re-serializes SVG, so a card
  // full of icons reads as changed on every render and is replaced forever.
  has(app, 'const writtenHtml = new WeakMap()', 'the markup we wrote is what gets compared')
  const render = app.slice(app.indexOf('function render() {'), app.indexOf('\n  syncInspectorPanel(inspectorModel)'))
  assert.ok(!render.includes('app.innerHTML'), 'render() still replaces the whole document')
})

test('the composer options are filled in after the patch, never rendered into it', () => {
  // Switching a model or a preset changes that button's label. With the label in the markup the
  // composer's region read as changed, so the patch rewrote it and the textarea inside it was
  // replaced -- focus and caret gone, which is the same failure the typed-text rule prevents.
  has(app, 'function syncComposerOptions(panel)', 'the labels have a place to be written')
  has(app, 'syncComposerOptions(inspectorPanel)', 'render() fills them in after the patch')
  has(app, 'fill.setAttribute(\'stroke-dasharray\', composerRingDash(occupancy.percent))', 'the ring is drawn onto the element too')
  const trigger = app.slice(app.indexOf('function composerTrigger('))
  const body = trigger.slice(0, trigger.indexOf('\n}'))
  assert.ok(!body.includes('${escapeHtml(label)}'), 'the trigger still renders its own label')
  assert.ok(!/is-open|aria-expanded="\$\{/.test(body), 'the trigger still renders its own open state')
})

test('the option menus are their own region, outside the composer', () => {
  // The menu cannot live in the composer's string for the same reason its labels cannot: every
  // open and close would replace the box. It is parked above the composer instead, anchored by
  // measuring it, because the box grows as it is typed into.
  has(app, 'function syncComposerMenu(panel, html)', 'the menu has its own region')
  has(app, 'syncComposerMenu(inspectorPanel, composerMenuHtml())', 'render() syncs it separately')
  has(app, 'element.style.bottom = `${Math.round(height) + 10}px`', 'it is anchored to the composer it sits above')
  const composer = app.slice(app.indexOf('function inspectorComposer('))
  assert.ok(!composer.slice(0, composer.indexOf('\n}')).includes('composerMenuHtml()'), 'the menu is rendered into the composer again')
})

test('lifting the sandbox is asked for twice', () => {
  // `danger-full-access` stops the agent asking and lifts the sandbox. One mis-click on a menu
  // row must not be enough to trade every guard rail for a silent session.
  has(app, "const DANGER_PRESET = 'danger-full-access'")
  has(app, 'if (button.dataset.preset === DANGER_PRESET)', 'the dangerous preset takes the confirm path')
  has(app, "data-action=\"composer-confirm-permission\"", 'the confirmation has its own action')
  has(app, "state.composerConfirmPreset = null", 'the confirmation is cleared with the menu')
})

test('the dot canvas zooms further out than the card canvas', () => {
  has(app, 'const ZOOM_MIN_DOT = .1')
  has(app, "return state.canvasStyle === 'dot' ? ZOOM_MIN_DOT : ZOOM_MIN", 'the floor follows the mode')
})

test('Enter sends from the panel and Shift+Enter keeps the newline', () => {
  has(app, "if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return")
  has(app, 'form.requestSubmit()', 'sends through the existing form')
})

test('nothing re-frames the canvas while the user is reading it', () => {
  const focus = app.slice(app.indexOf('function carryOutPendingFocus'))
  const body = focus.slice(0, focus.indexOf('\n}'))
  assert.ok(!body.includes('focusActiveCard'), 'a new node still moves the camera')
  has(app, 'const activeStillListed = state.workspace.threads.some', 'a refresh keeps the active canvas')
  has(app, 'const preserveCanvasCamera = requested || pending || onActiveCanvas', 'echoes keep the camera')
})

test('archiving hides the node and everything downstream of it', () => {
  has(app, 'archivedCardIds', 'archive roots are recorded')
})

test('the plugin is called Chat Tree everywhere it is shown', () => {
  for (const [name, source] of [['app.js', app], ['client.js', client], ['index.js', host]]) {
    assert.ok(!source.includes('Work Tree'), `${name} still says Work Tree`)
  }
  has(app, '<strong>Chat Tree</strong>', 'the rail brand')
  has(client, '>Chat Tree</button>', 'the DSH switch')
  has(host, '<title>Chat Tree</title>', 'the page title')
})

test('the host injects one switch and one iframe, nothing else', () => {
  has(client, 'class="dsh-chattree-switch"', 'the view switch')
  has(client, 'src="/chattree/"', 'the canvas iframe')
})

test('a failed composer read parks instead of re-asking on the spot', () => {
  // render() calls syncComposer() on every pass, so the failure path must not clear
  // the request: doing that made one unreadable session re-ask from the very render
  // the error triggered, and the canvas locked up under thousands of full rebuilds a
  // second. The retry rides a slow clock instead.
  has(app, 'const COMPOSER_RETRY_MS = 5000', 'the retry clock')
  has(app, 'state.composer.failedFor !== sessionId || Date.now() < state.composer.retryAfter', 'syncComposer honours the retry clock')
  const start = app.indexOf("if (data.type === 'chattree:composer-error')")
  assert.ok(start > 0, 'the composer error branch is gone')
  const body = app.slice(start, start + 1400)
  assert.ok(!/requestedFor:\s*null/.test(body), 'the failure path clears the request and re-asks forever')
  has(body, 'retryAfter', 'the failure is parked on the retry clock')
})

test('a finished answer survives until the saved turn arrives', () => {
  // The stream record has to keep its text at running:false; test/stream.test.mjs runs the
  // real messagesFor() and proves what that then renders. Deleting the record here is the
  // bug that blanked the panel and clamped its scroll toward the top.
  has(app, 'state.liveReplies.set(data.sessionId, { running: false,', 'the finished text is dropped')
})

test('the panel follows the stream instead of only catching up at the end', () => {
  // inspectorFollow only updates on a scroll event, and text growing at the bottom fires
  // none -- so without this the flag went stale and the end-of-stream render pulled the
  // panel to the bottom even after the reader had scrolled away.
  const start = app.indexOf('function applyLiveReplyToInspector')
  assert.ok(start > 0, 'the live panel patch is gone')
  const body = app.slice(start, app.indexOf('\n}', start))
  has(body, 'state.inspectorFollow', 'the stream patch keeps the panel pinned while following')
  has(body, 'scroller.scrollTop = scroller.scrollHeight', 'the pinned panel follows each chunk')
})

test('the panel offers a way back to the bottom, and knows when to show it', () => {
  has(app, 'data-action="inspector-to-bottom"', 'the affordance is rendered')
  has(app, "button.dataset.action === 'inspector-to-bottom'", 'the click is handled')
  has(app, 'function syncInspectorJump(', 'its visibility is kept in step')
  // Straight on the DOM from the scroll listener: routing it through render() would rebuild
  // the shell once per scroll frame, which is exactly what the reader is fighting.
  has(app, '<= INSPECTOR_BOTTOM_SLACK\n  syncInspectorJump(scroller)', 'the scroll listener drives it')
  const jump = app.slice(app.indexOf('function syncInspectorJump('))
  const body = jump.slice(0, jump.indexOf('\n}'))
  has(body, 'pendingQuestion !== null', 'it stands down behind the question dialog')
  has(body, "classList.toggle('is-live'", 'the live pulse follows the stream')
})

test('the jump affordance is small, round and motion-safe', () => {
  has(css, '.inspector-jump { position: absolute;', 'it floats instead of taking a slot')
  has(css, '.inspector-jump[hidden] { display: none; }', 'hidden has to beat the grid display')
  has(css, 'animation: inspector-jump-ping', 'the live pulse')
  has(css, '.inspector-jump.is-live::after { display: none; }', 'reduced motion drops the ring instead of freezing it')
})

test('the jump button is rendered plain and dressed after the patch', () => {
  // It lives in the same region as the composer, so carrying the pulse or the hidden flag in its
  // markup made that region read as changed every time a reply started or stopped -- and the
  // patch then replaced the textarea, mid-sentence.
  const jump = app.slice(app.indexOf('function inspectorJumpButton()'))
  const body = jump.slice(0, jump.indexOf('\n}'))
  assert.ok(!body.includes('inspectorIsStreaming()'), 'the markup still carries the live pulse')
  assert.ok(!body.includes('state.inspectorFollow'), 'the markup still carries the hidden flag')
  has(app, "jump.classList.toggle('is-live', inspectorIsStreaming())", 'the pulse is set on the element')
})

test('compaction asks the Host for its own /compact and reports what came back', () => {
  // `/compact` is mounted by the agent preset, not by the Host, so a session is asked what it
  // has rather than assumed to have it -- and the guards (a turn in flight, nothing left to
  // compact) stay on the Host's side, where the history is.
  has(client, "commands.list(sessionId)", 'the session is asked which commands it has')
  has(client, "command?.name === 'compact'", 'availability is the command registry\'s answer')
  has(client, "commands.execute(sessionId, '/compact', [])", 'the compaction goes through /compact')
  has(client, "if (response?.value === undefined || response.value === null) throw new Error('这个会话没有 /compact 命令')", 'a registry that does not know the line is a missing capability')
  has(app, 'canCompact: data.canCompact === true', 'availability reaches the canvas')
  has(app, 'function composerCompactRow()', 'the menu renders the action')
  has(app, "data-action=\"composer-compact\"", 'the action is wired')
  has(app, 'if (sessionId === null || state.compacting || composerSessionBusy()) return', 'a turn in flight cannot start one')
  has(app, 'function composerSessionBusy()', 'the idle test mirrors the Host\'s')
  has(app, 'COMPACT_TIMEOUT_MS', 'a lost answer cannot leave the button claiming to work')
})

test('a failed compaction is said out loud, a finished one is left in the menu', () => {
  // The reader asked for this one, so its failure belongs where they can see it. Its success is
  // visible as the occupancy dropping, which is the whole reason they clicked.
  const failed = app.slice(app.indexOf("if (data.type === 'chattree:compact-failed')"))
  const body = failed.slice(0, failed.indexOf('\n  }'))
  has(body, 'setError(', 'a refused compaction is surfaced')
  const done = app.slice(app.indexOf("if (data.type === 'chattree:compacted')"))
  const settled = done.slice(0, done.indexOf('\n  }'))
  has(settled, 'state.compactNote', 'the finished one is reported in the menu')
  assert.ok(!settled.includes('setError('), 'a finished compaction raises a banner')
  has(settled, 'requestedFor: null', 'the occupancy is re-read, so the drop is visible')
})

test('the send row holds its three buttons on one line at any panel width', () => {
  // The panel floors at 360px, where the row has about 205px to work with. It must not wrap
  // (send would drop to a second line) and must not overflow, so the model's name is what gives
  // way: it shrinks to an icon, and the spacer keeps the group against send.
  has(css, '.composer-input-tools { display: flex; flex-wrap: nowrap;', 'the row wraps instead of shrinking')
  has(css, '.composer-tools-spacer { flex: 1;', 'the spacer is what puts the group at the right edge')
  const label = css.slice(css.indexOf('.composer-trigger-label {'))
  const rule = label.slice(0, label.indexOf('\n}'))
  has(rule, 'min-width: 0', 'the label cannot shrink')
  has(rule, 'text-overflow: ellipsis', 'a shrunken name is elided, not clipped')
  // The composer is a one-column grid, and an implicit column is content-sized -- so the row was
  // laid out at its own max-content width and pushed out of the panel on a narrow one.
  has(css, '.inspector-composer { grid-template-columns: minmax(0, 1fr); }', 'the column is pinned to the container')
  // The permission preset is read far more often than it is changed, so it is a bare shield.
  has(css, '.composer-trigger.is-compact {', 'the compact trigger has its own padding')
  const trigger = app.slice(app.indexOf('function composerTrigger('))
  const body = trigger.slice(0, trigger.indexOf('\n}'))
  has(body, 'labelled ?', 'the label is optional')
  has(body, 'composer-trigger-label', 'a labelled trigger still renders the element the name is written into')
  assert.ok(!body.includes('aria-label'), 'the name is written after the patch, not rendered into it')
})

test('the option buttons sit on the composer surface and only outline on hover', () => {
  // At rest they are their glyphs and nothing else; the shape arrives with the pointer. The
  // doubled class is not decoration: the row's own `.composer-tool` background, and the dark
  // override of it that sits later in the file, both have to lose to this.
  has(css, '.composer-input-tools .composer-trigger.composer-tool { background: transparent; }', 'the resting surface is the composer\'s own')
  has(css, '[data-theme="dark"] .composer-input-tools .composer-trigger.composer-tool { background: transparent; }', 'the dark row override does not reintroduce a pill')
  // One declaration block, and it fills nothing in: a background appearing here would undo the
  // whole point of the resting state.
  has(css, '.composer-input-tools .composer-trigger:hover:not(:disabled),\n.composer-input-tools .composer-trigger.is-open { border-color: var(--ct-border-strong); color: var(--ct-text-1); }', 'hover and open are one quiet outline')
})

test('one tone across the whole row', () => {
  // Every mark and label takes its colour from the button it sits in, so the paperclip, the
  // shield, the model mark, the name and the chevrons are all the same grey at rest and the same
  // darker grey under the pointer. Two tones is what made the row read as two toolbars.
  has(css, '.composer-trigger-icon { width: 13px; height: 13px; flex: none; fill: none; stroke: currentColor;', 'the trigger marks follow their button')
  has(css, '.composer-menu-chevron { width: 12px; height: 12px; flex: none; fill: none; stroke: currentColor;', 'so do the chevrons')
  has(css, '.composer-ring-fill { fill: none; stroke: currentColor;', 'the meter is in the same tone')
  has(css, '.composer-ring-glyph { fill: currentColor; stroke: none; }', 'and so is the mark inside it')
  has(css, '.inspector-composer .composer-attach.composer-tool { border-color: transparent; background: transparent; color: var(--ct-text-2); }', 'the paperclip is in it too')
  // The groove is the one thing that stays a step lighter, because that is what makes it a meter
  // rather than a filled dot, so it is deliberately not part of the unification.
  has(css, '.composer-ring-track { fill: none; stroke: var(--ct-border-strong);', 'the groove keeps its own tone')
  const row = css.slice(css.indexOf('.composer-input-tools {'), css.indexOf('.composer-menu {'))
  assert.ok(!row.includes('--ct-text-3'), 'a second glyph tone came back to the row')
})

test('the ring states its own box, so its mark is not squeezed out', () => {
  // `.inspector-composer button` is the send button's rule (`padding: 0 14px`, `min-height:
  // 30px`) and it applies to every button in the composer. Its padding alone was wider than the
  // ring button, so the svg inside was laid out 0px wide -- and with `overflow: hidden` it then
  // painted nothing at all, leaving the button invisible at rest. Reading the markup and the
  // attributes back could never catch that; only the box could.
  has(css, '.composer-input-tools .composer-trigger.composer-ring { width: 30px; min-width: 30px; height: 30px; padding: 0;', 'the ring box outranks the composer button rule')
  has(css, '.composer-ring-svg { width: 20px; height: 20px; flex: none; }', 'the mark cannot be shrunk away')
  has(app, 'const COMPOSER_RING_SIZE = 20', 'the ring is big enough to hold a mark')
  has(app, 'composer-ring-glyph', 'the mark is drawn')
})

test('a compaction checkpoint is a node of its own, never a question', () => {
  // DSH lands the checkpoint as an ordinary `user/message`. Nothing recognised it, so the canvas
  // drew it as a question nothing would ever answer: a node reading "等待助手回复" whose composer
  // was dead, because there was no answer under it to branch from.
  has(host, "if (isCheckpointText(text)) return noteProjection('compaction', checkpointSummary(text))", 'the host stores it as what it is')
  has(host, "const CHECKPOINT_OPENING = 'This is an automatically generated checkpoint", 'recognised by its opening line')
  has(host, "const CHECKPOINT_CLOSE_TAG = '</compacted-summary>'", 'the closing tag is its own literal, not the opening one')
  has(app, 'function threadMessages(thread)', 'the canvas re-labels one stored before that rule existed')
  has(app, "if (question.kind !== 'user' && question.kind !== 'compaction') continue", 'a checkpoint becomes its own turn')
  has(app, "if (reply.kind === 'user' || reply.kind === 'compaction') break", 'and is never swallowed as a reply')
  has(app, 'latestTurn.compaction !== true &&', 'a stream is never painted onto the marker')
  has(app, "const heading = card.compaction === true ? '上下文已压缩' : card.question", 'the card is headed by the label, not by the summary twice')
  has(app, 'if (card.compaction === true) {', 'the panel answers with a note instead of a dead input')
  has(app, 'composer-note', 'and that note exists')
})

test('a compaction node is the one yellow thing on the canvas', () => {
  has(css, '--ct-compaction: #d99a00;', 'a light-theme amber')
  has(css, '--ct-compaction: #e8b53f;', 'and a dark-theme one')
  has(css, '.thread-card.is-compaction {', 'the card is marked')
  has(css, '.thread-card.is-compaction .thread-card-head {', 'its header is tinted')
  has(css, '.thread-card.is-compaction .topic-dot { background: var(--ct-compaction); }', 'and so is its dot')
  has(css, '.dot-node.is-compaction { background: var(--ct-compaction); }', 'the dot canvas marks it too')
  has(css, '.composer-note {', 'the panel note is styled')
})

test('the rail is two levels: workspaces, and the canvases inside them', () => {
  has(app, 'function railModel()', 'the rail has a model of its own')
  has(app, 'data-action="toggle-rail-group"', 'a workspace row folds')
  has(app, 'data-workspace="${escapeHtml(group.workspace.id)}"', 'a canvas row names the workspace it lives in')
  has(app, 'selectCanvas(thread)', 'opening a canvas is one shared path, whichever row reached it')
  has(app, 'RAIL_OPEN_KEY', 'the folded state is remembered')
  has(app, 'const expanded = active || state.railOpen.has(workspace.id)', 'the active workspace is always open')
  // The active workspace's threads are already loaded; the others are read when opened, not on
  // every tick -- and never through the call that reports the canvas's archive set.
  has(app, 'state.railCache.set(workspace.id, await threadsForDshWorkspace(workspace, { recordArchive: false }))', 'a folded group is not read')
  has(app, 'async function threadsForDshWorkspace(workspace, { recordArchive = true } = {})', 'the archive side effect can be skipped')
  has(app, 'if (!recordArchive) return projections.flatMap(projection => projection.workspace.threads', 'and is skipped before it writes')
  // The dropdown it replaced is gone, along with its handler.
  assert.ok(!app.includes('select-workspace'), 'the workspace <select> is still wired')
  assert.ok(!app.includes('sidebar-heading'), 'the flat canvas heading is still rendered')
  assert.ok(!css.includes('workspace-select'), 'the dropdown styles are still here')
})

test('renaming either rail level goes through DSH', () => {
  // DSH owns both titles and keeps reporting them, so a name kept here would be overwritten by
  // the next thing DSH says -- and the reader would see one thing called two names.
  has(client, "if (event.data.type === 'chattree:rename-workspace')", 'the workspace rename is bridged')
  has(client, 'await workspace.rename({ workspaceId, title })', 'and asks DSH to rename it')
  has(client, "if (event.data.type === 'chattree:rename-canvas')", 'the canvas rename is bridged')
  has(client, 'await session.rename({ sessionId, title })', 'and asks DSH to rename the root session')
  has(client, "send('chattree:workspaces', { workspaces: workspaceSnapshot(ctx) })", 'the workspace list is taken from DSH again rather than patched')
  has(app, 'const title = threadListTitle(thread)', 'a canvas row is named by what DSH says, not by anything stored here')
})

test('the rename box is written after the patch, and holds the rail still', () => {
  // The box lives in a region that is patched as one string: a value in the markup would make
  // every keystroke change that string, and a patch while the reader is typing would replace the
  // box and take the caret with it. Both halves are the same rule the composer follows.
  const input = app.slice(app.indexOf('function railRenameInput('))
  assert.ok(!/value=/.test(input.slice(0, input.indexOf('\n}'))), 'the rename box renders its own value')
  has(app, 'input.value = state.railEdit.title', 'the value is written in after the patch')
  has(app, "if (state.railEdit !== null && sidebar.querySelector('.rail-rename') !== null) return", 'the region is left alone while a box is open')
  has(app, "if (!(input instanceof HTMLInputElement)) return\n  input.value = state.railEdit.title\n  input.focus()", 'and the box is focused once it is there')
  has(app, 'event.key === \'Escape\'', 'Escape drops the rename')
  has(app, 'commitRailRename()', 'leaving the box commits it')
})

test('the rail can add a workspace, and a new canvas asks which one', () => {
  // A canvas is a DSH session and every session needs a directory, so which workspace it goes in
  // is asked for rather than inferred from whatever was selected last.
  has(client, "if (event.data.type === 'chattree:add-workspace')", 'adding a workspace is bridged')
  has(client, 'picker.pick()', 'through the host directory chooser')
  has(client, 'await workspace.create({ path })', 'and the host registration')
  has(client, "cancelled: true", 'a cancelled chooser is not a failure')
  has(app, 'data-action="add-workspace"', 'the rail offers it')
  has(app, 'function railChooserHtml(rail)', 'the new-canvas chooser exists')
  has(app, 'data-action="choose-canvas-workspace"', 'each workspace is a choice')
  has(app, 'openNewSession(id, choice?.path)', 'the chosen workspace carries its directory')
  has(app, 'draft.workspaceId ?? state.selectedDshWorkspaceId', 'the draft decides where the canvas goes')
  has(app, 'draft.cwd ?? state.currentDsh?.cwd', 'and which directory it uses')
})
