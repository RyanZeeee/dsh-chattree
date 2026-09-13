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
  // A checkpoint is where the conversation continues from -- the next turn is seeded from it --
  // so it takes the ordinary composer. It used to be refused here on the grounds that nothing
  // answers it, which had it exactly backwards.
  has(app, 'const usable = Number.isInteger(card.forkSeq)', 'a checkpoint takes the ordinary composer')
  has(app, 'function lastTurnSeqBefore(messages, index)', 'and a cut of its own')
  has(app, 'const forkSeq = compaction ? lastTurnSeqBefore(messages, messageIndex) : answer?.sourceSeq', 'which is the turn before it, not the checkpoint')
  assert.ok(!app.includes('composer-note'), 'the dead-end note is back')
})

test('a compaction node is the one green thing on the canvas', () => {
  // Green, not yellow: the node marks where the conversation carries on from, with the summary as
  // the opening of whatever comes next. Yellow read as a warning about a dead end.
  has(css, '--ct-compaction: #2f9e44;', 'a light-theme green')
  has(css, '--ct-compaction: #57c877;', 'and a dark-theme one')
  assert.ok(!css.includes('#d99a00') && !css.includes('#e8b53f'), 'the amber face is back')
  has(css, '.thread-card.is-compaction {', 'the card is marked')
  has(css, '.thread-card.is-compaction .thread-card-head {', 'its header is tinted')
  has(css, '.thread-card.is-compaction .topic-dot { background: var(--ct-compaction); }', 'and so is its dot')
  has(css, '.dot-node.is-compaction { background: var(--ct-compaction); }', 'the dot canvas marks it too')
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

test('the rail offers DSH workspaces, and only DSH workspaces', () => {
  // The store's own workspace records are an internal grouping the canvas is loaded through --
  // nothing ever created one -- so the code that offered them as a choice is gone, and the list
  // route is read-only.
  assert.ok(!app.includes('function workspaceChoices'), 'the workspace picker is back')
  assert.ok(!app.includes("source: 'projection'"), 'the store-owned fallback is back')
  assert.ok(!/(^|[^A-Za-z])openWorkspace\(/m.test(app), 'the store-owned workspace loader is back')
  has(app, 'state.dshWorkspaces.filter(workspace => workspace.id !== UNGROUPED_WORKSPACE_ID || workspace.sessionIds.length > 0)', 'the rail reads DSH\'s own list, minus an empty catch-all')
  assert.ok(!host.includes('async create(title)'), 'store.create is back')
  assert.ok(!host.includes('store.create('), 'the workspace-create route is back')
  has(host, "if (path === '/chattree/api/workspaces' && req.method === 'GET')", 'the list route stays read-only')
})

test('a question is only ever sent down the branch path', () => {
  // Every question forks a new session, so a plain send had no caller at all: the panel and the
  // draft card both go through branchOff.
  assert.ok(!app.includes('async function sendMessage'), 'the unused send is back')
  has(app, 'async function branchOff(', 'the branch path is what sends')
  has(app, 'await branchOff(parent, draft.atSeq, draft.anchorId, text, branchPosition)', 'the draft card sends through it')
  has(app, 'await branchOff(thread, atSeq, card.id, text, position, card.compaction === true ? card.sourceSeq + 1 : atSeq)', 'and so does the panel')
})

test('every rail popover is anchored to the box it belongs to', () => {
  // An absolutely positioned box resolves against its nearest positioned ancestor. The workspace
  // chooser sat directly under `.sidebar`, which had no `position` at all, so its `top`/`left`
  // resolved against the viewport: it opened in the corner of the window rather than under the
  // button that opened it. Geometry is not something a unit test can see, so the anchors are what
  // is locked here.
  has(css, '.sidebar { position: relative;', 'the rail is not a positioning context')
  has(css, '.rail-new { position: relative; }', 'the new-canvas button is not one either')
  has(css, '.rail-workspace, .tree-item { position: relative; }', 'the rows are not positioning contexts')
  has(css, '.rail-more { position: absolute; z-index: 2; top: 50%; right: 2px; transform: translateY(-50%);', 'the row button is not centred on the row')
  has(css, '.rail-chooser { top: calc(100% + 6px);', 'the chooser does not hang off the button')
  has(app, '<div class="rail-new">', 'the chooser is not rendered beside its button')
})

test('every DSH namespace call is read out of its envelope', () => {
  // The gateway answers every namespace call with `{ok, value}` or `{ok, error}`. `pick` was the
  // one call read as if it answered the bare value, so the path handed to `workspace/create` was
  // the envelope object -- and DSH's strict request schema refused it with
  // `client api: workspace/create rejected "request"`, which is the popup that came of it.
  has(client, 'const picked = await picker.pick()', 'the chooser answer is not held as an envelope')
  has(client, 'const path = picked?.value', 'and its value is what is unwrapped')
  assert.ok(!/const path = await picker/.test(client), 'the chooser answer is used as a bare value again')
  // The bridge's other namespace calls. Each one checks `ok` before it reads a value; a call that
  // forgets is how the above got through.
  const calls = [
    { call: 'await commands.list(sessionId)', check: 'listed?.ok !== false' },
    { call: "await commands.execute(sessionId, '/compact', [])", check: 'response?.ok === false' },
    { call: 'await workspace.rename({ workspaceId, title })', check: 'response?.ok === false' },
    { call: 'await session.rename({ sessionId, title })', check: 'response?.ok === false' },
    { call: 'await picker.pick()', check: 'picked?.ok === false' },
    { call: 'await workspace.create({ path })', check: 'response?.ok === false' }
  ]
  for (const { call, check } of calls) {
    const at = client.indexOf(call)
    assert.notEqual(at, -1, `missing ${call}`)
    assert.ok(client.slice(at, at + 400).includes(check), `${call} does not check its envelope`)
  }
})

test('the dot face opens at its own distance, and the canvas follows it there', () => {
  // The two faces are read at different distances -- cards have to be legible, a dot graph is
  // taken in at a glance -- so they do not share a zoom. 10% is both how far out the dots may be
  // zoomed and where they open.
  has(app, 'const ZOOM_MIN_DOT = .1', 'the dot floor moved')
  has(app, "zoom: savedCanvasStyle === 'dot' ? ZOOM_MIN_DOT : 1", 'a saved dot face opens at card distance')
  has(app, "state.zoom = next === 'dot' ? ZOOM_MIN_DOT : clampZoom(state.cardZoom)", 'switching to the dots no longer opens at 10%')
  has(app, "if (next === 'dot') state.cardZoom = state.zoom", 'the card distance is not kept for the way back')
  // Setting the distance is only half of it: a camera offset calibrated for legible cards puts the
  // graph above the viewport once the canvas is read at 10%, so the view is re-anchored as well.
  has(app, "if (resized && state.mode === 'canvas') window.requestAnimationFrame(() => focusActiveCard())", 'the canvas is not re-anchored after a style change')
  // The constants are read while the initial state is built, so they must be declared before it.
  assert.ok(app.indexOf('const ZOOM_MIN_DOT') < app.indexOf('zoom: savedCanvasStyle'), 'the zoom constants are declared after the state that reads them')
})

test('a full rail scrolls, and its popovers survive the scroll region', () => {
  // The rail had no scroll container at all: a full list overflowed the sidebar, the shell clipped
  // it, and the rows past the fold were neither visible nor reachable by any gesture.
  has(app, '<div class="rail-scroll">', 'the groups are not in a scroll region')
  has(css, 'flex: 1 1 auto; min-height: 0;', 'the region cannot shrink, which is what makes it scroll rather than overflow')
  has(css, 'overflow-y: auto; overflow-x: hidden;', 'the cross axis is not pinned, and auto on one axis clips the other too')
  assert.ok(app.indexOf('<div class="rail-scroll">') > app.indexOf('class="rail-head"'), 'the heading scrolls away with the list')
  // Rewriting the region rebuilds the container, which would drop the reader back to the top.
  has(app, "const scrolled = sidebar.querySelector('.rail-scroll')?.scrollTop ?? 0", 'the scroll position is not read before the patch')
  has(app, "if (scroller instanceof HTMLElement && scrolled > 0) scroller.scrollTop = scrolled", 'and not put back after it')
  // A row at the bottom has no room below it inside that region, so the menu turns upwards -- which
  // can only be decided by measuring, after the patch.
  has(css, '.rail-menu.is-above { top: auto; bottom: calc(100% + 2px); }', 'the menu has no upward face')
  has(app, 'function syncRailMenu(sidebar)', 'nothing measures where a menu has room')
  has(app, "menu.classList.toggle('is-above', !fitsBelow && fitsAbove)", 'the measurement decides nothing')
  // A group is read out of the store's workspace list, so it must not be read before that list is
  // known: an empty answer cached then stood as the group's answer for the rest of the session.
  has(app, '&& state.summaries.length > 0) void loadRailGroup(workspace)', 'a group is read before the list it reads out of')
  has(app, 'if (changed) state.railCache.clear()', 'a changed workspace list leaves every group stale')
})

test('the manifest declares the compatibility the store reads', () => {
  // DSH STORE's automatic lane requires both, and reads the DSH matrix out of this block: an
  // absent one is why the entry was blocked with "DSH compatibility is not explicitly declared".
  const manifest = JSON.parse(read('package.json'))
  assert.ok(manifest.engines?.node, 'no Node range declared')
  assert.equal(manifest.dsh?.compatibility?.dshReleases?.['0.1.5-rc.1'], 'compatible', 'the harness this is built against is not declared compatible')
  // node-semver only lets a prerelease satisfy a range when some comparator shares its exact
  // major.minor.patch tuple and carries a prerelease tag, so the range has to name it.
  assert.ok(manifest.dsh.compatibility.dsh.includes('0.1.5-rc.1'), `the range does not name the prerelease it claims: ${manifest.dsh.compatibility.dsh}`)
  // The store accepts only these three words.
  for (const [version, status] of Object.entries(manifest.dsh.compatibility.dshReleases)) {
    assert.ok(['compatible', 'incompatible', 'unknown'].includes(status), `${version}: ${status}`)
  }
  // A bundle patch is what makes the plugin installable at all; `dsh.client` alone is not.
  assert.ok(manifest.dsh.bundle?.patch, 'the bundle patch declaration is gone')
})

test('both READMEs state the same permissions and bounds', () => {
  // The store asks for dependencies, permissions, external services and failure bounds in writing.
  for (const [path, heading] of [['README.md', '## 权限与边界'], ['docs/en/README.md', '## Permissions and bounds']]) {
    const text = read(path)
    has(text, heading, `${path} has no permissions section`)
    for (const claim of ['workspaces.json', 'trustedHosts', '403']) {
      has(text, claim, `${path} does not state ${claim}`)
    }
  }
})
