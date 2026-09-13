const app = document.querySelector('#app')

// The agent's pending question, mirrored from the DSH page bridge. `selected`
// maps a question id to chosen option labels, `custom` to typed answers; both
// survive a re-render so a live reply cannot wipe what the user is typing.
let pendingQuestion = null
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
const LEGACY_CARD_POSITIONS_KEY = 'dsh-chattree:card-positions'
const CARD_POSITIONS_KEY = 'dsh-chattree:card-positions:v3'
const COLLAPSED_CARDS_KEY = 'dsh-chattree:collapsed-cards:v1'
const QUICK_PHRASES_KEY = 'dsh-chattree:quick-phrases:v1'
const INSPECTOR_WIDTH_KEY = 'dsh-chattree:inspector-width:v1'
const CANVAS_STYLE_KEY = 'dsh-chattree:canvas-style:v1'   // 'card' | 'dot'
// The panel can be dragged wider, but it must never cover the whole map, so the
// drag stops this far short of the left edge.
const INSPECTOR_MIN_WIDTH = 360
const INSPECTOR_EDGE_GAP = 72
// The reader counts as "at the bottom" within this many pixels, so a sub-pixel layout
// remainder never reads as having scrolled away. The follow rule and the jump-to-bottom
// affordance share it, because they have to agree on what "at the bottom" means.
const INSPECTOR_BOTTOM_SLACK = 24
const DEFAULT_QUICK_PHRASES = ['展开说明', '举例', '通俗易懂', '对比解释']
const MAX_QUICK_PHRASES = 12
const MAX_QUICK_PHRASE_LENGTH = 16
function normalizeQuickPhrases(value) {
  if (!Array.isArray(value)) return []
  const phrases = []
  for (const item of value) {
    const phrase = typeof item === 'string' ? item.trim().slice(0, MAX_QUICK_PHRASE_LENGTH) : ''
    if (phrase !== '' && !phrases.includes(phrase)) phrases.push(phrase)
    if (phrases.length === MAX_QUICK_PHRASES) break
  }
  return phrases
}
// The canvas has two faces: cards, or the minimal dot graph. The choice is a view
// preference, so it is remembered like the other ones.
const savedCanvasStyle = (() => {
  try { return localStorage.getItem(CANVAS_STYLE_KEY) === 'dot' ? 'dot' : 'card' } catch { return 'card' }
})()

const savedQuickPhrases = (() => {
  try {
    const stored = localStorage.getItem(QUICK_PHRASES_KEY)
    return stored === null ? DEFAULT_QUICK_PHRASES : normalizeQuickPhrases(JSON.parse(stored))
  } catch { return DEFAULT_QUICK_PHRASES }
})()
const savedInspectorWidth = (() => {
  try {
    const stored = Number.parseFloat(localStorage.getItem(INSPECTOR_WIDTH_KEY) ?? '')
    return Number.isFinite(stored) ? Math.max(INSPECTOR_MIN_WIDTH, stored) : null
  } catch { return null }
})()

// Which workspaces the rail has open. A workspace is a folder in the tree, not a mode the
// reader is in: clicking one folds it, and the canvas follows whichever canvas was clicked.
const RAIL_OPEN_KEY = 'dsh-chattree:rail-open:v1'
const savedRailOpen = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(RAIL_OPEN_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter(id => typeof id === 'string') : []
  } catch { return [] }
})()
function persistRailOpen() {
  try { localStorage.setItem(RAIL_OPEN_KEY, JSON.stringify([...state.railOpen])) } catch { /* Private browsing may disable local storage. */ }
}
// Branch anchors and collapse roots used to be remembered here, keyed by card ids that
// have since been re-keyed (see the id comment in conversationCards). Neither is worth
// migrating: a branch's fork point has a durable server-side record (sourceSeedLength)
// and the remembered anchor was only ever a fallback for it, and nothing in the UI can
// create a collapse any more. Drop the stored copies instead of carrying dead ids.
const savedBranchAnchors = (() => {
  try { localStorage.removeItem('dsh-chattree:branch-anchors') } catch { /* storage may be unavailable */ }
  return []
})()
const savedCardPositions = (() => {
  try {
    // Drop formats that were never persisted; the current key stores drags.
    localStorage.removeItem(LEGACY_CARD_POSITIONS_KEY)
    localStorage.removeItem('dsh-chattree:card-positions:v2')
    const value = JSON.parse(localStorage.getItem(CARD_POSITIONS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter(item => Array.isArray(item) && typeof item[0] === 'string' && item[1] !== null && Number.isFinite(item[1].x) && Number.isFinite(item[1].y)) : []
  } catch { return [] }
})()
const savedCollapsedCards = (() => {
  try { localStorage.removeItem(COLLAPSED_CARDS_KEY) } catch { /* storage may be unavailable */ }
  return []
})()
const CARD_WIDTH = 260
const CARD_HEIGHT = 380
const CARD_GAP_Y = 42
const CARD_GAP_X = 56
const CAMERA_INSET_X = 56
const CAMERA_INSET_Y = 56
// Cards outside the viewport (plus this world-space margin) are not mounted
// into the DOM; the margin pre-mounts cards just before they scroll into view
// so panning never flashes empty space.
const VIEWPORT_MARGIN = 1400
const state = {
  summaries: [], workspace: null, activeId: null, selectedCardId: null, mode: 'canvas', zoom: 1, currentDsh: null, sidebarCollapsed: false,
  dshWorkspaces: [], selectedDshWorkspaceId: null,
  historyBySession: new Map(), historyRequests: new Map(), pendingReplies: new Map(), pendingRpc: new Map(), liveReplies: new Map(),
  draft: null, error: '', workspaceLoad: 0, branchAnchors: new Map(savedBranchAnchors), cardPositions: new Map(savedCardPositions), cardPositionsResetAt: 0, collapsedCardIds: new Set(savedCollapsedCards), quickPhrases: savedQuickPhrases, quickPhraseEditorOpen: false, canvasStyle: savedCanvasStyle,
  railOpen: new Set(savedRailOpen), railCache: new Map(), railLoading: new Set(), railEdit: null, railMenu: null, railChooser: false,
  dragging: false, canvasGesture: false, canvasRefreshAfter: 0, canvasViewInitialized: false, canvasCamera: { x: 0, y: 0 }, mapCardSessionSwitches: new Set(),
  canvasCards: undefined, canvasCardsById: undefined, canvasGraph: undefined, mountedCardIds: new Set(), canvasNeedsCenter: false, highlightCardIds: new Set(),
  inspectorCardId: null, inspectorOpening: false, inspectorInputs: new Map(), inspectorSending: false, inspectorWidth: savedInspectorWidth, composer: { requestedFor: null, requestId: null, failedFor: null, retryAfter: 0, sessionId: null, models: [], model: null, catalogError: null, permissions: [], permission: null, context: null, breakdown: null, canCompact: false }, attachments: [], attaching: false, composerMenu: null, composerConfirmPreset: null, compacting: false, compactNote: null, inspectorFollow: true, inspectorThreadId: null, inspectorFollowNewest: false, inspectorRendered: false, focusThreadId: null, focusCardId: null, focusRequestedAt: 0,
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
const formatTime = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const threadListTitle = thread => thread.dshSessionTitle ?? thread.title ?? questionFor(thread)
// The root a conversation grows from: walk parentId up until it stops, guarding
// against a malformed cycle so a bad projection can never hang the render.
function canvasRootOf(thread, byId) {
  let current = thread
  const seen = new Set([thread.id])
  for (let hop = 0; hop < 64; hop++) {
    const parentId = current.parentId
    if (parentId === null || parentId === undefined) break
    const parent = byId.get(parentId)
    if (parent === undefined || seen.has(parent.id)) break
    seen.add(parent.id)
    current = parent
  }
  return current
}

// One entry per canvas: a lineage is listed while any of its conversations still
// owns a card the board can draw, so archiving a whole lineage removes its entry
// and archiving part of one keeps it. conversationCards() is the same call the
// canvas makes, so the rail and the canvas cannot disagree.
function listedCanvases(threads) {
  if (threads.length === 0) return []
  const byId = new Map(threads.map(thread => [thread.id, thread]))
  const drawn = new Set(conversationCards(threads).map(card => card.dshThreadId))
  const canvases = []
  const seen = new Set()
  for (const thread of threads) {
    const root = canvasRootOf(thread, byId)
    if (seen.has(root.id)) continue
    seen.add(root.id)
    let live = false
    for (const member of threads) {
      if (canvasRootOf(member, byId).id !== root.id) continue
      if (drawn.has(member.id)) live = true
    }
    if (live) canvases.push(root)
  }
  return canvases
}

function rememberBranchAnchor(sessionId, cardId) {
  state.branchAnchors.set(sessionId, cardId)
  try { localStorage.setItem('dsh-chattree:branch-anchors', JSON.stringify([...state.branchAnchors])) } catch { /* Private browsing may disable local storage. */ }
}

// The card a branch started at message `atSeq` hangs off.
function branchAnchorCardId(threadId, atSeq) {
  const cards = conversationCards(state.workspace?.threads ?? []).filter(card => card.dshThreadId === threadId)
  if (cards.length === 0) return undefined
  if (!Number.isInteger(atSeq)) return cards.at(-1).id
  const exact = cards.find(card => card.answer?.sourceSeq === atSeq)
  if (exact !== undefined) return exact.id
  return (cards.filter(card => Number.isInteger(card.sourceSeq) && card.sourceSeq < atSeq).at(-1) ?? cards[0]).id
}

function persistCardPositions() {
  try { localStorage.setItem(CARD_POSITIONS_KEY, JSON.stringify([...state.cardPositions])) } catch { /* Private browsing may disable local storage. */ }
}

function persistCollapsedCards() {
  try { localStorage.setItem(COLLAPSED_CARDS_KEY, JSON.stringify([...state.collapsedCardIds])) } catch { /* Private browsing may disable local storage. */ }
}

function persistQuickPhrases() {
  try { localStorage.setItem(QUICK_PHRASES_KEY, JSON.stringify(state.quickPhrases)) } catch { /* Private browsing may disable local storage. */ }
}

function rememberCardPosition(cardId, position, aliases = []) {
  // A drop that lands right after 整理 belongs to the arrangement that was just thrown
  // away, so it is dropped with it instead of resurrecting the old position.
  if (Date.now() - (state.cardPositionsResetAt ?? 0) < 400) return
  state.cardPositions.set(cardId, { x: Math.round(position.x), y: Math.round(position.y) })
  for (const alias of aliases) state.cardPositions.set(alias, { x: Math.round(position.x), y: Math.round(position.y) })
  persistCardPositions()
}

function resetCardPositions() {
  // 整理 must win even when a drag is still settling: the drop that raced the button
  // would otherwise write its position straight back into the map we just cleared, and
  // the canvas would snap back to the old arrangement on the next render.
  state.cardPositions.clear()
  state.cardPositionsResetAt = Date.now()
  persistCardPositions()
  try {
    localStorage.removeItem(LEGACY_CARD_POSITIONS_KEY)
    localStorage.removeItem('dsh-chattree:card-positions:v2')
  } catch { /* Private browsing may disable local storage. */ }
}

function resetCanvasCamera() {
  state.canvasViewInitialized = false
  state.canvasCamera = { x: 0, y: 0 }
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? '请求失败')
  return body
}

function post(type, payload = {}) {
  if (window.parent !== window) window.parent.postMessage({ source: 'dsh-chattree', type, ...payload }, window.location.origin)
}

function dshRpc(type, payload = {}) {
  if (window.parent === window) return Promise.reject(new Error('请从 DSH 页面打开 Chat Tree 后再操作会话'))
  const requestId = crypto.randomUUID()
  post(type, { requestId, ...payload })
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      state.pendingRpc.delete(requestId)
      reject(new Error('DSH 未在规定时间内响应'))
    }, 20_000)
    state.pendingRpc.set(requestId, { resolve, reject, timer })
  })
}

function settleRpc(requestId, value, error) {
  const pending = state.pendingRpc.get(requestId)
  if (pending === undefined) return
  state.pendingRpc.delete(requestId)
  window.clearTimeout(pending.timer)
  if (error === undefined) pending.resolve(value)
  else pending.reject(error instanceof Error ? error : new Error(String(error)))
}

function setError(error = '') { state.error = error instanceof Error ? error.message : error; render() }

function messagesFromEvents(events) {
  if (!Array.isArray(events)) return []
  return events.flatMap(event => {
    const content = event?.data?.message?.content ?? event?.data?.content
    const text = Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).filter(Boolean).join('\n') : ''
    if (event?.type === 'user/message' && text && !text.startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.')) return [{ kind: 'user', text, at: event.time, sourceSeq: event.seq }]
    if (event?.type === 'assistant/message' && text) return [{ kind: 'assistant', text, at: event.time, sourceSeq: event.seq }]
    return []
  })
}

async function loadThreadHistory() {}

function canReplaceView() {
  return state.draft === null && !state.dragging && !state.canvasGesture && Date.now() >= state.canvasRefreshAfter && !document.activeElement?.matches('textarea')
}

function deferCanvasRefresh(delay = 700) {
  state.canvasRefreshAfter = Math.max(state.canvasRefreshAfter, Date.now() + delay)
}

function currentDshWorkspace() {
  const id = state.currentDsh?.id
  return typeof id === 'string' ? state.dshWorkspaces.find(workspace => workspace.sessionIds.includes(id)) : undefined
}

function selectedDshWorkspace() {
  return state.dshWorkspaces.find(workspace => workspace.id === state.selectedDshWorkspaceId)
}

function currentDshThread(threads = state.workspace?.threads ?? []) {
  const id = state.currentDsh?.id
  return typeof id === 'string' ? threads.find(thread => thread.dshSessionId === id) : undefined
}

// DSH's synthesised catch-all workspace, which is never offered as a choice.
const UNGROUPED_WORKSPACE_ID = 'dsh-ungrouped'

function workspaceChoices() {
  if (state.dshWorkspaces.length > 0) return state.dshWorkspaces.map(workspace => ({ ...workspace, source: 'dsh' }))
  return state.summaries.map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.cwd, sessionIds: [], source: 'projection' }))
}

// ---------------------------------------------------------------------------
// The rail: workspaces, and the canvases that live in them
//
// A workspace is a directory DSH knows about; a canvas is one conversation family -- the root
// session and every branch hanging off it. The two levels are both DSH's, so the rail never
// invents a name or a grouping of its own: the workspace title is DSH's, the canvas title is its
// root session's title, and both are renamed through DSH.
//
// Only the canvas's own workspace is held in memory (state.workspace). The rest are fetched when
// a group is opened and kept in railCache, so a rail with ten workspaces does not read ten
// workspaces on every tick.
// ---------------------------------------------------------------------------

// The active workspace's threads are already loaded, so its group never needs a fetch; the rest
// are read once and remembered. A group that is open, unloaded and not already loading starts
// its own load -- guarded by railLoading so a failing read cannot become a render loop.
function railModel() {
  const activeWorkspaceId = state.selectedDshWorkspaceId
  return workspaceChoices().map(workspace => {
    const active = workspace.id === activeWorkspaceId
    const ownThreads = state.workspace !== null && state.workspace.id === `dsh:${workspace.id}` ? state.workspace.threads : null
    const expanded = active || state.railOpen.has(workspace.id)
    const cached = ownThreads ?? state.railCache.get(workspace.id) ?? null
    if (expanded && cached === null && !state.railLoading.has(workspace.id)) void loadRailGroup(workspace)
    return {
      workspace,
      active,
      expanded,
      loading: cached === null,
      canvases: cached === null ? [] : listedCanvases(cached)
    }
  })
}

async function loadRailGroup(workspace) {
  state.railLoading.add(workspace.id)
  try {
    state.railCache.set(workspace.id, await threadsForDshWorkspace(workspace, { recordArchive: false }))
  } catch (error) {
    // An empty group rather than a perpetual "loading": the banner carries the reason.
    state.railCache.set(workspace.id, [])
    setError(error)
  } finally {
    state.railLoading.delete(workspace.id)
    if (canReplaceView()) render()
  }
}

// Reading another workspace's threads for the rail must not touch the archive set: that
// variable is what the *canvas's* workspace load reports, and overwriting it from a second
// workspace would make the canvas inherit the wrong archive the next time it opens.
async function threadsForDshWorkspace(workspace, { recordArchive = true } = {}) {
  if (workspace.sessionIds.length === 0) return []
  const requested = new Set(workspace.sessionIds)
  const projections = await Promise.all(state.summaries.map(summary => api(`/chattree/api/workspaces/${summary.id}`)))
  // The same response carries the archive set, so record it as it goes past. The
  // host is the record; page memory is only a cache for the renders in between.
  const roots = []
  for (const projection of projections) {
    const ids = projection.workspace.archivedCardIds
    if (Array.isArray(ids) && ids.length > 0) roots.push(...ids)
  }
  if (!recordArchive) return projections.flatMap(projection => projection.workspace.threads.filter(thread => requested.has(thread.dshSessionId)))
  fetchedArchiveRoots = roots
  return projections.flatMap(projection => projection.workspace.threads.filter(thread => requested.has(thread.dshSessionId)))
}

// Archive roots per workspace, so a workspace object rebuilt from DSH state can
// inherit them instead of losing the archive.
const archivedRootsByWorkspace = new Map()
// What the most recent workspace fetch reported. The server owns this list; this is
// the copy the render that follows the fetch reads, so a reload cannot resurrect
// archived cards by starting from an empty in-memory cache.
let fetchedArchiveRoots = []

function rememberArchiveRoots(workspaceId, roots) {
  if (typeof workspaceId === 'string' && Array.isArray(roots)) archivedRootsByWorkspace.set(workspaceId, roots)
}

async function openDshWorkspace(id, { renderAfter = true, preserveCanvasCamera = false } = {}) {
  const workspace = state.dshWorkspaces.find(item => item.id === id)
  if (workspace === undefined) return false
  const load = ++state.workspaceLoad
  state.selectedDshWorkspaceId = id
  const threads = await threadsForDshWorkspace(workspace)
  if (load !== state.workspaceLoad) return true
  const nextWorkspaceId = `dsh:${workspace.id}`
  if (state.workspace?.id !== nextWorkspaceId && !preserveCanvasCamera) resetCanvasCamera()
  const carriedRoots = fetchedArchiveRoots.length > 0
    ? fetchedArchiveRoots
    : state.workspace?.id === nextWorkspaceId && Array.isArray(state.workspace.archivedCardIds)
      ? state.workspace.archivedCardIds
      : archivedRootsByWorkspace.get(nextWorkspaceId) ?? []
  state.workspace = { id: nextWorkspaceId, title: workspace.title, cwd: workspace.path, threads, archivedCardIds: carriedRoots }
  const currentThread = currentDshThread(state.workspace.threads)
  // A projection refresh runs after every send, fork and poll. `activeId` is what tells the
  // canvas which conversation it is showing, so adopting DSH's current session here moved
  // the view whenever a refresh landed after the canvas had switched on its own -- creating
  // a branch, or clicking a node. DSH's session is only followed when the conversation the
  // canvas was showing is no longer in the workspace at all.
  const activeStillListed = state.workspace.threads.some(thread => thread.id === state.activeId)
  if (!activeStillListed) {
    state.activeId = currentThread?.id ?? state.workspace.threads[0]?.id ?? null
  }
  if (currentThread !== undefined) revealConversationThread(conversationCards(state.workspace.threads), currentThread.id)
  if (renderAfter && canReplaceView()) render()
  await Promise.all(state.workspace.threads.map(thread => loadThreadHistory(thread, false)))
  if (renderAfter && load === state.workspaceLoad && canReplaceView()) render()
  return true
}

async function openCurrentWorkspace({ preserveCanvasCamera = false } = {}) {
  const workspace = currentDshWorkspace()
  if (workspace === undefined || workspace.id === state.selectedDshWorkspaceId) return false
  return openDshWorkspace(workspace.id, { preserveCanvasCamera })
}

async function refreshSummaries({ renderAfter = true } = {}) {
  const before = JSON.stringify(state.summaries)
  const body = await api('/chattree/api/workspaces')
  state.summaries = body.workspaces
  const changed = before !== JSON.stringify(state.summaries)
  const current = state.workspace?.id
  if (state.selectedDshWorkspaceId === null && current !== null && !state.summaries.some(item => item.id === current)) state.workspace = null
  const selected = selectedDshWorkspace()
  if (selected !== undefined && (changed || state.workspace === null)) await openDshWorkspace(selected.id, { renderAfter })
  else if (state.workspace === null && state.summaries.length > 0) await openWorkspace(state.summaries[0].id)
  else if (renderAfter && changed && canReplaceView()) render()
  return changed
}

async function openWorkspace(id, { renderAfter = true, preserveCanvasCamera = false } = {}) {
  const load = ++state.workspaceLoad
  const body = await api(`/chattree/api/workspaces/${id}`)
  if (load !== state.workspaceLoad) return
  if (state.workspace?.id !== body.workspace.id && !preserveCanvasCamera) resetCanvasCamera()
  state.workspace = body.workspace
  rememberArchiveRoots(body.workspace.id, body.workspace.archivedCardIds)
  state.activeId = state.workspace.threads.some(thread => thread.id === state.activeId) ? state.activeId : state.workspace.threads[0]?.id ?? null
  if (renderAfter && canReplaceView()) render()
  await Promise.all(state.workspace.threads.map(thread => loadThreadHistory(thread, false)))
  if (renderAfter && load === state.workspaceLoad && canReplaceView()) render()
}

async function refreshProjection() {
  const summariesChanged = await refreshSummaries({ renderAfter: false })
  if (!summariesChanged || state.workspace === null || !canReplaceView()) return summariesChanged
  // A refresh is not a workspace switch: it must never re-frame the canvas the user is
  // working in, even if the projection reports a different workspace for a moment.
  if (state.selectedDshWorkspaceId !== null) await openDshWorkspace(state.selectedDshWorkspaceId, { preserveCanvasCamera: true })
  else await openWorkspace(state.workspace.id, { preserveCanvasCamera: true })
  return true
}

// Open one canvas: its lineage becomes what the board draws, the camera re-frames to it, and
// DSH is told which session is current so the two surfaces agree. Shared by the rail row and the
// card click, because a canvas reached from another workspace has to do exactly the same thing.
function selectCanvas(thread) {
  state.mapCardSessionSwitches.clear()
  state.activeId = thread.id
  state.selectedCardId = null
  state.inspectorCardId = null
  state.inspectorOpening = false
  state.error = ''
  // Choosing a conversation leaves any new-session canvas behind.
  if (state.draft?.kind === 'new') state.draft = null
  if (state.workspace !== null) revealConversationThread(conversationCards(state.workspace.threads), thread.id)
  // Each canvas is its own coordinate space, so the camera left over from the previous one
  // framed empty space. Centre on this canvas's cards, the way 定位 does, once they are mounted.
  state.canvasViewInitialized = false
  render()
  window.requestAnimationFrame(() => focusActiveCard())
  void loadThreadHistory(thread)
  // Bidirectional current-session sync: switch DSH's current session without closing the map;
  // the client confirms via chattree:current-session.
  if (thread.dshSessionId !== null) post('chattree:activate-session', { sessionId: thread.dshSessionId })
}

// `workspaceId` and `cwd` are the workspace the reader picked for this canvas. They ride on the
// draft rather than being read from whatever is selected, so a canvas made in one workspace does
// not depend on what the board happened to be showing.
function openNewSession(workspaceId, cwd) {
  if (state.draft !== null) return
  state.mode = 'canvas'
  state.activeId = null
  state.selectedCardId = null
  state.inspectorCardId = null
  state.inspectorOpening = false
  state.quickPhraseEditorOpen = false
  state.draft = { kind: 'new', text: '', sending: false, ...workspaceId === undefined ? {} : { workspaceId }, ...cwd === undefined ? {} : { cwd } }
  state.error = ''
  resetCanvasCamera()
  render()
  window.setTimeout(() => document.querySelector('[data-draft] textarea')?.focus(), 0)
}

// Archive the node the button sits on, and with it every turn and branch that
// comes after it. The DSH session is never touched -- this only decides what the
// canvas draws.
async function archiveCard(card) {
  if (!window.confirm('归档这个节点以及它之后的内容？DSH 原会话会保留，可在 DSH 内继续查看。')) return
  try {
    await api(`/chattree/api/threads/${card.dshThreadId}/archive`, { method: 'POST', body: JSON.stringify({ cardIds: [card.id] }) })
  } catch (error) {
    // Never swallow this: a rejected request used to vanish into an unhandled
    // rejection and the button looked dead.
    setError(`归档失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (state.workspace !== null) {
    const archived = new Set(state.workspace.archivedCardIds ?? [])
    archived.add(card.id)
    state.workspace.archivedCardIds = [...archived]
    rememberArchiveRoots(state.workspace.id, state.workspace.archivedCardIds)
  }
  // Archiving a node hides it, so a panel showing it has nothing left to show.
  state.inspectorCardId = null
  state.inspectorThreadId = null
  state.inspectorFollowNewest = false
  state.inspectorOpening = false
  if (state.selectedCardId === card.id) state.selectedCardId = null
  state.error = ''
  render()
  // Re-read from the host as well: the server is the record of what is archived,
  // so the canvas can never drift from it if a local update is ever skipped.
  void refreshProjection()
}function focusDraftInput() {
  const input = document.querySelector('[data-draft] textarea')
  if (!(input instanceof HTMLTextAreaElement)) return
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}

// There is one kind of follow-up: a branch. Every question asked of a card forks a new
// DSH session from that card, so a branch and a follow-up are the same act and the old
// "continue in the same session" path is gone.
function openContinue(parent, anchorId = undefined, text = '') {
  if (parent.dshSessionId === null) return setError('该节点没有关联的 DSH 会话')
  state.activeId = parent.id
  state.quickPhraseEditorOpen = false
  state.draft = { kind: 'branch', parentId: parent.id, anchorId, text, sending: false }
  render()
  window.setTimeout(focusDraftInput, 0)
}

function openBranch(parent, atSeq = undefined, anchorId = undefined) {
  if (parent.dshSessionId === null) return setError('该节点没有关联的 DSH 会话')
  state.activeId = parent.id
  state.quickPhraseEditorOpen = false
  state.draft = { kind: 'branch', parentId: parent.id, atSeq, anchorId, text: '', sending: false }
  render()
  window.setTimeout(() => document.querySelector('[data-draft] textarea')?.focus(), 0)
}

// Hand the panel to a line so it reads that line's newest turn from now on. Sending is the
// only thing that does this; clicking a node pins the panel instead.
//
// The card the panel was reading is dropped on purpose. It belongs to the conversation the
// question was sent *from*, and prepareCanvas() re-derives the panel's thread from whatever
// card it is showing -- so leaving it behind put the panel straight back on the old turn the
// moment the question went out. A turn now keeps its id from the moment it is asked for, so
// nothing later undid that either: the new question and its answer stayed invisible until the
// reader clicked the new node. Following the line, with no card pinned, is what makes the
// turn that was just asked for the one the panel resolves to.
function handPanelToLine(threadId) {
  state.inspectorThreadId = threadId
  state.inspectorFollowNewest = true
  state.inspectorCardId = null
}

// After a follow-up or a branch, the selection should land on the turn that was just asked
// for. This remembers the line; carryOutPendingFocus() performs the hand-over on the next
// render, once the canvas holds a card for it.
function requestFocusNewest(threadId) {
  const newest = (state.canvasCards ?? []).filter(card => card.dshThreadId === threadId).at(-1)
  state.focusThreadId = threadId
  state.focusCardId = newest?.id ?? null
  state.focusRequestedAt = Date.now()
}

function carryOutPendingFocus() {
  if (state.focusThreadId === null) return
  // A request that never found its card must not yank the viewport much later.
  if (Date.now() - state.focusRequestedAt > 15000) { state.focusThreadId = null; return }
  const newest = (state.canvasCards ?? []).filter(card => card.dshThreadId === state.focusThreadId).at(-1)
  if (newest === undefined) return
  // The job is landing on the turn the question was sent to -- not spotting a turn that did
  // not exist yet. A turn used to change its id as soon as its reply was saved, so comparing
  // ids happened to notice the new one; now the id is there from the moment the question is
  // asked, and comparing ids alone concluded there was nothing to do. The panel then stayed
  // on the turn it had been sent from until the reader clicked the new node.
  if (newest.id === state.focusCardId && state.selectedCardId === newest.id) { state.focusThreadId = null; return }
  state.focusCardId = newest.id
  state.focusThreadId = null
  // The node just created becomes the selected one and an open panel follows it, so the
  // question that was sent -- and the reply streaming into it -- are what you are reading.
  // The canvas itself is deliberately left where the user put it: re-centring here moved
  // the view exactly like pressing 定位, which is disorienting right after asking a
  // question. 定位 is there for when a new branch should be brought into view.
  state.activeId = newest.dshThreadId
  state.selectedCardId = newest.id
  if (state.inspectorCardId !== null) {
    state.inspectorCardId = newest.id
    state.inspectorOpening = false
    state.inspectorFollow = true
  }
}

async function sendMessage(thread, text) {
  if (thread.dshSessionId === null) throw new Error('该节点没有关联的 DSH 会话')
  if (state.pendingReplies.has(thread.dshSessionId)) throw new Error('该会话正在回复，请稍后再发送')
  state.pendingReplies.set(thread.dshSessionId, { text, at: Date.now() })
  // The panel joins the line before anything renders, so the new turn and the
  // streaming reply replace the old view in one step instead of two.
  handPanelToLine(thread.id)
  state.error = ''
  render()
  try {
    const parts = pendingParts
    await dshRpc('chattree:send-message', { sessionId: thread.dshSessionId, text, parts })
    pendingParts = []
    requestFocusNewest(thread.id)
    void loadThreadHistory(thread)
  } catch (error) {
    state.pendingReplies.delete(thread.dshSessionId)
    render()
    throw error
  }
}

// Fork `parent` at `atSeq`, register the canvas thread and send the first
// message. Shared by the canvas draft card and the card inspector, so the branch
// anchor -- the thing that keeps a branch hung off the node it was cut from --
// is resolved in exactly one place.
async function branchOff(parent, atSeq, anchorId, text, position) {
  const session = await dshRpc('chattree:fork-session', { sessionId: parent.dshSessionId, atSeq })
  const resolvedAnchor = anchorId ?? branchAnchorCardId(parent.id, atSeq)
  if (resolvedAnchor !== undefined) rememberBranchAnchor(session.id, resolvedAnchor)
  const result = await api(`/chattree/api/threads/${parent.id}/branch`, { method: 'POST', body: JSON.stringify({ title: text.slice(0, 42), dshSessionId: session.id, dshSessionTitle: session.title, position, sourceSeedLength: atSeq, anchorCardId: resolvedAnchor }) })
  if (state.workspace !== null && !state.workspace.threads.some(thread => thread.id === result.thread.id || thread.dshSessionId === result.thread.dshSessionId)) state.workspace.threads.push(result.thread)
  state.activeId = result.thread.id
  state.draft = null
  state.pendingReplies.set(result.thread.dshSessionId, { text, at: Date.now() })
  // Same hand-over, and it lands before the branch's own first render: the new
  // line already carries the pending question, so there is no empty frame.
  handPanelToLine(result.thread.id)
  render()
  const parts = pendingParts
  await dshRpc('chattree:send-message', { sessionId: result.thread.dshSessionId, text, parts })
  pendingParts = []
  requestFocusNewest(result.thread.id)
  void loadThreadHistory(result.thread)
  await refreshProjection()
  return result.thread
}

async function submitDraft() {
  const draft = state.draft
  const text = draft?.text.trim()
  if (draft === null || !text) return
  const branchPosition = draft.kind === 'branch' && state.workspace !== null ? draftPlacement(arrangedCards(state.workspace.threads))?.position : undefined
  draft.sending = true
  state.error = ''
  render()
  try {
    if (draft.kind === 'new') {
      const session = await dshRpc('chattree:create-session', { workspaceId: draft.workspaceId ?? state.selectedDshWorkspaceId, cwd: draft.cwd ?? state.currentDsh?.cwd })
      await dshRpc('chattree:send-message', { sessionId: session.id, text })
      state.draft = null
      state.canvasViewInitialized = false
      if (state.workspace !== null) {
        // Match the host's own shape: a thread has its own uuid id, and the DSH
        // session it mirrors lives in dshSessionId. Using the session id as the
        // thread id made every later comparison (activeId, the rail, the scoped
        // canvas) miss, which is why the board came up empty until a reload
        // replaced this optimistic entry with the projected one.
        const existing = state.workspace.threads.find(item => item.dshSessionId === session.id)
        const thread = existing ?? {
          id: session.threadId ?? session.id,
          dshSessionId: session.id,
          title: session.title ?? text.slice(0, 42),
          dshSessionTitle: session.title ?? null,
          parentId: null,
          messages: [],
        }
        thread.title = thread.title ?? session.title ?? text.slice(0, 42)
        thread.dshSessionTitle = thread.dshSessionTitle ?? session.title ?? null
        thread.messages = [{ kind: 'user', text, at: new Date().toISOString(), sourceSeq: undefined }]
        state.workspace.threads = [...state.workspace.threads.filter(item => item.id !== thread.id), thread]
        state.activeId = thread.id
        // Tell DSH this is the current session. The projection refresh that follows
        // recomputes the selection from DSH's current session, so without this the
        // canvas snapped back to the conversation that was active before.
        post('chattree:activate-session', { sessionId: session.id })
      }
      render()
      window.setTimeout(() => {
        void refreshProjection().catch(() => {})
      }, 150)
      return
    }
    const parent = state.workspace?.threads.find(thread => thread.id === draft.parentId)
    if (parent === undefined) throw new Error('来源会话不存在')
    await branchOff(parent, draft.atSeq, draft.anchorId, text, branchPosition)
  } catch (error) {
    if (draft.kind === 'branch') {
      state.pendingReplies.delete(state.workspace?.threads.find(thread => thread.id === state.activeId)?.dshSessionId)
      if (state.draft !== null) state.draft = { ...draft, sending: false }
    } else {
      state.draft = { ...draft, sending: false }
    }
    setError(error)
  }
}

function threadsById() { return new Map((state.workspace?.threads ?? []).map(thread => [thread.id, thread])) }
function persistedMessagesFor(thread) { return state.historyBySession.get(thread.dshSessionId) ?? thread.messages ?? [] }

// Two kinds of user message in a DSH log are not something the reader asked. One is the runtime
// snapshot, which is dropped outright. The other is a compaction checkpoint: DSH lands it as an
// ordinary `user/message`, so it was being drawn as a question that nothing ever answers -- a
// card reading "等待助手回复" whose composer is dead, because there is no answer to branch from.
// It is a node of its own instead, and the marker the canvas paints it with says why it is there.
//
// Recognised by its opening line, in both places a message can enter: during persistence (so a
// new checkpoint is stored as what it is) and here (so a workspace saved before that rule existed
// renders correctly without a migration).
const RUNTIME_SNAPSHOT_OPENING = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
const CHECKPOINT_OPENING = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context.'
const CHECKPOINT_OPEN_TAG = '<compacted-summary>'
const CHECKPOINT_CLOSE_TAG = '</compacted-summary>'

const messageOpening = message => typeof message?.text === 'string' ? message.text.trimStart() : ''
const isRuntimeSnapshot = message => message?.kind === 'user' && messageOpening(message).startsWith(RUNTIME_SNAPSHOT_OPENING)
const isCheckpoint = message => message?.kind === 'user' && messageOpening(message).startsWith(CHECKPOINT_OPENING)

// The checkpoint carries an English preamble and the tags DSH fences the summary with. Neither
// belongs on a card: the reader wants what was kept, not the framing around it.
function checkpointSummary(text) {
  const body = typeof text === 'string' ? text : ''
  const start = body.indexOf(CHECKPOINT_OPEN_TAG)
  const end = body.lastIndexOf(CHECKPOINT_CLOSE_TAG)
  if (start === -1 || end <= start) return body.trim()
  return body.slice(start + CHECKPOINT_OPEN_TAG.length, end).trim()
}

function threadMessages(thread) {
  return persistedMessagesFor(thread).flatMap(message => {
    if (isRuntimeSnapshot(message)) return []
    if (isCheckpoint(message)) return [{ ...message, kind: 'compaction', text: checkpointSummary(message.text) }]
    return [message]
  })
}

function pendingUserIndex(messages, pending) {
  return messages.findLastIndex(message => message.kind === 'user' && message.text === pending.text && new Date(message.at).getTime() >= pending.at - 2_000)
}

function settlePendingReply(thread, messages) {
  const pending = state.pendingReplies.get(thread.dshSessionId)
  if (pending === undefined) return false
  const userIndex = pendingUserIndex(messages, pending)
  if (userIndex === -1 || !messages.slice(userIndex + 1).some(message => message.kind === 'assistant')) return false
  state.pendingReplies.delete(thread.dshSessionId)
  return true
}

function messagesFor(thread) {
  const messages = threadMessages(thread)
  const pending = state.pendingReplies.get(thread.dshSessionId)
  if (pending === undefined) return messages
  if (settlePendingReply(thread, messages)) {
    state.liveReplies.delete(thread.dshSessionId)
    return messages
  }
  // A finished stream keeps its text until settlePendingReply() sees the saved turn, so
  // the answer never blanks out in the gap before the next projection fetch.
  const liveReply = state.liveReplies.get(thread.dshSessionId)
  const liveAssistant = liveReply !== undefined ? { kind: 'assistant', text: liveReply.text, pending: true, at: new Date().toISOString() } : { kind: 'assistant', text: '', pending: true, at: new Date().toISOString() }
  const userIndex = pendingUserIndex(messages, pending)
  if (userIndex !== -1) return [...messages, liveAssistant]
  return [...messages, { kind: 'user', text: pending.text, pending: true, at: new Date(pending.at).toISOString() }, liveAssistant]
}

function latestMessage(thread, kind) { return [...messagesFor(thread)].reverse().find(message => message.kind === kind) }
function questionFor(thread) { return latestMessage(thread, 'user')?.text ?? thread.dshSessionTitle ?? '等待用户提问' }
function answerFor(thread) { return latestMessage(thread, 'assistant') ?? null }

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
}

const tableCells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())

const isTableDelimiter = line => {
  const cells = tableCells(line)
  return cells.length > 0 && cells.every(cell => /^:?-+:?$/.test(cell))
}

function markdownBlock(text) {
  const lines = text.split('\n')
  const output = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    if (line.trim() === '') { index++; continue }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading !== null) {
      const level = heading[1].length
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`)
      index++
      continue
    }
    const unordered = /^[-*+]\s+(.+)$/.exec(line)
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line)
    if (unordered !== null || ordered !== null) {
      const matcher = unordered === null ? /^\d+[.)]\s+(.+)$/ : /^[-*+]\s+(.+)$/
      const items = []
      while (index < lines.length) {
        const item = matcher.exec(lines[index])
        if (item === null) break
        items.push(`<li>${inlineMarkdown(item[1])}</li>`)
        index++
      }
      output.push(`<${unordered === null ? 'ol' : 'ul'}>${items.join('')}</${unordered === null ? 'ol' : 'ul'}>`)
      continue
    }
    // GFM table: a leading-pipe header row followed by a |-delimiter row,
    // then any number of leading-pipe body rows.
    if (/^\s*\|/.test(line) && index + 1 < lines.length && isTableDelimiter(lines[index + 1])) {
      const header = line
      const body = []
      index += 2
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        body.push(lines[index])
        index++
      }
      output.push(`<table><thead><tr>${tableCells(header).map(cell => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${body.map(row => `<tr>${tableCells(row).map(cell => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    const paragraph = []
    while (index < lines.length && lines[index].trim() !== '' && !/^(#{1,3})\s+/.test(lines[index]) && !/^[-*+]\s+/.test(lines[index]) && !/^\d+[.)]\s+/.test(lines[index])) paragraph.push(lines[index++])
    // A marker-only line such as PowerShell's "+ " diagnostic is neither a
    // list item nor paragraph content under the rules above. Consume it so
    // the parser always makes progress.
    if (paragraph.length === 0) paragraph.push(lines[index++])
    output.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`)
  }
  return output.join('')
}

// Markdown parsing is pure CPU and repeats for every card on every canvas
// rebuild; cache the rendered HTML by input text so stable answers are never
// re-parsed. Bounded: streaming partial texts churn keys, so evict oldest.
const markdownCache = new Map()
const MARKDOWN_CACHE_LIMIT = 5000
function renderMarkdown(text) {
  const key = String(text)
  const cached = markdownCache.get(key)
  if (cached !== undefined) return cached
  const parts = key.split(/```/)
  const rendered = parts.map((part, index) => index % 2 === 1
    ? `<pre><code>${escapeHtml(part.replace(/^\w*\n/, ''))}</code></pre>`
    : markdownBlock(part)).join('')
  if (markdownCache.size >= MARKDOWN_CACHE_LIMIT) markdownCache.delete(markdownCache.keys().next().value)
  markdownCache.set(key, rendered)
  return rendered
}

function overlapsCard(position, other) {
  return position.x < other.x + CARD_WIDTH && position.x + CARD_WIDTH > other.x
    && position.y < other.y + CARD_HEIGHT && position.y + CARD_HEIGHT > other.y
}

function firstAvailableCardPosition(position, occupied) {
  const candidate = { x: Math.max(86, Math.round(position.x)), y: Math.max(82, Math.round(position.y)) }
  while (true) {
    const collisions = occupied.filter(other => overlapsCard(candidate, other))
    if (collisions.length === 0) return candidate
    candidate.x = Math.max(...collisions.map(other => other.x + CARD_WIDTH + CARD_GAP_X))
  }
}

function connectorPath(fromPosition, toPosition) {
  const fromX = fromPosition.x + CARD_WIDTH / 2
  const fromY = fromPosition.y + CARD_HEIGHT
  const toX = toPosition.x + CARD_WIDTH / 2
  const toY = toPosition.y
  const bend = Math.min(110, Math.max(36, Math.abs(toY - fromY) * .2))
  return `M ${fromX} ${fromY} C ${fromX} ${fromY + bend}, ${toX} ${toY - bend}, ${toX} ${toY}`
}

function connectorPathFromElements(fromCard, toCard) {
  const fromX = Number.parseFloat(fromCard.style.left) + CARD_WIDTH / 2
  const fromY = Number.parseFloat(fromCard.style.top) + CARD_HEIGHT
  const toX = Number.parseFloat(toCard.style.left) + CARD_WIDTH / 2
  const toY = Number.parseFloat(toCard.style.top)
  if (![fromX, fromY, toX, toY].every(Number.isFinite)) return null
  const bend = Math.min(110, Math.max(36, Math.abs(toY - fromY) * .2))
  return `M ${fromX} ${fromY} C ${fromX} ${fromY + bend}, ${toX} ${toY - bend}, ${toX} ${toY}`
}

function selectorValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

// Connector paths are rebuilt together with the canvas DOM; cache the mapping
// from card id to its incident paths so dragging never scans the whole SVG.
let connectorPathsByCard = new Map()
function cacheCardConnectors() {
  connectorPathsByCard = new Map()
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return
  for (const path of viewport.querySelectorAll('.connectors path[data-from]')) {
    const fromId = path.getAttribute('data-from')
    const toId = path.getAttribute('data-to')
    if (fromId === null || toId === null) continue
    for (const id of [fromId, toId]) {
      const paths = connectorPathsByCard.get(id)
      if (paths === undefined) connectorPathsByCard.set(id, new Set([path]))
      else paths.add(path)
    }
  }
}

function refreshCardConnectors(cardId) {
  const paths = connectorPathsByCard.get(cardId)
  if (paths === undefined || paths.size === 0) return
  const byId = state.canvasCardsById
  if (byId === undefined) return
  for (const path of paths) {
    const fromId = path.getAttribute('data-from')
    const toId = path.getAttribute('data-to')
    if (fromId === null || toId === null) continue
    const fromCard = byId.get(fromId)
    const toCard = byId.get(toId)
    if (fromCard === undefined || toCard === undefined) continue
    // Data-driven endpoints: the counterpart card may be unmounted (outside
    // the viewport) but its position is still authoritative.
    path.setAttribute('d', connectorPath(fromCard.position, toCard.position))
  }
}

function initialCanvasCamera(cards) {
  const draft = state.draft?.kind === 'new' ? { id: 'draft:new', position: { x: 86, y: 82 } } : draftPlacement(cards)
  // Open where the work is: the newest branch on the canvas, not the first card and not
  // the newest turn of whichever conversation the rail happens to point at.
  const focus = draft ?? newestCanvasCard(cards) ?? cards[0]
  const position = focus?.position
  if (position === undefined) return { x: 0, y: 0 }
  return { x: CAMERA_INSET_X - position.x * state.zoom, y: CAMERA_INSET_Y - position.y * state.zoom }
}

function placeConversationCards(cards) {
  // The arrangement is the only source of a position. A remembered drag is deliberately
  // NOT consulted: a pinned card punches a hole in its row, because the cards that belong
  // to the cells beside it are pushed right to avoid it and the cell it sits on is then
  // empty. 整理 cleared those positions anyway, so reading them only ever meant a canvas
  // that looked arranged until the next reload.
  for (const card of cards) card.position = card.naturalPosition ?? card.position
  return cards
}

// Lay the canvas out as rows.
//
//   - every card's row is one below the card it answers, so a branch hangs under its
//     fork and a conversation runs straight down
//   - each row is then filled from the left, one column after another, with no gaps:
//     the leftmost free cell always wins
//   - a card with no parent starts on row 0
//
// Nothing else participates: no column ownership, no length ordering, no anchors beyond
// the parent link. Cards are grouped by row and laid out left to right, so a row is a
// solid run of cards by construction.
function layoutConversationGraph(cards, threads) {
  const byId = new Map(cards.map(card => [card.id, card]))
  const childrenOf = new Map()
  const roots = []
  for (const card of cards) {
    if (card.parentId === null || card.parentId === undefined || !byId.has(card.parentId)) {
      roots.push(card.id)
      continue
    }
    const children = childrenOf.get(card.parentId) ?? []
    children.push(card.id)
    childrenOf.set(card.parentId, children)
  }

  // Row of every card: one below its parent. The walk is depth-first from the roots, so
  // a card is always rowed before the cards that hang off it. A malformed projection can
  // hold a cycle, so a card already rowed is not visited twice.
  const rowOf = new Map()
  const visit = (cardId, row) => {
    if (rowOf.has(cardId)) return
    rowOf.set(cardId, row)
    for (const childId of childrenOf.get(cardId) ?? []) visit(childId, row + 1)
  }
  for (const cardId of roots) visit(cardId, 0)
  // Anything left was part of a cycle; give it the next row rather than dropping it.
  let spill = 0
  for (const card of cards) {
    if (rowOf.has(card.id)) continue
    visit(card.id, spill)
    spill += 1
  }

  // Fill each row from the left. Cards keep the order they arrived in, which is the
  // conversation order, so siblings stay in the order they were created.
  const byRow = new Map()
  for (const card of cards) {
    const row = rowOf.get(card.id) ?? 0
    const list = byRow.get(row) ?? []
    list.push(card)
    byRow.set(row, list)
  }
  const stepX = CARD_WIDTH + CARD_GAP_X
  const stepY = CARD_HEIGHT + CARD_GAP_Y
  const orderOf = new Map(cards.map((card, index) => [card.id, index]))
  // Columns are handed out row by row, and inside a row the cards are ordered by the column
  // their parent took. Rows are walked top to bottom, so a parent's column is always known
  // by the time its branches are placed. Filling a row in creation order instead let a late
  // branch land far from the card it grew from, which is what drew crossing lines.
  const columnOf = new Map()
  const parentColumnOf = card => {
    if (card.parentId === null || card.parentId === undefined) return -1
    const column = columnOf.get(card.parentId)
    return column === undefined ? -1 : column
  }
  for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
    const list = byRow.get(row) ?? []
    list.sort((a, b) => {
      const parentA = parentColumnOf(a)
      const parentB = parentColumnOf(b)
      if (parentA !== parentB) return parentA - parentB
      return (orderOf.get(a.id) ?? 0) - (orderOf.get(b.id) ?? 0)
    })
    for (let column = 0; column < list.length; column++) {
      columnOf.set(list[column].id, column)
      const position = { x: 86 + column * stepX, y: 82 + row * stepY }
      list[column].naturalPosition = position
      list[column].position = position
    }
  }

  return placeConversationCards(cards)
}

function conversationCards(threads) {
  const cards = []
  const cardsByThread = new Map()
  for (const thread of threads) {
    const messages = messagesFor(thread)
    const turns = []
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const question = messages[messageIndex]
      if (question.kind !== 'user' && question.kind !== 'compaction') continue
      // A checkpoint is a node of its own: nothing answers it, and it must not be swallowed as a
      // reply to the question above it. It keeps the turn slot it already occupies, so every id
      // after it stays the id it was.
      const compaction = question.kind === 'compaction'
      const replies = []
      const errors = []
      let processCount = 0
      if (!compaction) for (let replyIndex = messageIndex + 1; replyIndex < messages.length; replyIndex++) {
        const reply = messages[replyIndex]
        if (reply.kind === 'user' || reply.kind === 'compaction') break
        if (reply.kind === 'assistant') replies.push(reply)
        if (reply.kind === 'error') errors.push(reply)
        if (Array.isArray(reply.process)) processCount += reply.process.length
        else if (reply.kind === 'tool') processCount += 1
      }
      const answer = compaction ? null : replies.at(-1) ?? null
      const error = compaction ? null : errors.at(-1) ?? null
      const turnIndex = turns.length
      const previous = turns.at(-1)
      // One identity per turn, and it is the turn's position in its thread. It used to be
      // the DSH sequence number (`turn:${sourceSeq ?? messageIndex}`), which re-keyed a turn
      // the moment its pending message gained that number -- silently dropping everything
      // filed under the old id: archived roots, the reader's scroll position, the panel's
      // pinned card. Threads only ever append (every question forks a new session), so the
      // index never moves.
      const positionKey = `${thread.id}:turn-index:${turnIndex}`
      const id = positionKey
      const naturalPosition = previous === undefined ? { x: 86, y: 82 } : { x: previous.naturalPosition.x, y: previous.naturalPosition.y + CARD_HEIGHT + CARD_GAP_Y }
      const savedPosition = state.cardPositions?.get(id) ?? state.cardPositions?.get(positionKey)
      const positionLocked = savedPosition !== undefined
      const position = positionLocked ? savedPosition : naturalPosition
      turns.push({
        id,
        positionKey,
        dshThreadId: thread.id,
        sourceParentId: thread.parentId,
        parentId: null,
        sourceSeq: question.sourceSeq,
        turnIndex,
        naturalPosition,
        position,
        positionLocked,
        question: question.text,
        answer,
        error,
        processCount,
        compaction,
      })
    }
    const liveReply = state.liveReplies.get(thread.dshSessionId)
    const latestTurn = turns.at(-1)
    // A checkpoint is never the turn a stream belongs to: it is written while the agent is idle,
    // and painting a reply onto it would turn the marker back into a question.
    if (liveReply?.running && latestTurn !== undefined && latestTurn.compaction !== true && (latestTurn.answer === null || latestTurn.answer.pending === true)) latestTurn.answer = { kind: 'assistant', text: liveReply.text, pending: true, at: new Date().toISOString() }
    if (turns.length === 0) {
      const id = `${thread.id}:turn:empty`
      const positionKey = `${thread.id}:turn-index:0`
      const naturalPosition = { x: 86, y: 82 }
      const savedPosition = state.cardPositions?.get(id) ?? state.cardPositions?.get(positionKey)
      const positionLocked = savedPosition !== undefined
      turns.push({
      id,
      positionKey,
      dshThreadId: thread.id,
      sourceParentId: thread.parentId,
      parentId: null,
      sourceSeq: undefined,
      turnIndex: 0,
      naturalPosition,
      position: positionLocked ? savedPosition : naturalPosition,
      positionLocked,
      question: thread.dshSessionTitle ?? thread.title,
      answer: null,
      error: null,
      processCount: 0,
      })
    }
    cardsByThread.set(thread.id, turns)
    cards.push(...turns)
  }
  for (const card of cards) {
    const siblings = cardsByThread.get(card.dshThreadId)
    if (card.turnIndex > 0) card.parentId = siblings[card.turnIndex - 1].id
    else {
      const parentCards = cardsByThread.get(card.sourceParentId)
      const sourceThread = threads.find(thread => thread.id === card.dshThreadId)
      const firstChildQuestion = siblings?.[0]
      const storedCut = sourceThread?.sourceSeedLength
      const childFirstSeq = firstChildQuestion?.sourceSeq
      // A fork's seed boundary cannot sit past the fork's own first event, so a
      // stored cut that does is a stale in-process marker, not the real boundary:
      // ignore it rather than attach the branch to some far-later turn.
      const seedLength = Number.isSafeInteger(storedCut) && (!Number.isInteger(childFirstSeq) || storedCut <= childFirstSeq)
        ? storedCut
        : childFirstSeq
      // A fork inherits every parent event before DSH's durable seed boundary.
      // The latest parent question below that boundary is the exact Turn where
      // this child was born. Canvas coordinates never participate in lineage.
      const inheritedTurn = Number.isSafeInteger(seedLength)
        ? parentCards?.filter(candidate => Number.isInteger(candidate.sourceSeq) && candidate.sourceSeq < seedLength).at(-1)
        : undefined
      // The fork seed boundary is the durable record of which card a branch
      // was cut from: the server stores sourceSeedLength with the thread, so it
      // survives a new browser profile, a cleared cache, or a reload that rebuilt
      // the threads. A remembered anchor is only a fallback, because it can name a
      // card from an older numbering and would then pull the branch away from its
      // fork -- which is what made a freshly arranged canvas scatter.
      const rememberedAnchor = state.branchAnchors.get(card.dshThreadId) ?? state.branchAnchors.get(sourceThread?.dshSessionId)
      const rememberedCard = rememberedAnchor === undefined
        ? undefined
        : cards.find(candidate => candidate.id === rememberedAnchor)
      const rememberedFits = rememberedCard !== undefined && parentCards !== undefined
        && parentCards.some(candidate => candidate.id === rememberedCard.id)
      card.parentId = inheritedTurn?.id
        ?? (rememberedFits ? rememberedCard.id : undefined)
        ?? rememberedAnchor
        ?? null
    }
  }
  // Archiving hides a node and everything downstream of it. Only the roots are
  // stored, so the closure is taken here: a card is hidden when it was archived
  // itself or when the card it hangs off is hidden. Branches anchored before the
  // archived node keep their place.
  const archivedRoots = new Set(state.workspace?.archivedCardIds ?? [])
  if (archivedRoots.size > 0) {
    const hidden = hiddenArchivedCardIds(cards, archivedRoots)
    if (hidden.size > 0) return cards.filter(card => !hidden.has(card.id))
  }
  // Positions are assigned by arrangedCards(), once the canvas is known.
  return cards
}

// Which cards an archive hides: the archived nodes and every card downstream of
// them. Later turns of the same session and branches anchored to a hidden card
// both hang off a hidden parent, so one closure covers both. Branches anchored
// before the archived node keep their parent and stay visible.
function hiddenArchivedCardIds(cards, roots) {
  const hidden = new Set()
  if (roots.size === 0) return hidden
  for (let changed = true; changed;) {
    changed = false
    for (const card of cards) {
      if (hidden.has(card.id)) continue
      if (roots.has(card.id) || (card.parentId !== null && hidden.has(card.parentId))) {
        hidden.add(card.id)
        changed = true
      }
    }
  }
  return hidden
}


function conversationGraphView(cards, collapsedCardIds = state.collapsedCardIds) {
  const cardIds = new Set(cards.map(card => card.id))
  const childrenByParent = new Map()
  for (const card of cards) {
    if (card.parentId === null || !cardIds.has(card.parentId)) continue
    const children = childrenByParent.get(card.parentId) ?? []
    children.push(card.id)
    childrenByParent.set(card.parentId, children)
  }

  const hiddenIds = new Set()
  for (const rootId of collapsedCardIds) {
    if (!cardIds.has(rootId)) continue
    const visited = new Set([rootId])
    const visit = parentId => {
      for (const childId of childrenByParent.get(parentId) ?? []) {
        if (visited.has(childId)) continue
        visited.add(childId)
        hiddenIds.add(childId)
        visit(childId)
      }
    }
    visit(rootId)
  }

  // Persisted collapse roots must remain visible even if malformed metadata
  // contains a cycle where two collapsed nodes otherwise hide each other.
  for (const rootId of collapsedCardIds) hiddenIds.delete(rootId)

  // Post-order accumulation: each card's descendant count is 1 + the sum of
  // its children's subtree sizes, so the whole graph is O(n) instead of a BFS
  // from every card (O(n²) on deep chains). Malformed parent cycles are
  // detected through the DFS path: every member of a cycle reaches every other
  // member plus the union of their off-cycle subtrees, so when the cycle entry
  // pops last, all members are settled to (cycleSize - 1) + off-cycle total,
  // which matches the per-card BFS' unique-descendant count.
  const descendantCounts = new Map()
  const inStack = new Set()
  for (const card of cards) {
    if (descendantCounts.has(card.id)) continue
    const stack = [{ id: card.id, children: childrenByParent.get(card.id) ?? [], index: 0 }]
    const path = [card.id]
    let cycleEntry = null
    let cycleMembers = null
    let cycleOffCycleTotal = 0
    inStack.add(card.id)
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top.index < top.children.length) {
        const childId = top.children[top.index++]
        if (descendantCounts.has(childId)) continue
        if (inStack.has(childId)) {
          // Back edge: the nodes from childId up to top.id form a cycle.
          cycleEntry = childId
          cycleMembers = new Set(path.slice(path.indexOf(childId)))
          cycleOffCycleTotal = 0
          continue
        }
        inStack.add(childId)
        path.push(childId)
        stack.push({ id: childId, children: childrenByParent.get(childId) ?? [], index: 0 })
      } else {
        stack.pop()
        path.pop()
        inStack.delete(top.id)
        let count = 0
        for (const childId of top.children) {
          if (cycleMembers !== null && cycleMembers.has(childId)) continue // ring edge; base count added below
          count += 1 + (descendantCounts.get(childId) ?? 0)
        }
        if (cycleMembers !== null && cycleMembers.has(top.id)) cycleOffCycleTotal += count
        if (cycleMembers !== null && top.id === cycleEntry) {
          // All cycle members have popped (the entry pops last in post-order);
          // settle them so ancestors popping next read the final counts.
          const base = cycleMembers.size - 1
          for (const id of cycleMembers) descendantCounts.set(id, base + cycleOffCycleTotal)
          cycleEntry = null
          cycleMembers = null
        } else {
          descendantCounts.set(top.id, count)
        }
      }
    }
  }

  return {
    cards: cards.filter(card => !hiddenIds.has(card.id)),
    childCounts: new Map(cards.map(card => [card.id, childrenByParent.get(card.id)?.length ?? 0])),
    descendantCounts,
  }
}

function revealConversationThread(cards, threadId) {
  const byId = new Map(cards.map(card => [card.id, card]))
  let changed = false
  for (const target of cards.filter(card => card.dshThreadId === threadId)) {
    const visited = new Set([target.id])
    let parentId = target.parentId
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId)
      if (state.collapsedCardIds.delete(parentId)) changed = true
      parentId = byId.get(parentId)?.parentId ?? null
    }
  }
  if (changed) persistCollapsedCards()
}

// The cards on the branch line that leads to the selected card: the selection itself and
// every card it answers, up to the root of its lineage. A malformed projection can hold a
// cycle, so a card already walked is not walked twice.
function highlightPath(cardId, cards) {
  const byId = new Map(cards.map(card => [card.id, card]))
  const path = new Set()
  if (cardId === null || cardId === undefined) return path
  let cursor = byId.get(cardId)
  while (cursor !== undefined && !path.has(cursor.id)) {
    path.add(cursor.id)
    cursor = cursor.parentId === null || cursor.parentId === undefined ? undefined : byId.get(cursor.parentId)
  }
  return path
}

// In dot mode the line joins two points, so it is drawn centre to centre as the same
// smooth S the cards use, with no card edges to leave from.
function dotConnectorPath(fromPosition, toPosition) {
  const fromX = fromPosition.x + CARD_WIDTH / 2
  const fromY = fromPosition.y + CARD_HEIGHT / 2
  const toX = toPosition.x + CARD_WIDTH / 2
  const toY = toPosition.y + CARD_HEIGHT / 2
  // The same vertical S the cards use, drawn centre to centre: a dot has no edge to
  // leave from. The bend grows with the drop so a long run stays smooth.
  const bend = Math.min(150, Math.max(42, Math.abs(toY - fromY) * .35))
  return `M ${fromX} ${fromY} C ${fromX} ${fromY + bend}, ${toX} ${toY - bend}, ${toX} ${toY}`
}

function canvasConnectors(cards) {
  const path = state.canvasStyle === 'dot' ? dotConnectorPath : connectorPath
  const index = new Map(cards.map(card => [card.id, card]))
  const onPath = state.highlightCardIds ?? new Set()
  const links = cards.map(card => {
    const parent = card.parentId === null ? null : index.get(card.parentId)
    if (parent === undefined || parent === null) return ''
    const classes = []
    if (card.dshThreadId === state.activeId && parent.dshThreadId === state.activeId) classes.push('active-connector')
    // The whole line into the selection is drawn heavier, so the branch the selected card
    // belongs to reads at a glance.
    if (onPath.has(card.id)) classes.push('selected-connector')
    const className = classes.length === 0 ? '' : ` class="${classes.join(' ')}"`
    return `<path${className} data-from="${escapeHtml(parent.id)}" data-to="${escapeHtml(card.id)}" d="${path(parent.position, card.position)}"></path>`
  })
  const placement = draftPlacement(cards)
  if (placement !== null) {
    links.push(`<path class="draft-connector" data-from="${escapeHtml(placement.parent.id)}" data-to="draft" d="${connectorPath(placement.parent.position, placement.position)}"></path>`)
  }
  return links.join('')
}

// The minimal canvas: one dot per turn. Only the position and the question travel into
// the DOM -- no title, no answer, no footer -- so the graph stays quiet and the tooltip
// is the single place any text appears.
function dotNode(card) {
  const classes = [
    'dot-node',
    card.compaction === true ? 'is-compaction' : '',
    card.id === state.selectedCardId ? 'selected' : '',
    state.highlightCardIds?.has(card.id) === true && card.id !== state.selectedCardId ? 'on-path' : '',
    card.answer?.pending === true ? 'is-pending' : '',
    card.error === null ? '' : 'has-error',
  ].filter(Boolean).join(' ')
  const left = card.position.x + CARD_WIDTH / 2
  const top = card.position.y + CARD_HEIGHT / 2
  return `<button type="button" class="${classes}" data-dot-card="${escapeHtml(card.id)}" data-card-id="${escapeHtml(card.id)}" data-thread="${card.dshThreadId}" data-question="${escapeHtml(card.question)}" aria-label="${escapeHtml(card.question)}" style="left:${left}px;top:${top}px"></button>`
}

function setCanvasStyle(style) {
  state.canvasStyle = style === 'dot' ? 'dot' : 'card'
  try { localStorage.setItem(CANVAS_STYLE_KEY, state.canvasStyle) } catch { /* Private browsing may disable local storage. */ }
  // Cards need more room than dots do, so stepping back up may be required: 20% is a fine
  // dot graph and an unreadable card canvas.
  if (state.zoom < zoomFloor()) state.zoom = zoomFloor()
}

// One tooltip for the whole graph, positioned on hover and fed from data-question, so a
// dot carries no extra nodes and a long question costs nothing until it is read.
function installDotNodes() {
  const layer = document.querySelector('.cards-layer')
  const tip = document.querySelector('.dot-tooltip')
  if (!(layer instanceof HTMLElement) || !(tip instanceof HTMLElement)) return
  const hide = () => { tip.hidden = true; tip.textContent = '' }
  layer.addEventListener('pointerover', event => {
    const dot = event.target instanceof Element ? event.target.closest('.dot-node') : null
    if (!(dot instanceof HTMLElement)) return
    const question = dot.dataset.question ?? ''
    if (question === '') return hide()
    // Only the opening words travel into the tooltip; the rest is elided, so a long
    // question cannot cover the graph it is describing. Counted by code point, so an
    // emoji is one character rather than two.
    const characters = [...question]
    tip.textContent = characters.length > 50 ? `${characters.slice(0, 50).join('')}…` : question
    tip.hidden = false
    // Sit just off the pointer rather than under the dot: the dot can be 140px wide, so
    // its bottom edge is a long way from where the cursor actually is.
    const width = tip.getBoundingClientRect().width
    const height = tip.getBoundingClientRect().height
    const x = event.clientX + 14
    const y = event.clientY + 16
    tip.style.left = `${Math.min(Math.max(8, x), window.innerWidth - width - 8)}px`
    tip.style.top = `${Math.min(Math.max(8, y), window.innerHeight - height - 8)}px`
  })
  layer.addEventListener('pointerout', event => {
    const dot = event.target instanceof Element ? event.target.closest('.dot-node') : null
    if (dot instanceof HTMLElement) hide()
  })
  window.addEventListener('scroll', hide, { passive: true })
}

function conversationCard(card, graph) {
  const selected = card.id === state.selectedCardId ? ' selected' : ''
  const onPath = state.highlightCardIds?.has(card.id) === true && card.id !== state.selectedCardId ? ' on-path' : ''
  // A card is read-only now; every action lives in the panel.
  // The fold and branch controls were removed; both actions live in the panel now.
  
  // State rides on the card as classes rather than as a row of words: the dot
  // breathes while a reply is being written, and a failed turn marks its edge.
  const status = `${card.compaction === true ? ' is-compaction' : ''}${card.answer?.pending === true ? ' is-pending' : ''}${card.error === null ? '' : ' has-error'}`
// A failed turn gets a panel of its own rather than a red line of text: the same
  // words the panel uses, with the message at full width instead of clamped into a
  // sentence. The card's edge and dot turn red with it, which is what still reads
  // when the canvas is zoomed out and the answer is not drawn at all.
  const failure = card.error === null ? '' : `<div class="card-failure" role="alert"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M8 2.8 14.2 13H1.8L8 2.8Z"/><path d="M8 6.6v3.1"/><path d="M8 11.4h.01"/></svg><div><strong>本轮未完成</strong><p title="${escapeHtml(card.error.text)}">${escapeHtml(card.error.text)}</p></div></div>`
  // A checkpoint is a marker on the line rather than a turn: it says what happened to the
  // history behind it, in the one colour nothing else on the canvas uses. Its heading is the
  // short label -- the summary belongs in the body, and reading it twice on one card is noise.
  const heading = card.compaction === true ? '上下文已压缩' : card.question
  const body = card.compaction === true
    ? `<div class="card-compaction">${card.question === '' ? '' : renderMarkdown(card.question)}</div>`
    : card.answer === null ? (card.error === null ? '<p class="thread-answer-empty">等待助手回复</p>' : '') : card.answer.pending && card.answer.text === '' ? '<p class="thread-answer-pending">正在回复</p>' : `${renderMarkdown(card.answer.text)}${card.answer.pending ? '<p class="thread-answer-pending">正在回复</p>' : ''}`
  return `<article class="thread-card${selected}${onPath}${status}" data-card-id="${escapeHtml(card.id)}" data-position-key="${escapeHtml(card.positionKey)}" data-thread="${card.dshThreadId}" style="left:${card.position.x}px;top:${card.position.y}px;--thread-color:#3478f6">
    <button class="node-handle" data-drag-card="${card.id}" aria-label="拖动 ${escapeHtml(heading)}" title="拖动卡片"></button>
    <div class="thread-card-head"><span class="topic-dot"></span><button class="thread-title" data-action="open-card" data-thread="${card.dshThreadId}" data-card="${escapeHtml(card.id)}" title="查看完整会话：${escapeHtml(heading)}">${escapeHtml(heading)}</button></div>
    <div class="thread-answer">${body}${failure}</div>
    <footer><button data-action="open-dsh" data-thread="${card.dshThreadId}" data-seq="${Number.isInteger(card.sourceSeq) ? card.sourceSeq : ''}" title="在 DSH 中打开" aria-label="在 DSH 中打开"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5H4.5A1.5 1.5 0 0 0 3 5v6.5A1.5 1.5 0 0 0 4.5 13H11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M9.5 3.5h3v3M12.4 3.6 7.5 8.5"/></svg>DSH</button><button data-action="archive-card" data-card="${escapeHtml(card.id)}" title="归档此节点及其之后" aria-label="归档此节点及其之后"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5h11M5.5 7v5.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V7"/><path d="M4 5 5 2.8a.7.7 0 0 1 .6-.4h4.8a.7.7 0 0 1 .6.4L12 5M6 9.5h4"/></svg>归档</button></footer>
  </article>`
}

function draftActions(draft) {
  const disabled = draft.sending ? 'disabled' : ''
  return `<div class="draft-actions"><button type="button" data-action="cancel-draft" ${disabled} aria-label="取消" title="取消"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button><button class="primary" type="submit" ${disabled} aria-label="发送" title="发送"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"/></svg></button></div>`
}

function quickPhraseEditor(draft) {
  const disabled = draft.sending ? 'disabled' : ''
  const phrases = state.quickPhrases.map((phrase, index) => `<div class="draft-quick-phrase-editor-row"><input data-quick-phrase-index="${index}" maxlength="${MAX_QUICK_PHRASE_LENGTH}" value="${escapeHtml(phrase)}" aria-label="快捷词 ${index + 1}" ${disabled}><button type="button" data-action="remove-quick-phrase" data-quick-phrase-index="${index}" aria-label="删除 ${escapeHtml(phrase)}" title="删除" ${disabled}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button></div>`).join('')
  return `<section class="draft-quick-editor" aria-label="编辑快捷词"><div class="draft-quick-editor-list">${phrases}</div><div class="draft-quick-phrase-add"><input maxlength="${MAX_QUICK_PHRASE_LENGTH}" placeholder="添加快捷词" aria-label="添加快捷词" ${disabled}><button class="primary" type="button" data-action="add-quick-phrase" aria-label="添加快捷词" title="添加快捷词" ${disabled}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg></button></div><button class="draft-quick-editor-close" type="button" data-action="close-quick-phrase-editor" ${disabled}>完成</button></section>`
}

function draftQuickPhrases(draft) {
  const disabled = draft.sending ? 'disabled' : ''
  if (state.quickPhraseEditorOpen) return quickPhraseEditor(draft)
  const phrases = state.quickPhrases.map(phrase => `<button class="draft-quick-phrase" type="button" data-action="insert-quick-phrase" data-quick-phrase="${escapeHtml(phrase)}" ${disabled}>${escapeHtml(phrase)}</button>`).join('')
  return `<div class="draft-quick-phrases" aria-label="常用补充词">${phrases}<button class="draft-quick-phrase-add-button" type="button" data-action="open-quick-phrase-editor" aria-label="管理快捷词" title="管理快捷词" ${disabled}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg></button></div>`
}

function insertQuickPhrase(phrase) {
  const input = document.querySelector('[data-draft] textarea')
  if (!(input instanceof HTMLTextAreaElement) || state.draft === null) return
  const start = input.selectionStart
  const end = input.selectionEnd
  const prefix = input.value.slice(0, start)
  const suffix = input.value.slice(end)
  const separator = prefix !== '' && !prefix.endsWith('\n') ? '\n' : ''
  const text = `${prefix}${separator}${phrase}${suffix}`
  if (text.length > input.maxLength) return setError('追问内容不能超过 4000 个字符')
  const caret = prefix.length + separator.length + phrase.length
  input.value = text
  state.draft.text = text
  input.focus()
  input.setSelectionRange(caret, caret)
}

function addQuickPhrase(value) {
  const phrase = value.trim().slice(0, MAX_QUICK_PHRASE_LENGTH)
  if (phrase === '') return false
  if (state.quickPhrases.includes(phrase)) return setError('这个快捷词已经存在')
  if (state.quickPhrases.length >= MAX_QUICK_PHRASES) return setError(`最多保留 ${MAX_QUICK_PHRASES} 个快捷词`)
  state.quickPhrases.push(phrase)
  persistQuickPhrases()
  return true
}

function updateQuickPhrase(index, value) {
  if (!Number.isInteger(index) || index < 0 || index >= state.quickPhrases.length) return
  const phrase = value.trim().slice(0, MAX_QUICK_PHRASE_LENGTH)
  if (phrase === '') {
    state.quickPhrases.splice(index, 1)
  } else if (state.quickPhrases.some((item, itemIndex) => itemIndex !== index && item === phrase)) {
    return setError('这个快捷词已经存在')
  } else {
    state.quickPhrases[index] = phrase
  }
  persistQuickPhrases()
  render()
}

function draftPlacement(cards) {
  const draft = state.draft
  if (draft === null || draft.kind === 'new') return null
  const parent = draft.anchorId === undefined
    ? cards.filter(card => card.dshThreadId === draft.parentId).at(-1)
    : cards.find(card => card.id === draft.anchorId)
  if (parent === undefined) return null
  return { parent, position: firstAvailableCardPosition({ x: parent.position.x, y: parent.position.y + CARD_HEIGHT + CARD_GAP_Y }, cards.map(card => card.position)) }
}

function draftCard(cards) {
  const draft = state.draft
  if (draft?.kind === 'new') return `<article class="thread-card draft-card first-session-card" data-card-id="draft" style="left:86px;top:82px;--thread-color:#3478f6">
    <div class="thread-card-head"><span class="topic-dot"></span><strong>新画布</strong></div>
    <form class="draft-branch-form" data-draft><textarea maxlength="4000" placeholder="输入第一条消息" ${draft.sending ? 'disabled' : ''}>${escapeHtml(draft.text)}</textarea>${draftActions(draft)}</form>
  </article>`
  const placement = draftPlacement(cards)
  if (draft === null || placement === null) return ''
  return `<article class="thread-card draft-card" data-card-id="draft" style="left:${placement.position.x}px;top:${placement.position.y}px;--thread-color:#3478f6">
    <div class="thread-card-head"><span class="topic-dot"></span><strong>新的分支</strong></div>
    <form class="draft-branch-form" data-draft>${draftQuickPhrases(draft)}<textarea maxlength="4000" placeholder="输入这个分支的新问题" ${draft.sending ? 'disabled' : ''}>${escapeHtml(draft.text)}</textarea>${draftActions(draft)}</form>
  </article>`
}

function selectionFollowupButton() {
  return `<button class="selection-followup" type="button" data-action="follow-selection" hidden aria-label="基于所选内容创建追问" title="基于所选内容追问"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 3.5h10v6.25H7.2L4 12.5V9.75H3Z"/><path d="M8 4.9v3.4M6.3 6.6h3.4"/></svg><span>追问</span></button>`
}

// Cards are mounted into the DOM only when they intersect the viewport
// (inflated by VIEWPORT_MARGIN) in world coordinates. The camera transform is
// translate(camera) scale(zoom), so screen = world * zoom + camera.
// Which cards belong to the selected conversation: every card of that thread, of
// each thread it descends from, and of the branches rooted anywhere on that chain.
// A branch of a branch is reached by the same walk, so one pass up the parents and
// one pass down the children settles it. No selection means no filter, which keeps
// the very first render (before a session is known) complete.
// The cards of the canvas on screen: scope to one canvas FIRST, then arrange. Arranging
// before scoping laid every canvas out in one shared grid, so a canvas drew its cards at
// whatever columns the other canvases had left them -- long empty stretches between
// cards that looked like a broken arrangement.
function arrangedCards(threads) {
  return layoutConversationGraph(scopedCards(conversationCards(threads), threads), threads)
}

function scopedCards(cards, threads) {
  const threadId = state.activeId
  if (threadId === null || threadId === undefined) return cards
  const byThread = new Map()
  for (const card of cards) {
    const list = byThread.get(card.dshThreadId) ?? []
    list.push(card)
    byThread.set(card.dshThreadId, list)
  }
  const chain = new Set([threadId])
  let cursor = threadId
  for (let hop = 0; hop < 64; hop++) {
    const parent = threads.find(thread => thread.id === cursor)?.parentId ?? null
    if (parent === null || chain.has(parent)) break
    chain.add(parent)
    cursor = parent
  }
  const keep = new Set()
  for (const id of chain) for (const card of byThread.get(id) ?? []) keep.add(card.id)
  // Down the branches: a card joins once the card it hangs off is already in, so
  // the walk repeats until a pass adds nothing. Each pass adds a card or stops.
  let grew = true
  while (grew) {
    grew = false
    for (const card of cards) {
      if (keep.has(card.id) || card.parentId === null || !keep.has(card.parentId)) continue
      keep.add(card.id)
      grew = true
    }
  }
  return cards.filter(card => keep.has(card.id))
}

function visibleCardIds(cards) {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return new Set(cards.map(card => card.id))
  const bounds = viewport.getBoundingClientRect()
  const left = (-state.canvasCamera.x - VIEWPORT_MARGIN) / state.zoom
  const right = (bounds.width - state.canvasCamera.x + VIEWPORT_MARGIN) / state.zoom
  const top = (-state.canvasCamera.y - VIEWPORT_MARGIN) / state.zoom
  const bottom = (bounds.height - state.canvasCamera.y + VIEWPORT_MARGIN) / state.zoom
  const visible = new Set()
  for (const card of cards) {
    const { x, y } = card.position
    if (x + CARD_WIDTH < left || x > right || y + CARD_HEIGHT < top || y > bottom) continue
    visible.add(card.id)
  }
  return visible
}

// Incrementally mount cards entering the viewport and unmount cards leaving
// it, without rebuilding the canvas. Called after pan/zoom/focus camera moves.
function syncCanvasViewport() {
  if (state.mode !== 'canvas' || state.canvasCards === undefined) return
  const layer = document.querySelector('.cards-layer')
  if (!(layer instanceof HTMLElement)) return
  const visible = visibleCardIds(state.canvasCards)
  for (const cardId of [...state.mountedCardIds]) {
    if (visible.has(cardId)) continue
    const element = layer.querySelector(`[data-card-id="${selectorValue(cardId)}"]`)
    if (element instanceof HTMLElement) element.remove()
    state.mountedCardIds.delete(cardId)
  }
  for (const card of state.canvasCards) {
    if (!visible.has(card.id) || state.mountedCardIds.has(card.id)) continue
    const wrapper = document.createElement('div')
    // Panning mounts cards that were outside the viewport, so this pass has to follow the
    // current face too: hard-coding the card renderer left those late arrivals as cards in
    // the middle of the dot graph.
    wrapper.innerHTML = state.canvasStyle === 'dot' ? dotNode(card) : conversationCard(card, state.canvasGraph)
    const element = wrapper.firstElementChild
    if (element instanceof HTMLElement) {
      layer.appendChild(element)
      const handle = element.querySelector('[data-drag-card]')
      if (handle instanceof HTMLElement) bindDragHandle(handle)
    }
    state.mountedCardIds.add(card.id)
  }
}

// ---------------------------------------------------------------------------
// The shell
//
// The shell is built once and patched from then on. Two of its regions hold state a rebuild
// would throw away -- the card layer, where every answer is its own scroller, and the panel --
// so those are reconciled element by element. The rest (sidebar, topbar, the floating status
// and question) is markup that can simply be rewritten in place, which still beats replacing
// the document: it is what lets a render keep every scroll position and every caret without
// remembering any of them.
// ---------------------------------------------------------------------------
const EMPTY_CANVAS = '<section class="empty-canvas"><strong>当前工作目录还没有画布。</strong><p>点击新画布，在画布中输入第一条消息。</p><div><button class="primary" type="button" data-action="create-session">新建画布</button></div></section>'
let shell = null

function ensureShell() {
  if (shell !== null && shell.isConnected) return shell
  app.innerHTML = '<main class="chattree-shell"><aside class="sidebar"></aside><header class="topbar"></header><section class="main-stage"><section class="canvas-view"><div class="canvas-viewport"><div class="canvas-content"><svg class="connectors"></svg><div class="cards-layer"></div></div></div><div class="dot-tooltip" hidden></div></section></section></main>'
  shell = app.firstElementChild
  // The layer is empty again, so nothing is mounted. The tooltip handlers live on the layer
  // itself, so they are bound here rather than once per render.
  state.mountedCardIds = new Set()
  installDotNodes()
  return shell
}

// The rail, as two levels: workspace, and the canvases inside it. A workspace row folds; a canvas
// row opens that canvas. Both names are DSH's own -- renaming one here renames it there, and what
// comes back is what gets rendered -- so neither level keeps a copy that could drift.
//
// A row's "more" is a sibling of the row rather than a child: the row is a button and a button
// cannot hold one. It rides over the row's own right edge.
function railMoreButton({ kind, id, session, title, label }) {
  const where = session === undefined || session === null ? '' : ` data-session="${escapeHtml(session)}"`
  return `<button class="rail-more" type="button" data-action="rail-menu" data-kind="${kind}" data-id="${escapeHtml(id)}"${where} data-title="${escapeHtml(title)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" aria-haspopup="menu"><svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3.6" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="12.4" r="1.4"/></svg></button>`
}

// The rename box is rendered empty and filled after the patch, the same way the panel's composer
// is: a value in the markup would make every keystroke change the rail's string, and the patch
// would then replace the box the reader is typing in.
function railRenameInput(kind, id, session) {
  const where = session === undefined || session === null ? '' : ` data-rename-session="${escapeHtml(session)}"`
  return `<input class="rail-rename" type="text" maxlength="120" data-rename-kind="${kind}" data-rename-id="${escapeHtml(id)}"${where} aria-label="重命名" placeholder="名称">`
}

function railMenuHtml(menu) {
  const where = menu.session === undefined || menu.session === null ? '' : ` data-session="${escapeHtml(menu.session)}"`
  return `<div class="rail-menu" role="menu"><button type="button" class="rail-menu-row" role="menuitem" data-action="rail-rename" data-kind="${menu.kind}" data-id="${escapeHtml(menu.id)}"${where} data-title="${escapeHtml(menu.title)}">重命名</button></div>`
}

// Which workspace a new canvas goes in. The button that starts a canvas has no directory of its
// own -- a canvas is a DSH session, and every session needs one -- so the workspace is asked for
// rather than inferred from whatever happened to be selected last.
function railChooserHtml(rail) {
  const rows = rail.map(group => `<button type="button" class="rail-menu-row" role="menuitem" data-action="choose-canvas-workspace" data-workspace="${escapeHtml(group.workspace.id)}" title="${escapeHtml(group.workspace.path ?? group.workspace.title)}">${escapeHtml(group.workspace.title)}</button>`).join('')
  return `<div class="rail-menu rail-chooser" role="menu"><p class="rail-menu-title">在哪个工作区新建画布</p>${rows || '<p class="rail-menu-title">暂未同步工作区</p>'}</div>`
}

function sidebarHtml(rail) {
  const edit = state.railEdit
  const editing = (kind, id) => edit !== null && edit.kind === kind && edit.id === id
  const menuFor = (kind, id) => state.railMenu !== null && state.railMenu.kind === kind && state.railMenu.id === id ? railMenuHtml(state.railMenu) : ''
  const groups = rail.map(group => {
    const workspace = group.workspace
    const caret = `<span class="rail-caret${group.expanded ? ' is-open' : ''}" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m6.2 3.8 4 4.2-4 4.2"/></svg></span>`
    const workspaceRow = editing('workspace', workspace.id)
      ? `<div class="workspace-row is-editing">${caret}${railRenameInput('workspace', workspace.id, undefined)}</div>`
      : `<button class="workspace-row${group.active ? ' active' : ''}" type="button" data-action="toggle-rail-group" data-workspace="${escapeHtml(workspace.id)}" aria-expanded="${group.expanded}" title="${escapeHtml(workspace.path ?? workspace.title)}">${caret}<span class="rail-workspace-name">${escapeHtml(workspace.title)}</span></button>${railMoreButton({ kind: 'workspace', id: workspace.id, title: workspace.title, label: `重命名工作区：${workspace.title}` })}${menuFor('workspace', workspace.id)}`
    if (!group.expanded) return `<section class="rail-group">${workspaceRow}</section>`
    const rows = group.canvases.map(thread => {
      const title = threadListTitle(thread)
      if (editing('canvas', thread.id)) return `<div class="tree-item is-editing">${railRenameInput('canvas', thread.id, thread.dshSessionId)}</div>`
      const more = thread.dshSessionId === null || thread.dshSessionId === undefined
        ? ''
        : railMoreButton({ kind: 'canvas', id: thread.id, session: thread.dshSessionId, title, label: `重命名画布：${title}` })
      return `<div class="tree-item${thread.id === state.activeId ? ' active' : ''}"><button class="tree-row" type="button" data-action="select-thread" data-thread="${escapeHtml(thread.id)}" data-workspace="${escapeHtml(workspace.id)}" title="${escapeHtml(title)}"><span class="tree-dot"></span><span class="tree-name">${escapeHtml(title)}</span>${thread.parentId === null ? '' : '<i>分支</i>'}</button>${more}${menuFor('canvas', thread.id)}</div>`
    }).join('')
    const body = group.canvases.length > 0 ? rows : `<p class="tree-empty">${group.loading ? '正在载入…' : '还没有画布'}</p>`
    return `<section class="rail-group">${workspaceRow}<nav class="thread-tree">${body}</nav></section>`
  }).join('')
  return `<div class="sidebar-brand-row"><div class="brand" aria-label="Chat Tree"><strong>Chat Tree</strong></div><button class="sidebar-toggle" type="button" data-action="toggle-sidebar" aria-label="${state.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}" title="${state.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2.25"/><path d="M6 2v12"/></svg></button></div><button class="new-workspace" type="button" data-action="create-session" ${state.draft !== null ? 'disabled' : ''}><svg class="new-session-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M8 4.75v6.5M4.75 8h6.5"/></svg><span>新画布</span></button><div class="rail-head"><span>工作区</span><button class="rail-add" type="button" data-action="add-workspace" aria-label="添加工作区" title="添加工作区"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M8 3.6v8.8M3.6 8h8.8"/></svg></button></div>${groups || '<p class="tree-empty">暂未同步工作区</p>'}${state.railChooser ? railChooserHtml(rail) : ''}`
}

// The rail is patched like every other region, with one exception: a rename box that is already on
// screen is left alone. Rewriting the region would replace the box and take the caret with it, and
// the point of the box is that the reader is typing in it.
function syncSidebar(shellElement, rail) {
  const sidebar = shellElement.querySelector('.sidebar')
  if (!(sidebar instanceof Element)) return
  if (state.railEdit !== null && sidebar.querySelector('.rail-rename') !== null) return
  patchSlot(sidebar, sidebarHtml(rail))
  if (state.railEdit === null) return
  const input = sidebar.querySelector('.rail-rename')
  if (!(input instanceof HTMLInputElement)) return
  input.value = state.railEdit.title
  input.focus()
  input.select()
}

// Commit what is in the box. Blank or unchanged is dropped rather than sent: DSH refuses a blank
// title, and there is nothing to say when the name did not move.
function commitRailRename() {
  const edit = state.railEdit
  if (edit === null) return
  const input = app.querySelector('.rail-rename')
  const title = input instanceof HTMLInputElement ? input.value.trim() : ''
  state.railEdit = null
  if (title === '' || title === edit.title) return render()
  render()
  post(edit.kind === 'workspace' ? 'chattree:rename-workspace' : 'chattree:rename-canvas', {
    requestId: `rename-${Date.now()}`,
    ...edit.kind === 'workspace' ? { workspaceId: edit.id } : { sessionId: edit.session },
    title
  })
}

// A renamed conversation reaches this side through the host's copy of the session, so that group
// is read again rather than guessed at. A renamed workspace does not need this: the bridge pushes
// DSH's own list, and the rail renders that.
async function reloadRailGroup(workspaceId) {
  const workspace = workspaceChoices().find(item => item.id === workspaceId)
  if (workspace === undefined) return
  try {
    state.railCache.delete(workspaceId)
    state.railLoading.add(workspaceId)
    state.railCache.set(workspaceId, await threadsForDshWorkspace(workspace, { recordArchive: false }))
    if (state.workspace !== null && state.workspace.id === `dsh:${workspaceId}`) await openDshWorkspace(workspaceId, { preserveCanvasCamera: true })
  } catch (error) {
    setError(error)
  } finally {
    state.railLoading.delete(workspaceId)
  }
  if (canReplaceView()) render()
}
function topbarHtml(canvasControls) {
  return `<div class="view-switch" role="group" aria-label="视图切换"><button data-action="close" type="button" aria-pressed="false">对话</button><button class="active" type="button" aria-pressed="true">Chat Tree</button></div>${canvasControls}`
}

// The optional children of the stage. Only .canvas-view takes part in the flex flow, so the
// floating ones come and go around it without disturbing the layout.
function syncStageChild(stage, selector, html, position) {
  const current = stage.querySelector(`:scope > ${selector}`)
  if (html === '') { current?.remove(); return }
  if (current instanceof Element && writtenHtml.get(current) === html) return
  const next = elementFromHtml(html)
  if (next === null) return
  writtenHtml.set(next, html)
  if (current instanceof Element) current.replaceWith(next)
  else if (position === 'beforeCanvas') stage.querySelector('.canvas-view')?.before(next)
  else stage.append(next)
}

function syncCanvasView(prepared) {
  const view = shell?.querySelector('.canvas-view')
  if (!(view instanceof HTMLElement)) return
  const viewport = view.querySelector('.canvas-viewport')
  if (prepared.empty) {
    if (viewport instanceof HTMLElement) viewport.hidden = true
    if (view.querySelector('.empty-canvas') === null) view.insertAdjacentHTML('afterbegin', EMPTY_CANVAS)
    return
  }
  if (viewport instanceof HTMLElement) viewport.hidden = false
  view.querySelector('.empty-canvas')?.remove()
  applyCanvasTransform()
  const connectors = view.querySelector('.connectors')
  // The connectors are an <svg>, which is an Element but not an HTMLElement.
  if (connectors instanceof Element) {
    connectors.classList.toggle('is-dot', state.canvasStyle === 'dot')
    const paths = canvasConnectors(prepared.cards)
    if (writtenHtml.get(connectors) !== paths) {
      writtenHtml.set(connectors, paths)
      connectors.innerHTML = paths
    }
  }
  syncCanvasCards(prepared.cards, prepared.graph)
  syncDraftCard(prepared.cards)
}

// Cards are reconciled, not rebuilt. A mounted card can be mid-drag or hold a scrolled answer,
// so only the ones whose markup actually changed are replaced -- and comparing the markup
// first is what makes a render that changes nothing touch nothing.
function syncCanvasCards(cards, graph) {
  const layer = shell?.querySelector('.cards-layer')
  if (!(layer instanceof HTMLElement)) return
  const visible = visibleCardIds(cards)
  for (const cardId of [...state.mountedCardIds]) {
    if (visible.has(cardId)) continue
    layer.querySelector(`[data-card-id="${selectorValue(cardId)}"]`)?.remove()
    state.mountedCardIds.delete(cardId)
  }
  for (const card of cards) {
    if (!visible.has(card.id)) continue
    const html = state.canvasStyle === 'dot' ? dotNode(card) : conversationCard(card, graph)
    const existing = layer.querySelector(`[data-card-id="${selectorValue(card.id)}"]`)
    if (existing instanceof Element && writtenHtml.get(existing) === html) continue
    const element = mountCard(html)
    if (element === null) continue
    if (existing instanceof HTMLElement) existing.replaceWith(element)
    else layer.append(element)
    state.mountedCardIds.add(card.id)
  }
}

function mountCard(html) {
  const wrapper = document.createElement('div')
  wrapper.innerHTML = html
  const element = wrapper.firstElementChild
  if (!(element instanceof Element)) return null
  writtenHtml.set(element, html)
  const handle = element.querySelector('[data-drag-card]')
  if (handle instanceof HTMLElement) bindDragHandle(handle)
  return element
}

function syncDraftCard(cards) {
  const layer = shell?.querySelector('.cards-layer')
  if (!(layer instanceof HTMLElement)) return
  const html = draftCard(cards)
  const existing = layer.querySelector('[data-card-id="draft"]')
  if (html === '') { existing?.remove(); return }
  if (existing instanceof Element) {
    if (writtenHtml.get(existing) === html) return
    const element = mountCard(html)
    if (element !== null) existing.replaceWith(element)
    return
  }
  layer.insertAdjacentHTML('beforeend', html)
}

// Everything the canvas derives before anything is drawn. Positions, the highlight path and
// the graph are recomputed every render; only the DOM they become is incremental.
function prepareCanvas() {
  const threads = state.workspace?.threads ?? []
  const freshSession = state.draft?.kind === 'new'
  const shownThreads = freshSession ? [] : threads
  if (threads.length === 0 && !freshSession) return { empty: true, cards: [], graph: null }
  const allCards = arrangedCards(shownThreads)
  // The branch line into the selected card, computed once for the whole render: the cards
  // themselves and the connectors both read it.
  state.highlightCardIds = highlightPath(state.selectedCardId, allCards)
  const graph = conversationGraphView(allCards)
  const cards = graph.cards
  state.canvasCards = cards
  state.canvasCardsById = new Map(cards.map(card => [card.id, card]))
  state.canvasGraph = graph
  if (state.inspectorCardId !== null) {
    const shown = state.canvasCardsById.get(state.inspectorCardId)
    if (shown !== undefined) {
      state.inspectorThreadId = shown.dshThreadId
    } else {
      const fallback = cards.filter(card => card.dshThreadId === state.inspectorThreadId).at(-1)
      if (fallback !== undefined) {
        state.inspectorCardId = fallback.id
        state.inspectorOpening = false
      } else {
        state.inspectorCardId = null
        state.inspectorOpening = false
        state.inspectorThreadId = null
      }
    }
  }
  if (!state.canvasViewInitialized) {
    state.canvasCamera = initialCanvasCamera(cards)
    state.canvasViewInitialized = true
    // The viewport is not laid out yet while the shell is being built; center the focused
    // card once the DOM is mounted (render tail).
    state.canvasNeedsCenter = true
  }
  return { empty: false, cards, graph }
}

function messagesForCard(card) {
  const thread = state.workspace?.threads.find(item => item.id === card.dshThreadId)
  if (thread === undefined) return { thread: null, messages: [] }
  const messages = messagesFor(thread)
  let turnIndex = -1
  let start = -1
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].kind !== 'user') continue
    turnIndex += 1
    if (turnIndex === card.turnIndex) {
      start = index
      break
    }
  }
  if (start === -1) return { thread, messages: [] }
  const end = messages.findIndex((message, index) => index > start && message.kind === 'user')
  return { thread, messages: messages.slice(start, end === -1 ? undefined : end) }
}

function cardLineage(card) {
  const byId = state.canvasCardsById
  const chain = []
  const seen = new Set()
  let current = card
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id)
    chain.unshift(current)
    current = current.parentId === null || current.parentId === undefined ? undefined : byId?.get(current.parentId)
  }
  return chain
}

// One turn as a pair of chat bubbles: what was asked, then what came back.
// `current` marks the card the panel is open on.
function cardBubblePair(card, current = false) {
  // A checkpoint has no pair to show. It is the summary standing in for the history behind it,
  // and it is drawn as the marker it is rather than as a question with a missing answer.
  if (card.compaction === true) {
    return `<div class="chat-turn${current ? ' is-current' : ''}"><div class="chat-bubble chat-bubble-compaction"><strong>上下文已压缩</strong>${card.question === '' ? '' : renderMarkdown(card.question)}</div></div>`
  }
  const answer = card.answer === null
    ? card.error === null ? '<p class="card-context-pending">等待助手回复</p>' : ''
    : `${renderMarkdown(card.answer.text)}${card.answer.pending ? '<p class="card-context-pending">正在回复</p>' : ''}`
  return `<div class="chat-turn${current ? ' is-current' : ''}"><div class="chat-bubble chat-bubble-user"><p>${escapeHtml(card.question)}</p></div><div class="chat-bubble chat-bubble-assistant">${answer}</div></div>`
}

// Everything the agent had already seen when this card ran: its ancestors'
// questions and answers, oldest first. The selected card's own turn renders
// below, so the panel carries the whole conversation that led here.
function cardContextHtml(card) {
  const lineage = cardLineage(card).slice(0, -1)
  if (lineage.length === 0) return ''
  const turns = lineage.map(item => cardBubblePair(item)).join('')
  return `<section class="card-context">${turns}</section>`
}

// A card to hang the panel on when a question arrives before the user has picked
// one. Null on an empty canvas, where the question keeps its floating position
// because no panel is rendered at all.
function inspectorFallbackCardId() {
  if ((state.workspace?.threads ?? []).length === 0) return null
  const known = card => state.canvasCardsById?.has(card.id) === true
  const cards = (state.canvasCards ?? []).filter(known)
  const selected = cards.find(card => card.id === state.selectedCardId)
  if (selected !== undefined) return selected.id
  const active = cards.filter(card => card.dshThreadId === state.activeId)
  if (active.length > 0) return active.at(-1).id
  return cards.find(card => card.canContinue === true)?.id ?? null
}

// Drag the panel's left edge. The width is clamped between the readable minimum
// and the stage width minus the edge gap, so it can never reach the left edge.
function bindInspectorResize(handle) {
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    const inspector = handle.closest('.card-inspector')
    const stage = inspector instanceof HTMLElement ? inspector.parentElement : null
    if (!(inspector instanceof HTMLElement) || !(stage instanceof HTMLElement)) return
    event.preventDefault()
    handle.setPointerCapture?.(event.pointerId)
    const right = inspector.getBoundingClientRect().right
    const limit = Math.max(INSPECTOR_MIN_WIDTH, stage.getBoundingClientRect().width - INSPECTOR_EDGE_GAP)
    const apply = width => {
      state.inspectorWidth = Math.max(INSPECTOR_MIN_WIDTH, Math.min(limit, Math.round(width)))
      inspector.style.width = `${state.inspectorWidth}px`
    }
    const onMove = move => apply(right - move.clientX)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      try { localStorage.setItem(INSPECTOR_WIDTH_KEY, String(state.inspectorWidth ?? '')) } catch { /* storage may be unavailable */ }
    }
    apply(right - event.clientX)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  })
}

// Attachment chips, and the hidden picker the paperclip opens. The File objects
// themselves travel to the DSH page over postMessage and are uploaded there.
function attachmentSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function composerAttachments() {
  if (state.attachments.length === 0) return ''
  const chips = state.attachments.map(item => `<span class="composer-attachment"><span class="composer-attachment-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>${attachmentSize(item.size) === '' ? '' : `<span class="composer-attachment-size">${attachmentSize(item.size)}</span>`}<button type="button" data-action="remove-attachment" data-attachment="${escapeHtml(item.handle)}" aria-label="移除 ${escapeHtml(item.name)}" title="移除">×</button></span>`).join('')
  return `<div class="composer-attachments">${chips}</div>`
}

function composerHiddenInput() {
  return '<input type="file" multiple data-attach-input hidden>'
}

// ---------------------------------------------------------------------------
// The option buttons on the send row
//
// Three buttons sit beside send: the permission preset, the model -- with its reasoning effort
// folded into the same menu, because an effort only means anything next to the model that
// declares it -- and how full the context window is. Each one opens a menu.
//
// The menu is rendered into its own region of the panel, never into the composer's markup:
// that region is patched as a single string, so a menu living there would rewrite the textarea
// every time it opened or closed, and rewriting the box throws away the caret.
//
// Every one of these is a read of what the Host already reported. A build that cannot answer
// leaves its button out rather than offering a control with nothing behind it.
// ---------------------------------------------------------------------------

// Occupancy needs both halves: the Host reports what the surface costs and what the route
// holds separately, so a session without a priced route has no reading -- and no reading means
// no button, exactly as the Host's own meter renders nothing.
function contextOccupancy(context) {
  const usedTokens = context?.projectedTokens ?? context?.pressureTokens
  if (!Number.isFinite(usedTokens)) return null
  if (!Number.isFinite(context?.contextWindow) || context.contextWindow <= 0) return null
  return { usedTokens, contextWindow: context.contextWindow, percent: Math.min(100, Math.round((usedTokens / context.contextWindow) * 100)) }
}

// Sizes, not bills: the occupancy figure is a heuristic, so it is rounded and marked with the
// same `~` the Host's own meter uses.
function composerTokens(value) {
  if (!Number.isFinite(value)) return '0'
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}K`
  return `${Math.round(value / 100_000) / 10}M`
}

const COMPOSER_CHECK = '<svg class="composer-menu-check" aria-hidden="true" viewBox="0 0 16 16"><path d="m3.8 8.4 2.8 2.8 5.6-5.8"/></svg>'
const COMPOSER_CHEVRON = '<svg class="composer-menu-chevron" aria-hidden="true" viewBox="0 0 16 16"><path d="m5.2 6.6 2.8 2.8 2.8-2.8"/></svg>'
const COMPOSER_ICON_PERMISSION = '<svg class="composer-trigger-icon" aria-hidden="true" viewBox="0 0 16 16"><path d="M8 2 13.4 4.1v3.3c0 3.4-2.6 5.3-5.4 6.4C5.2 12.7 2.6 10.8 2.6 7.4V4.1L8 2Z"/></svg>'
const COMPOSER_ICON_MODEL = '<svg class="composer-trigger-icon" aria-hidden="true" viewBox="0 0 16 16"><path d="M6.2 2.4h3.6M4.6 13.6h6.8M8 2.4v3M8 10.6v3M8 5.4 5.2 7.6a1.2 1.2 0 0 0 .7 2.2h4.2a1.2 1.2 0 0 0 .7-2.2L8 5.4Z"/></svg>'

// The ring is the Host's own composer meter, grown enough to hold a mark in the middle: a 2px
// stroke on an 8px circle in a 20px viewBox, filled clockwise from the top, with a list-ish
// glyph inside so the button says what it is measuring. The mark has to read at 20px, so it is
// three chunky bars rather than a drawing.
const COMPOSER_RING_SIZE = 20
const COMPOSER_RING_CENTRE = COMPOSER_RING_SIZE / 2
const COMPOSER_RING_RADIUS = 8
const COMPOSER_RING_CIRCUMFERENCE = 2 * Math.PI * COMPOSER_RING_RADIUS
const composerRingDash = percent => {
  const filled = (COMPOSER_RING_CIRCUMFERENCE * Math.min(100, Math.max(0, percent))) / 100
  return `${filled.toFixed(2)} ${COMPOSER_RING_CIRCUMFERENCE.toFixed(2)}`
}

function composerRing() {
  const centre = COMPOSER_RING_CENTRE
  // Top to bottom, as offsets from the centre: two full-width bars and a short one.
  const bars = [[-4.6, 9], [-1, 9], [2.6, 6]]
    .map(([offset, width]) => `<rect x="${centre - width / 2}" y="${centre + offset}" width="${width}" height="2" rx="1"/>`)
    .join('')
  return `<svg class="composer-ring-svg" aria-hidden="true" viewBox="0 0 ${COMPOSER_RING_SIZE} ${COMPOSER_RING_SIZE}"><circle class="composer-ring-track" cx="${centre}" cy="${centre}" r="${COMPOSER_RING_RADIUS}"/><g class="composer-ring-glyph">${bars}</g><circle class="composer-ring-fill" cx="${centre}" cy="${centre}" r="${COMPOSER_RING_RADIUS}" stroke-dasharray="${composerRingDash(0)}" transform="rotate(-90 ${centre} ${centre})"/></svg>`
}

// The model the Host says this session would use next, matched against the catalog so the
// trigger can show the catalog's own name for it.
function composerChosenModel() {
  const choice = state.composer.model
  if (choice === null || choice === undefined) return null
  const group = state.composer.models.find(item => item.provider === choice.provider) ?? null
  const entry = group?.models.find(item => item.id === choice.model) ?? null
  return { choice, entry }
}

// Everything about these buttons that changes while the reader is working is left out of the
// markup and written here instead.
//
// The composer's region is patched as a single string, so a dynamic label inside it replaced
// the textarea every time a model or preset was switched -- and replacing the box throws away
// the caret. Which buttons exist is still decided by what the Host reported, because that
// changes once per session rather than once per click.
function syncComposerOptions(panel) {
  const tools = panel.querySelector('.composer-input-tools')
  if (!(tools instanceof HTMLElement)) return
  const setLabel = (menu, label, title) => {
    const trigger = tools.querySelector(`[data-menu="${menu}"]`)
    if (!(trigger instanceof HTMLElement)) return
    const span = trigger.querySelector('.composer-trigger-label')
    // A button that carries no label still needs a name, and it is the same string the tooltip
    // shows -- kept here beside the label write so the two can never drift apart.
    if (span === null) {
      if (trigger.getAttribute('aria-label') !== label) trigger.setAttribute('aria-label', label)
    } else if (span.textContent !== label) span.textContent = label
    if (trigger.title !== title) trigger.title = title
  }
  const { permissions, permission, context } = state.composer
  if (tools.querySelector('[data-menu="permission"]') !== null) {
    const name = permissions.find(option => option.value === permission)?.name ?? permission ?? '权限'
    setLabel('permission', name, `权限：${name}`)
  }
  if (tools.querySelector('[data-menu="model"]') !== null) {
    const name = composerChosenModel()?.entry?.name ?? state.composer.model?.model ?? '模型'
    setLabel('model', name, `模型：${name}`)
  }
  const ring = tools.querySelector('[data-menu="context"]')
  if (ring instanceof HTMLElement) {
    const occupancy = contextOccupancy(context)
    const fill = ring.querySelector('.composer-ring-fill')
    if (occupancy !== null && fill instanceof Element) fill.setAttribute('stroke-dasharray', composerRingDash(occupancy.percent))
    const title = occupancy === null ? '上下文' : `上下文已用 ${occupancy.percent}%`
    if (ring.title !== title) ring.title = title
    if (ring.getAttribute('aria-label') !== title) ring.setAttribute('aria-label', title)
  }
  for (const trigger of tools.querySelectorAll('.composer-trigger[data-menu]')) {
    const open = trigger.dataset.menu === state.composerMenu
    trigger.classList.toggle('is-open', open)
    trigger.setAttribute('aria-expanded', String(open))
  }
}

function composerTrigger({ menu, icon, title, disabled, labelled = true }) {
  return `<button type="button" class="composer-tool composer-trigger${labelled ? '' : ' is-compact'}" data-action="composer-menu" data-menu="${menu}" aria-haspopup="menu" aria-expanded="false" title="${escapeHtml(title)}" ${disabled ? 'disabled' : ''}>${icon}${labelled ? '<span class="composer-trigger-label"></span>' : ''}${COMPOSER_CHEVRON}</button>`
}

// Two groups, and the spacer between them is what puts the second one against the send button:
// the permission preset belongs beside the attachment it qualifies, while the model, the
// context reading and send are the ones reached for last.
function composerOptionTriggers(disabled) {
  const left = []
  const right = []
  const { permissions, models, context } = state.composer
  // The preset is read far more often than it is changed, so the button stays a bare shield and
  // the name it is set to lives in its tooltip and its accessible label.
  if (permissions.length > 0) left.push(composerTrigger({ menu: 'permission', icon: COMPOSER_ICON_PERMISSION, title: '权限', disabled, labelled: false }))
  if (models.length > 0) right.push(composerTrigger({ menu: 'model', icon: COMPOSER_ICON_MODEL, title: '模型', disabled }))
  if (contextOccupancy(context) !== null) {
    right.push(`<button type="button" class="composer-tool composer-trigger composer-ring" data-action="composer-menu" data-menu="context" aria-haspopup="menu" aria-expanded="false" title="上下文">${composerRing()}</button>`)
  }
  return `${left.join('')}<span class="composer-tools-spacer" aria-hidden="true"></span>${right.join('')}`
}

function composerMenuRow({ action, dataset, label, detail, active, disabled }) {
  const data = Object.entries(dataset).map(([key, value]) => ` data-${key}="${escapeHtml(value)}"`).join('')
  return `<button type="button" class="composer-menu-row${active === true ? ' is-active' : ''}" role="menuitemradio" aria-checked="${active === true}" data-action="${action}"${data} ${disabled === true ? 'disabled' : ''}><span class="composer-menu-row-text"><span class="composer-menu-row-label">${escapeHtml(label)}</span>${detail === undefined || detail === null ? '' : `<span class="composer-menu-row-detail">${escapeHtml(detail)}</span>`}</span>${active === true ? COMPOSER_CHECK : ''}</button>`
}

// The catalog, grouped by provider, with the session's current choice ticked. A catalog this
// build cannot produce is reported here -- quietly, where the pickers would have been, and
// only when the menu is opened -- instead of as a banner over the canvas: the model list is an
// extra, and nothing else in the composer depends on it.
function composerMenuModel() {
  if (typeof state.composer.catalogError === 'string' && state.composer.catalogError !== '') {
    return `<p class="composer-menu-note">${escapeHtml(state.composer.catalogError)}</p>`
  }
  if (state.composer.models.length === 0) return '<p class="composer-menu-note">没有可用的模型。</p>'
  const choice = state.composer.model
  const groups = state.composer.models.map(group => {
    const rows = group.models.map(item => composerMenuRow({
      action: 'composer-pick-model',
      dataset: { provider: group.provider, model: item.id },
      label: item.name ?? item.id,
      active: choice !== null && choice !== undefined && choice.provider === group.provider && choice.model === item.id
    })).join('')
    return `<div class="composer-menu-group" role="group" aria-label="${escapeHtml(group.name)}"><span class="composer-menu-group-label">${escapeHtml(group.name)}</span>${rows}</div>`
  }).join('')
  return `<div class="composer-menu-scroll">${groups}</div>${composerMenuEfforts()}`
}

// An effort belongs to the model that declares it, so this row only exists for a model that
// has any -- and it describes the model the session would use next, not necessarily a ticked
// one. Picking a model therefore applies that model's own default effort rather than carrying
// the previous model's over: an effort is not a session-wide setting.
function composerMenuEfforts() {
  const chosen = composerChosenModel()
  const efforts = chosen?.entry?.efforts ?? []
  if (efforts.length === 0) return ''
  const current = chosen.choice.reasoningEffort ?? chosen.entry.defaultEffort
  const chips = efforts.map(effort => `<button type="button" class="composer-menu-chip${effort.id === current ? ' is-active' : ''}" data-action="composer-pick-effort" data-effort="${escapeHtml(effort.id)}" aria-pressed="${effort.id === current}">${escapeHtml(effort.name ?? effort.id)}</button>`).join('')
  return `<div class="composer-menu-efforts" role="group" aria-label="推理等级"><span class="composer-menu-group-label">推理等级</span><div class="composer-menu-chip-row">${chips}</div></div>`
}

// `danger-full-access` lifts the sandbox and stops the agent asking. It is the one preset that
// has to be asked for twice, so the row opens a confirmation instead of applying: one
// mis-click otherwise trades every guard rail for a silent session. The Host's own picker
// confirms it for the same reason.
const DANGER_PRESET = 'danger-full-access'

function composerMenuPermission() {
  const { permissions, permission } = state.composer
  if (state.composerConfirmPreset !== null) {
    const preset = permissions.find(option => option.value === state.composerConfirmPreset)
    return `<div class="composer-menu-confirm"><strong>${escapeHtml(preset?.name ?? state.composerConfirmPreset)}</strong><p>${escapeHtml(preset?.description ?? '这个预设会解除沙箱限制，并且不再逐次征询。')}</p><div class="composer-menu-confirm-actions"><button type="button" class="composer-menu-button" data-action="composer-cancel-permission">取消</button><button type="button" class="composer-menu-button is-danger" data-action="composer-confirm-permission" data-preset="${escapeHtml(state.composerConfirmPreset)}">确认切换</button></div></div>`
  }
  if (permissions.length === 0) return '<p class="composer-menu-note">没有可用的权限预设。</p>'
  return permissions.map(option => composerMenuRow({
    action: 'composer-pick-permission',
    dataset: { preset: option.value },
    label: option.name ?? option.value,
    detail: option.description,
    active: option.value === permission
  })).join('')
}

// The context menu: the reading, the split, what each part costs, and the one action that can
// change any of it.
//
// The bar is scaled the way the Host's own meter scales it -- each category's share of the
// occupied part, so the segments add up to the occupancy rather than to the window -- and the
// composition is labelled an estimate because that is what it is.
function composerMenuContext() {
  const occupancy = contextOccupancy(state.composer.context)
  const breakdown = state.composer.breakdown
  const parts = [['systemTokens', '系统提示'], ['toolsTokens', '工具'], ['messageTokens', '对话']]
  const total = parts.reduce((sum, [key]) => sum + (Number.isFinite(breakdown?.[key]) ? breakdown[key] : 0), 0)
  const known = occupancy !== null && breakdown !== null && breakdown !== undefined && total > 0
  const bar = known
    ? `<div class="composer-context-bar">${parts.map(([key], index) => {
      const value = Number.isFinite(breakdown[key]) ? breakdown[key] : 0
      return value <= 0 ? '' : `<span class="composer-context-segment segment-${index}" style="width:${(occupancy.percent * value) / total}%"></span>`
    }).join('')}</div>`
    : occupancy === null ? '' : `<div class="composer-context-bar"><span class="composer-context-segment segment-total" style="width:${occupancy.percent}%"></span></div>`
  const rows = known
    ? `<dl class="composer-context-rows">${parts.map(([key, label], index) => `<div class="composer-context-row"><dt><span class="composer-context-swatch segment-${index}"></span>${label}</dt><dd>~${composerTokens(breakdown[key])}</dd></div>`).join('')}</dl>`
    : ''
  const head = occupancy === null
    ? '<p class="composer-menu-note">这一轮还没有可用的上下文读数。</p>'
    : `<div class="composer-context-head"><span class="composer-context-headline">上下文已用</span><span class="composer-context-percent">${occupancy.percent}%</span><span class="composer-context-figures">~${composerTokens(occupancy.usedTokens)} / ${composerTokens(occupancy.contextWindow)}</span></div>`
  return `${head}${bar}${rows}${known ? '<p class="composer-menu-note">分类为估算值，用于判断余量。</p>' : ''}${composerCompactRow()}`
}

// The one write in this menu. It compresses the history the *session* keeps -- the canvas is a
// view of events the Host already projected, so nothing on the board changes; what changes is
// how much of that history the next turn carries, and a branch copies this session's log as it
// stands. Compress first, then branch, is the whole workflow.
//
// The Host owns the guards: it refuses while a turn is open, and it says so when there is
// nothing left to compact. The click is still gated here, because a button that can only
// answer "not now" is worse than one that is greyed out with the reason.
function composerCompactRow() {
  if (state.compacting) return '<div class="composer-menu-action is-busy"><span class="composer-menu-action-spinner" aria-hidden="true"></span>正在压缩上下文…</div>'
  const note = typeof state.compactNote === 'string' && state.compactNote !== '' ? `<p class="composer-menu-note">${escapeHtml(state.compactNote)}</p>` : ''
  if (state.composer.canCompact !== true) return `${note}<div class="composer-menu-action" role="none" aria-disabled="true" title="这个会话的预置没有 /compact">压缩上下文（此会话不支持）</div>`
  const busy = composerSessionBusy()
  return `${note}<button type="button" class="composer-menu-action${busy ? '' : ' is-primary'}" data-action="composer-compact" ${busy ? 'disabled' : ''} title="${busy ? '这一轮还在进行，结束后才能压缩' : '把这个会话的历史压缩成摘要'}">${busy ? '压缩上下文（回复结束后可用）' : '压缩上下文'}</button>`
}

// A session that is mid-turn cannot compact: the Host refuses, because the history it would
// replace is still being written.
function composerSessionBusy() {
  const sessionId = composerSessionId()
  if (sessionId === null) return false
  return state.pendingReplies.has(sessionId) || state.liveReplies.get(sessionId)?.running === true
}

// The open menu, or nothing. It lives outside the composer on purpose -- see the note above.
function composerMenuHtml() {
  if (state.composerMenu === 'model') return `<div class="composer-menu composer-menu-model" role="menu" aria-label="模型与推理等级">${composerMenuModel()}</div>`
  if (state.composerMenu === 'permission') return `<div class="composer-menu composer-menu-permission" role="menu" aria-label="权限">${composerMenuPermission()}</div>`
  if (state.composerMenu === 'context') return `<div class="composer-menu composer-menu-context" role="menu" aria-label="上下文用量">${composerMenuContext()}</div>`
  return ''
}

// Permission switching writes through the Host's command line -- the path the Host's own picker
// uses, and the only one that moves the preset and the sandbox/approval knobs together. The
// reply is what re-reads the projection, so nothing is assumed here.
function applyPermissionPreset(preset) {
  const sessionId = composerSessionId()
  state.composerMenu = null
  state.composerConfirmPreset = null
  render()
  if (sessionId === null || typeof preset !== 'string' || preset === '') return
  post('chattree:select-permission', { requestId: `permission-${Date.now()}`, sessionId, preset })
}

// One input for the panel. `canContinue` is set on the last turn of a session,
// i.e. the tip of that line, so it is exactly the "is this the newest node"
// test: the tip continues its own session, anything earlier forks.
// The box is rendered empty on purpose and filled by applyComposerValues() after the patch.
// Putting the typed text in the markup would make every keystroke change the foot's HTML, so
// the patch would rewrite the box -- and rewriting a focused textarea loses the caret.
function inspectorComposer(card, thread) {
  // A checkpoint is not a turn anyone can branch from: there is no answer under it to fork at.
  // It says so, rather than offering the dead input a turn with no answer used to get.
  if (card.compaction === true) {
    return '<p class="composer-note">这是上下文压缩点，不能从这里分叉。继续往下走到你想分叉的那一轮。</p>'
  }
  const usable = Number.isInteger(card.answer?.sourceSeq)
  const busy = state.inspectorSending === true || state.attaching === true || state.pendingReplies.has(thread.dshSessionId)
  // While the agent is asking, the input box waits its turn: the answer above is
  // the only thing the session will accept right now.
  const answering = pendingQuestion !== null
  const disabled = !usable || busy || answering
  const label = '创建分支'
  return `<form class="inspector-composer" data-inspector="${escapeHtml(card.id)}">${composerAttachments()}${composerHiddenInput()}<div class="composer-input"><textarea maxlength="4000" rows="1" placeholder="${usable ? label : '暂不可用'}" ${disabled ? 'disabled' : ''} aria-label="${label}"></textarea><div class="composer-input-tools"><button type="button" class="composer-tool composer-attach" data-action="attach-file" ${disabled ? 'disabled' : ''} aria-label="添加附件" title="添加附件"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M9.4 2.6 4.6 7.4a2.5 2.5 0 0 0 3.5 3.5l4.3-4.3a3.8 3.8 0 0 0-5.4-5.4L3.4 5.9a5 5 0 0 0 7.1 7.1l3.9-3.9"/></svg></button>${composerOptionTriggers(disabled)}<button class="primary composer-send" type="submit" ${disabled ? 'disabled' : ''} aria-label="${busy ? '发送中' : label}" title="${busy ? '发送中' : label}"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M8 13.4V3.1M3.6 7.5 8 3.1l4.4 4.4"/></svg></button></div></div></form>`
}

// The tallest the instruction box may grow before it starts scrolling instead.
const COMPOSER_INPUT_MAX_HEIGHT = 180

// Size the box to its own content: measure at auto, then clamp. Past the
// ceiling the textarea keeps its height and scrolls.
function autoSizeComposerInput(field) {
  if (!(field instanceof HTMLTextAreaElement)) return
  field.style.height = 'auto'
  const full = field.scrollHeight
  field.style.height = `${Math.min(full, COMPOSER_INPUT_MAX_HEIGHT)}px`
  field.style.overflowY = full > COMPOSER_INPUT_MAX_HEIGHT ? 'auto' : 'hidden'
}

// The typed text lives in state rather than in the markup (see inspectorComposer), so the box
// is filled after the patch instead. Writing only when the value actually differs is what
// keeps the caret: a box that already holds the text is left completely alone.
function applyComposerValues() {
  for (const field of document.querySelectorAll('[data-inspector] textarea')) {
    const form = field.closest('[data-inspector]')
    const stored = form instanceof HTMLElement ? state.inspectorInputs.get(form.dataset.inspector) ?? '' : ''
    if (field.value !== stored) field.value = stored
  }
}

// The height follows the stored text, so it is measured after the value is in place.
function autoSizeComposerInputs() {
  for (const field of document.querySelectorAll('[data-inspector] textarea')) autoSizeComposerInput(field)
}

// The DSH session the panel is composing for.
function composerSessionId() {
  const card = state.inspectorCardId === null ? undefined : state.canvasCardsById?.get(state.inspectorCardId)
  const threadId = card?.dshThreadId ?? state.inspectorThreadId
  if (threadId === null || threadId === undefined) return null
  const thread = state.workspace?.threads.find(item => item.id === threadId)
  return typeof thread?.dshSessionId === 'string' ? thread.dshSessionId : null
}

// Whether the panel is showing a turn that is still being written. The jump-to-bottom
// affordance pulses while it is, so "more is arriving down there" stays readable without
// dragging the reader's view along with it.
function inspectorIsStreaming() {
  const sessionId = composerSessionId()
  return sessionId !== null && state.liveReplies.get(sessionId)?.running === true
}

// The jump-to-bottom control is a scroll affordance, so it is toggled straight on the DOM
// -- here, in the scroll listener, and on every stream edge. Routing it through render()
// would rebuild the whole shell once per scroll frame, which is the one thing the reader
// is fighting.
function syncInspectorJump(scroller = document.querySelector('.card-inspector-scroll')) {
  const jump = app.querySelector('[data-action="inspector-to-bottom"]')
  if (!(jump instanceof HTMLElement)) return
  // The question dialog owns the space above the composer, so the affordance stands down
  // while it is up instead of floating over it.
  if (!(scroller instanceof HTMLElement) || pendingQuestion !== null) {
    jump.hidden = true
    jump.classList.remove('is-live')
    return
  }
  jump.hidden = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= INSPECTOR_BOTTOM_SLACK
  jump.classList.toggle('is-live', inspectorIsStreaming())
}

// A composer read that failed is re-asked on this clock at the earliest. `render()`
// calls syncComposer() on every pass, so re-asking the moment the failure arrives
// turned one unreadable session into an endless request/render loop that locked the
// canvas up -- no button took a click and the trackpad did nothing, because the main
// thread was busy rebuilding the DOM thousands of times a second.
const COMPOSER_RETRY_MS = 5000

// Compaction summarises history with a model call, so it is the one thing here that can take
// minutes. Past this the button stops claiming to be working and says so instead: the Host may
// still be compacting, and reopening the menu is how the reader finds out either way.
const COMPACT_TIMEOUT_MS = 120_000
let compactTimer = 0

// Ask the host for the model catalog, the permission presets and the context
// reading whenever the panel points at a session we have not loaded yet. Nothing
// here reports back to the user: this build leaves the catalog empty, and the panel
// used to answer that with a banner about a missing session or a reply that never
// came. Those are gone. The ask is still made, so the pickers fill in by themselves
// if a build ever answers.
function syncComposer() {
  const sessionId = composerSessionId()
  if (sessionId === null) {
    // The panel is up, but the node it shows cannot be traced back to a DSH
    // session, so nothing is asked. Remembered so the next render does not re-ask.
    if (state.inspectorCardId !== null && state.composer.requestedFor !== 'unresolved') {
      state.composer = { ...state.composer, requestedFor: 'unresolved' }
    }
    return
  }
  if (state.composer.requestedFor === sessionId) {
    // Already asked for this session. A success re-asks only when the panel moves
    // to another session; a failure waits out COMPOSER_RETRY_MS first.
    if (state.composer.failedFor !== sessionId || Date.now() < state.composer.retryAfter) return
  }
  if (state.composer.sessionId !== null && state.composer.sessionId !== sessionId) state.attachments = []
  const requestId = `composer-${Date.now()}`
  state.composer = { ...state.composer, requestedFor: sessionId, requestId, failedFor: null, retryAfter: 0 }
  post('chattree:load-composer', { requestId, sessionId })
}

async function submitInspectorMessage(form) {
  const cardId = form.dataset.inspector
  const field = form.querySelector('textarea')
  const card = cardId === undefined ? undefined : state.canvasCardsById?.get(cardId)
  const text = field instanceof HTMLTextAreaElement ? field.value.trim() : ''
  if (card === undefined || text === '') return
  const thread = state.workspace?.threads.find(item => item.id === card.dshThreadId)
  if (thread === undefined || thread.dshSessionId === null) return setError('关联的 DSH 会话已不可用')
  const atSeq = card.answer?.sourceSeq
  if (!Number.isInteger(atSeq)) return setError('这一轮还没有回答，无法创建分支')
  pendingParts = state.attachments.map(item => item.part)
  state.inspectorInputs.delete(card.id)
  state.inspectorSending = true
  state.composerMenu = null
  state.composerConfirmPreset = null
  render()
  try {
    const position = draftPlacement(arrangedCards(state.workspace?.threads ?? []))?.position
    await branchOff(thread, atSeq, card.id, text, position)
    state.attachments = []
  } catch (error) {
    // Give the text back so a failed send does not lose what was typed.
    pendingParts = []
    state.inspectorInputs.set(card.id, text)
    setError(error)
  } finally {
    state.inspectorSending = false
    render()
  }
}

// Resolve which node the panel shows right now.
function resolveInspectorCard() {
  const threadId = state.inspectorThreadId
  const cards = state.canvasCards ?? []
  const byId = state.canvasCardsById
  if (threadId !== null) {
    if (state.inspectorFollowNewest) {
      const newest = cards.filter(card => card.dshThreadId === threadId).at(-1)
      if (newest !== undefined) {
        state.inspectorCardId = newest.id
        return newest
      }
    }
    const pinned = state.inspectorCardId === null ? undefined : byId?.get(state.inspectorCardId)
    if (pinned !== undefined) return pinned
    const newest = cards.filter(card => card.dshThreadId === threadId).at(-1)
    if (newest !== undefined) return newest
    return state.inspectorCardId === null ? undefined : byId?.get(state.inspectorCardId)
  }
  return state.inspectorCardId === null ? undefined : byId?.get(state.inspectorCardId)
}

// The panel's markup, split into the regions that get patched independently. Null when
// there is no panel to show.
function inspectorPanelModel() {
  if (state.inspectorCardId === null && state.inspectorThreadId === null) return null
  const card = resolveInspectorCard()
  if (card === undefined) return null
  const { thread } = messagesForCard(card)
  if (thread === null) return null
  const openDshAction = `<button type="button" data-action="open-dsh" data-thread="${thread.id}" data-seq="${Number.isInteger(card.answer?.sourceSeq) ? card.answer.sourceSeq : ''}"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M7 3.5H4.5A1.5 1.5 0 0 0 3 5v6.5A1.5 1.5 0 0 0 4.5 13H11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M9.5 3.5h3v3M12.4 3.6 7.5 8.5"/></svg>在 DSH 中打开</button>`
  const error = card.error === null ? '' : `<section class="card-inspector-error" role="alert"><strong>本轮未完成</strong><p>${escapeHtml(card.error.text)}</p></section>`
  return {
    cardId: card.id,
    head: `<div class="card-inspector-actions">${openDshAction}</div><button class="card-inspector-close" type="button" data-action="close-card-inspector" aria-label="关闭卡片详情" title="关闭"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button>`,
    scroll: `${cardContextHtml(card)}${error}${cardBubblePair(card, true)}`,
    question: questionPanel(),
    foot: `${inspectorJumpButton()}${inspectorComposer(card, thread)}`,
  }
}

// A round, floating way back to the bottom of the panel. It deliberately is not a flex
// child: it has to come and go without nudging the content it sits above, which is the
// whole point of the affordance.
// A round, floating way back to the bottom of the panel. It deliberately is not a flex
// child: it has to come and go without nudging the content it sits above, which is the
// whole point of the affordance.
//
// It is rendered plain and dressed by syncInspectorJump(), which owns both the pulse and
// whether it belongs on screen. Carrying either of those in this markup made the foot read as
// changed every time a reply started or stopped -- and the foot is the region the composer
// lives in, so the box was replaced and the caret lost mid-sentence.
function inspectorJumpButton() {
  if (pendingQuestion !== null) return ''
  return '<button class="inspector-jump" type="button" data-action="inspector-to-bottom" hidden aria-label="回到最新" title="回到最新"><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M8 3.6v8.8M3.9 8.3 8 12.4l4.1-4.1"/></svg></button>'
}

// The panel is mounted once and patched from then on, never rebuilt.
//
// It is the one surface the reader reads *while* it changes: an answer streams into it and
// is then replaced by the saved turn. Rebuilding it handed back a fresh scroll container
// parked at 0, and remembering the offset so a later frame could put it back was always a
// race against the paint. Keeping the element keeps the place -- the container only needs
// its innerHTML rewritten, and for a given turn everything above the current answer is
// unchanged, so the offset still means what it meant.
let inspectorPanel = null

function syncInspectorPanel(model) {
  if (model === null) {
    // The panel is the menu's only home, so a menu left open would reopen with the next panel
    // on the same turn -- long after the reader had done something else.
    state.composerMenu = null
    state.composerConfirmPreset = null
    inspectorPanel?.remove()
    inspectorPanel = null
    return
  }
  if (inspectorPanel === null) {
    const stage = document.querySelector('.canvas-view')
    if (!(stage instanceof HTMLElement)) return
    inspectorPanel = document.createElement('aside')
    inspectorPanel.className = 'card-inspector'
    inspectorPanel.setAttribute('aria-label', '卡片详情')
    inspectorPanel.innerHTML = '<div class="card-inspector-resize" data-inspector-resize aria-hidden="true" title="拖动调整宽度"></div><header class="card-inspector-head"></header><div class="card-inspector-scroll"></div><div class="card-inspector-foot"></div>'
    stage.append(inspectorPanel)
    bindInspectorResize(inspectorPanel.querySelector('[data-inspector-resize]'))
  } else if (!inspectorPanel.isConnected) {
    // render() detached it for the shell rebuild, so put it back. Moving the subtree keeps
    // the scroll offset with it.
    const stage = document.querySelector('.canvas-view')
    if (!(stage instanceof HTMLElement)) return
    stage.append(inspectorPanel)
  }
  const cardChanged = inspectorPanel.dataset.inspectorCard !== model.cardId
  inspectorPanel.dataset.inspectorCard = model.cardId
  // A menu belongs to the turn it was opened over, so another turn closes it.
  if (cardChanged) { state.composerMenu = null; state.composerConfirmPreset = null }
  inspectorPanel.classList.toggle('is-opening', state.inspectorOpening === true)
  inspectorPanel.style.width = state.inspectorWidth === null ? '' : `${Math.round(state.inspectorWidth)}px`
  patchSlot(inspectorPanel.querySelector('.card-inspector-head'), model.head)
  patchSlot(inspectorPanel.querySelector('.card-inspector-scroll'), model.scroll)
  syncQuestionPanel(inspectorPanel, model.question)
  patchSlot(inspectorPanel.querySelector('.card-inspector-foot'), model.foot)
  syncComposerOptions(inspectorPanel)
  syncComposerMenu(inspectorPanel, composerMenuHtml())
  // Another turn is another document: start it at its newest end, the way opening the panel
  // does, because the scroller's old offset means nothing there. Same turn, and following
  // still holds the newest end as the answer lands. The affordance is refreshed either way,
  // because the stream decides both its pulse and whether it belongs on screen at all.
  const scroller = inspectorPanel.querySelector('.card-inspector-scroll')
  if (!(scroller instanceof HTMLElement)) return
  if (cardChanged) state.inspectorFollow = true
  if (cardChanged || state.inspectorFollow) scroller.scrollTop = scroller.scrollHeight
  syncInspectorJump(scroller)
}

// The markup each element was last given. Comparing against a live `outerHTML` does not work:
// the browser re-serializes SVG, turning self-closing tags into open/close pairs, so a card
// full of icons reads as changed on every render and gets replaced forever -- which is exactly
// the churn this is here to avoid. Comparing what we wrote is the honest test.
const writtenHtml = new WeakMap()

// Compare before writing. A region that did not change must not be touched at all: writing it
// back throws away the caret in the composer and the reader's place in the scroller.
function patchSlot(element, html) {
  if (!(element instanceof Element) || writtenHtml.get(element) === html) return
  writtenHtml.set(element, html)
  element.innerHTML = html
}

// The question dialog stands between the scroll area and the composer. The panel's CSS sizes
// it against the panel itself (`max-height: 46%`), so it has to stay a direct child rather
// than live inside a wrapper whose height is auto.
function syncQuestionPanel(panel, html) {
  const current = panel.querySelector(':scope > .question-panel')
  if (html === '') { current?.remove(); return }
  if (current instanceof Element && writtenHtml.get(current) === html) return
  const next = elementFromHtml(html)
  if (next === null) return
  writtenHtml.set(next, html)
  if (current instanceof Element) current.replaceWith(next)
  else panel.querySelector('.card-inspector-foot')?.before(next)
}

function elementFromHtml(html) {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content.firstElementChild
}

// The open menu, as its own region of the panel.
//
// It cannot live in the composer's markup: that region is patched as one string, so every open
// and close would rewrite the box the reader is typing in. It is parked just above the
// composer instead, and anchored by measuring it -- the box grows as text is typed, so a fixed
// offset would drift away from the row the buttons are on.
function syncComposerMenu(panel, html) {
  const current = panel.querySelector(':scope > .composer-menu')
  if (html === '') { current?.remove(); return }
  let element = current
  if (!(element instanceof Element)) {
    element = elementFromHtml(html)
    if (element === null) return
    writtenHtml.set(element, html)
    panel.append(element)
  } else if (writtenHtml.get(element) !== html) {
    writtenHtml.set(element, html)
    element.innerHTML = html
  }
  const foot = panel.querySelector('.card-inspector-foot')
  const height = foot instanceof HTMLElement ? foot.getBoundingClientRect().height : 0
  element.style.bottom = `${Math.round(height) + 10}px`
}

// The rail's own popovers close the same way. A click on the button that opened one is excluded,
// so the button's own handler can toggle it.
document.addEventListener('pointerdown', event => {
  if (state.railMenu === null && state.railChooser !== true) return
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest('.rail-menu, [data-action="rail-menu"], [data-action="create-session"], [data-action="add-workspace"]') !== null) return
  state.railMenu = null
  state.railChooser = false
  render()
}, true)

// Anywhere else, and the menu is gone: a menu is a question about one turn, and the reader has
// moved on. Capture phase, so a click on the canvas behind the panel closes it even though the
// canvas handles its own clicks.
document.addEventListener('pointerdown', event => {
  if (state.composerMenu === null) return
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest('.composer-menu, [data-action="composer-menu"]') !== null) return
  state.composerMenu = null
  state.composerConfirmPreset = null
  render()
}, true)

function questionPanel() {
  if (pendingQuestion === null) return ''
  const items = pendingQuestion.questions.map((question, index) => {
    const chosen = pendingQuestion.selected[question.id] ?? []
    const options = (question.options ?? []).map(option => {
      const label = option.label ?? ''
      const on = chosen.includes(label)
      return `<button class="question-option${on ? ' selected' : ''}" type="button" data-action="question-option" data-question="${index}" data-option="${escapeHtml(label)}" aria-pressed="${on ? 'true' : 'false'}"><span class="question-option-label">${escapeHtml(label)}</span>${option.description ? `<span class="question-option-desc">${escapeHtml(option.description)}</span>` : ''}</button>`
    }).join('')
    const hint = (question.options ?? []).length > 0 ? '也可以直接输入回答' : '输入你的回答'
    const typed = pendingQuestion.custom[question.id] ?? ''
    return `<section class="question-item">${question.header ? `<p class="question-header">${escapeHtml(question.header)}</p>` : ''}<p class="question-text">${escapeHtml(question.question ?? '')}</p>${question.detail ? `<p class="question-detail">${escapeHtml(question.detail)}</p>` : ''}${options === '' ? '' : `<div class="question-options">${options}</div>`}<textarea class="question-custom" data-question="${index}" rows="2" placeholder="${hint}" aria-label="回答：${escapeHtml(question.question ?? '')}">${escapeHtml(typed)}</textarea></section>`
  }).join('')
  return `<div class="question-panel" role="dialog" aria-label="Agent 提问"><div class="question-panel-head"><span class="question-eyebrow">Agent 提问</span><button class="question-dismiss" type="button" data-action="question-cancel" aria-label="关闭" title="关闭">×</button></div><div class="question-panel-body">${items}</div><div class="question-panel-foot"><button class="question-skip" type="button" data-action="question-skip">跳过</button><button class="question-submit" type="button" data-action="question-submit">提交回答</button></div></div>`
}

function questionAction(button) {
  if (button.dataset.action === 'question-option') {
    const question = pendingQuestion?.questions[Number(button.dataset.question)]
    const label = button.dataset.option
    if (question === undefined || label === undefined) return false
    const chosen = pendingQuestion.selected[question.id] ?? []
    pendingQuestion.selected[question.id] = (question.multiSelect ?? question.multi_select) === true
      ? chosen.includes(label) ? chosen.filter(item => item !== label) : [...chosen, label]
      : chosen.includes(label) ? [] : [label]
    // Patch these buttons in place: a full render would discard the free-text
    // fields the user may already have filled in.
    const group = button.parentElement
    if (group instanceof HTMLElement) {
      for (const sibling of group.querySelectorAll('.question-option')) {
        if (!(sibling instanceof HTMLElement)) continue
        const on = (pendingQuestion.selected[question.id] ?? []).includes(sibling.dataset.option)
        sibling.classList.toggle('selected', on)
        sibling.setAttribute('aria-pressed', on ? 'true' : 'false')
      }
    }
    return true
  }
  if (button.dataset.action === 'question-submit') {
    const question = pendingQuestion
    if (question === null) return false
    const typed = new Map()
    for (const field of document.querySelectorAll('.question-custom')) {
      if (field instanceof HTMLTextAreaElement) typed.set(field.dataset.question, field.value.trim())
    }
    const answers = question.questions.map((item, index) => {
      const custom = typed.get(String(index)) ?? ''
      const chosen = question.selected[item.id] ?? []
      return {
        id: item.id,
        // A typed answer replaces the selection, unless the question takes several.
        selected: custom === '' || (item.multiSelect ?? item.multi_select) === true ? chosen : [],
        ...(custom === '' ? {} : { custom })
      }
    })
    pendingQuestion = null
    render()
    post('chattree:answer-question', { requestId: question.requestId, answer: { answers } })
    return true
  }
  if (button.dataset.action === 'question-skip') {
    const question = pendingQuestion
    if (question === null) return false
    pendingQuestion = null
    render()
    post('chattree:answer-question', { requestId: question.requestId, answer: { answers: question.questions.map(item => ({ id: item.id, selected: [] })) } })
    return true
  }
  if (button.dataset.action === 'question-cancel') {
    const question = pendingQuestion
    if (question === null) return false
    pendingQuestion = null
    render()
    post('chattree:answer-question', { requestId: question.requestId, answer: null })
    return true
  }
  return false
}

function render() {
  carryOutPendingFocus()
  const workspace = state.workspace
  const threads = workspace?.threads ?? []
  const prepared = prepareCanvas()
  // The panel lives outside the shell string so its scroll container survives a render; the
  // question only floats on its own when there is no panel to hold it.
  const inspectorModel = inspectorPanelModel()
  state.inspectorRendered = inspectorModel !== null
  const choices = workspaceChoices()
  const selectedWorkspaceId = state.selectedDshWorkspaceId ?? workspace?.id
  const rail = railModel()
  const canvasControls = state.mode === 'canvas' && (threads.length > 0 || state.draft?.kind === 'new') ? `<div class="canvas-controls"><button data-action="layout" aria-label="整理" data-label="整理"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/></svg></button><button data-action="focus-active" aria-label="定位" data-label="定位"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.5v2.6M8 11.9v2.6M1.5 8h2.6M11.9 8h2.6"/></svg></button><button data-action="zoom-in" aria-label="放大" data-label="放大"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg></button><span>${Math.round(state.zoom * 100)}%</span><button data-action="zoom-out" aria-label="缩小" data-label="缩小"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3.5 8h9"/></svg></button><button data-action="toggle-canvas-style" aria-label="${state.canvasStyle === 'dot' ? '卡片模式' : '圆点模式'}" data-label="${state.canvasStyle === 'dot' ? '卡片模式' : '圆点模式'}" aria-pressed="${state.canvasStyle === 'dot' ? 'true' : 'false'}"><svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor"><circle cx="4" cy="4" r="1.6"/><circle cx="12" cy="4" r="1.6"/><circle cx="8" cy="8" r="1.6"/><circle cx="4" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/></svg></button></div>` : ''
  const shellElement = ensureShell()
  shellElement.classList.toggle('sidebar-collapsed', state.sidebarCollapsed === true)
  syncSidebar(shellElement, rail)
  patchSlot(shellElement.querySelector('.topbar'), topbarHtml(canvasControls))
  const stage = shellElement.querySelector('.main-stage')
  if (stage instanceof HTMLElement) {
    syncStageChild(stage, '.status-message', state.error ? `<div class="status-message" role="alert"><span>${escapeHtml(state.error)}</span><button data-action="dismiss-error" aria-label="关闭" title="关闭">×</button></div>` : '', 'beforeCanvas')
    syncCanvasView(prepared)
    syncStageChild(stage, '.selection-followup', selectionFollowupButton(), 'append')
    syncStageChild(stage, '.question-panel', state.inspectorRendered ? '' : questionPanel(), 'append')
  }
  syncInspectorPanel(inspectorModel)
  syncComposer()
  if (state.inspectorCardId !== null) {
    applyComposerValues()
    autoSizeComposerInputs()
  }
  cacheCardConnectors()
  // The initial camera from prepareCanvas is inset (viewport not laid out yet);
  // center it on the focused card once the canvas DOM is mounted.
  if (state.canvasNeedsCenter) {
    state.canvasNeedsCenter = false
    window.requestAnimationFrame(() => { if (state.mode === 'canvas') focusActiveCard() })
  }
  if (state.inspectorOpening) window.requestAnimationFrame(() => {
    document.querySelector('.card-inspector')?.classList.remove('is-opening')
    state.inspectorOpening = false
  })
}

function renderPreservingScroll() {
  render()
}

let inspectorCloseTimer = 0
function openCardInspector(cardId) {
  if (inspectorCloseTimer !== 0) {
    window.clearTimeout(inspectorCloseTimer)
    inspectorCloseTimer = 0
  }
  state.inspectorOpening = state.inspectorCardId === null
  // Clicking a node pins the panel to that node; sending hands it to follow mode.
  const opened = state.canvasCardsById?.get(cardId)
  state.inspectorThreadId = opened?.dshThreadId ?? state.inspectorThreadId
  state.inspectorFollowNewest = false
  // A panel that is opening, or that switched cards, starts at the newest turn.
  state.inspectorFollow = true
  state.inspectorCardId = cardId
}

function closeCardInspector({ animate = true } = {}) {
  if (state.inspectorCardId === null) return
  if (inspectorCloseTimer !== 0) window.clearTimeout(inspectorCloseTimer)
  const cardId = state.inspectorCardId
  const inspector = document.querySelector('.card-inspector')
  if (!animate || !(inspector instanceof HTMLElement)) {
    state.inspectorCardId = null
    state.inspectorThreadId = null
    state.inspectorFollowNewest = false
    state.inspectorOpening = false
    render()
    return
  }
  inspector.classList.add('is-closing')
  inspectorCloseTimer = window.setTimeout(() => {
    inspectorCloseTimer = 0
    if (state.inspectorCardId !== cardId) return
    state.inspectorCardId = null
    state.inspectorThreadId = null
    state.inspectorFollowNewest = false
    state.inspectorOpening = false
    render()
  }, 180)
}

function applyCanvasTransform() {
  const content = document.querySelector('.canvas-content')
  if (content instanceof HTMLElement) content.style.transform = `translate(${state.canvasCamera.x}px, ${state.canvasCamera.y}px) scale(${state.zoom})`
}

function bindDragHandle(handle) {
  handle.addEventListener('pointerdown', event => {
    const cardId = event.currentTarget.dataset.dragCard
    const card = event.currentTarget.closest('.thread-card')
    if (cardId === undefined || !(card instanceof HTMLElement)) return
    event.preventDefault()
    const origin = { x: event.clientX, y: event.clientY, position: { x: Number.parseFloat(card.style.left), y: Number.parseFloat(card.style.top) } }
    const aliases = card.dataset.positionKey === undefined ? [] : [card.dataset.positionKey]
    let position = origin.position
    let stopped = false
    let frame = 0
    state.dragging = true
    // Coalesce pointermove updates to one DOM pass per animation frame so a
    // high report-rate pointer cannot queue a reflow per event.
    const apply = () => {
      frame = 0
      state.cardPositions.set(cardId, { x: Math.round(position.x), y: Math.round(position.y) })
      for (const alias of aliases) state.cardPositions.set(alias, { x: Math.round(position.x), y: Math.round(position.y) })
      // Keep the virtualized data object in sync so viewport visibility and
      // connector paths track the live drag position.
      const dataCard = state.canvasCardsById?.get(cardId)
      if (dataCard !== undefined) dataCard.position = { x: position.x, y: position.y }
      card.style.left = `${position.x}px`
      card.style.top = `${position.y}px`
      refreshCardConnectors(cardId)
    }
    const move = moveEvent => {
      position = { x: origin.position.x + (moveEvent.clientX - origin.x) / state.zoom, y: origin.position.y + (moveEvent.clientY - origin.y) / state.zoom }
      if (frame === 0) frame = window.requestAnimationFrame(apply)
    }
    const stop = () => {
      if (stopped) return
      stopped = true
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
      if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
      apply()
      rememberCardPosition(cardId, position, aliases)
      state.dragging = false
      deferCanvasRefresh(120)
      // No full render: only the dragged card's inline position and its
      // connectors changed; rebuilding the whole canvas on drop is the jank.
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
    document.addEventListener('pointercancel', stop)
  })
}

function canvasViewport(target) {
  return target instanceof Element ? target.closest('.canvas-viewport') : null
}

function zoomCanvas(viewport, nextZoom, clientX, clientY) {
  const zoom = clampZoom(nextZoom)
  if (zoom === state.zoom) return
  const bounds = viewport.getBoundingClientRect()
  const localX = clientX - bounds.left
  const localY = clientY - bounds.top
  const worldX = (localX - state.canvasCamera.x) / state.zoom
  const worldY = (localY - state.canvasCamera.y) / state.zoom
  state.zoom = zoom
  state.canvasCamera = { x: localX - worldX * zoom, y: localY - worldY * zoom }
  const content = viewport.querySelector('.canvas-content')
  if (content instanceof HTMLElement) {
    // Drop the composited layer before zooming: a cached will-change raster
    // would be upscaled instead of re-rasterized, which was the original
    // zoom-blur bug. will-change re-applies via .is-panning on the next pan.
    content.style.willChange = 'auto'
    applyCanvasTransform()
    syncCanvasViewport()
    window.requestAnimationFrame(() => { content.style.willChange = '' })
  } else {
    applyCanvasTransform()
    syncCanvasViewport()
  }
  const label = document.querySelector('.canvas-controls span')
  if (label !== null) label.textContent = `${Math.round(state.zoom * 100)}%`
}

// `factor` is a ratio (1.25 to zoom in, 1/1.25 to zoom out), not an offset: a
// flat +0.1 step is invisible at 4x and a doubling at 0.1x, and zoom-out would
// stall as soon as the floor sat within one step.
function zoomCanvasAtCenter(factor) {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return
  const bounds = viewport.getBoundingClientRect()
  zoomCanvas(viewport, state.zoom * factor, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
}

// The newest branch on the canvas: the last turn of the most recently created
// conversation among the cards on screen. Every follow-up now forks a conversation, so
// this is where the user last asked something -- the canvas the rail points at is not
// necessarily where the work is.
function newestCanvasCard(cards) {
  const order = new Map((state.workspace?.threads ?? []).map((thread, index) => [thread.id, index]))
  let best
  let bestRank = -1
  let bestTurn = -1
  for (const card of cards) {
    const rank = order.get(card.dshThreadId) ?? -1
    const turn = card.turnIndex ?? 0
    if (rank > bestRank || (rank === bestRank && turn > bestTurn)) {
      best = card
      bestRank = rank
      bestTurn = turn
    }
  }
  return best
}

function focusActiveCard() {
  const viewport = document.querySelector('.canvas-viewport')
  if (!(viewport instanceof HTMLElement)) return
  const cards = state.canvasCards
  if (cards === undefined || cards.length === 0) return
  // Drafts win; otherwise the newest branch on the canvas, then the first card. Cards
  // may be unmounted (outside the viewport), so the focus target comes from the data
  // model, never from DOM queries.
  const draft = state.draft === null ? undefined
    : state.draft.kind === 'new' ? { position: { x: 86, y: 82 } } : draftPlacement(cards)
  const card = draft ?? newestCanvasCard(cards) ?? cards[0]
  const { x: left, y: top } = card.position
  const bounds = viewport.getBoundingClientRect()
  state.canvasCamera = {
    x: bounds.width / 2 - (left + CARD_WIDTH / 2) * state.zoom,
    y: bounds.height / 2 - (top + CARD_HEIGHT / 2) * state.zoom,
  }
  applyCanvasTransform()
  syncCanvasViewport()
}

let selectionFollowup = null
let selectionFollowupFrame = 0

function hideSelectionFollowup() {
  if (selectionFollowupFrame !== 0) {
    window.cancelAnimationFrame(selectionFollowupFrame)
    selectionFollowupFrame = 0
  }
  selectionFollowup = null
  const button = app.querySelector('.selection-followup')
  if (button instanceof HTMLButtonElement) button.hidden = true
}

function selectionFollowupTarget(range) {
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
  if (!(start instanceof Element) || !(end instanceof Element)) return null
  const answer = start.closest('.thread-answer')
  if (answer instanceof HTMLElement && answer.contains(end)) {
    const card = answer.closest('.thread-card[data-thread]:not(.draft-card)')
    if (card instanceof HTMLElement && card.dataset.thread !== undefined) return { threadId: card.dataset.thread }
  }
  return null
}

function updateSelectionFollowup() {
  selectionFollowupFrame = 0
  const button = app.querySelector('.selection-followup')
  const selection = window.getSelection()
  if (!(button instanceof HTMLButtonElement) || state.draft !== null || selection === null || selection.rangeCount !== 1 || selection.isCollapsed) return hideSelectionFollowup()
  const text = selection.toString().trim()
  const range = selection.getRangeAt(0)
  const target = text === '' || text.length > 4000 ? null : selectionFollowupTarget(range)
  const rect = range.getBoundingClientRect()
  if (target === null || rect.width === 0 || rect.height === 0) return hideSelectionFollowup()
  selectionFollowup = { ...target, text }
  button.dataset.thread = target.threadId
  button.style.left = `${Math.min(window.innerWidth - 12, Math.max(76, rect.right))}px`
  button.style.top = `${Math.min(window.innerHeight - 38, Math.max(8, rect.bottom + 8))}px`
  button.hidden = false
}

function queueSelectionFollowup() {
  if (selectionFollowupFrame !== 0) return
  selectionFollowupFrame = window.requestAnimationFrame(updateSelectionFollowup)
}

// Space is Figma's temporary hand tool: hold it to pan from anywhere, even
// with the pointer over a card. It must never hijack a typing caret, and a
// lost keyup (window blur, tab switch) must not leave the tool stuck on.
let spacePressed = false

function isTypingTarget(target) {
  const element = target instanceof Element ? target : document.activeElement
  return element instanceof Element && element.closest('textarea, input, select, [contenteditable="true"]') !== null
}

document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.repeat || isTypingTarget(event.target)) return
  spacePressed = true
})
document.addEventListener('keyup', event => {
  if (event.code === 'Space') spacePressed = false
})
window.addEventListener('blur', () => { spacePressed = false })

// Pan gestures, matching Figma: drag on empty canvas, middle-drag, and
// Space+drag from anywhere. The right button stays free for the context menu.
app.addEventListener('pointerdown', event => {
  const viewport = canvasViewport(event.target)
  if (!(viewport instanceof HTMLElement)) return
  if (event.button !== 0 && event.button !== 1) return
  const overControl = event.target instanceof Element && event.target.closest('.thread-card, button, textarea, select') !== null
  if (overControl && !(event.button === 0 && spacePressed && !isTypingTarget(event.target))) return
  event.preventDefault()
  const origin = { x: event.clientX, y: event.clientY, camera: { ...state.canvasCamera } }
  let pendingCamera = null
  let frame = 0
  state.canvasGesture = true
  viewport.classList.add('is-panning')
  viewport.setPointerCapture(event.pointerId)
  const apply = () => {
    frame = 0
    if (pendingCamera === null) return
    state.canvasCamera = pendingCamera
    pendingCamera = null
    applyCanvasTransform()
    syncCanvasViewport()
  }
  const move = moveEvent => {
    pendingCamera = {
      x: origin.camera.x + moveEvent.clientX - origin.x,
      y: origin.camera.y + moveEvent.clientY - origin.y,
    }
    if (frame === 0) frame = window.requestAnimationFrame(apply)
  }
  const stop = () => {
    viewport.classList.remove('is-panning')
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', stop)
    document.removeEventListener('pointercancel', stop)
    if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
    apply()
    state.canvasGesture = false
    deferCanvasRefresh(120)
  }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', stop)
  document.addEventListener('pointercancel', stop)
})

// ---------------------------------------------------------------------------
// Canvas gestures, following the Figma trackpad conventions:
//
//   two-finger scroll ................ pan, both axes, 1:1 with the fingers
//   Shift + scroll ................... pan along the other axis
//   pinch (Chromium sends ctrl+wheel). zoom at the pointer
//   Cmd + scroll / Ctrl + wheel ...... zoom at the pointer
//   scroll starting on an answer ..... scrolls that answer (native)
//   scroll anywhere else on a card ... pans (header, padding, short answers)
//
// The stock build zoomed by a fixed 0.05 step on *every* wheel event. On a Mac
// trackpad that meant two-finger scroll zoomed instead of panning, horizontal
// finger travel was dropped on the floor, and a pinch -- which the OS delivers
// as a flood of small ctrl+wheel deltas -- turned into dozens of 5% jumps per
// gesture. Zoom is exponential here, and pan and zoom are accumulated and
// applied once per animation frame instead of once per event.
//
// Which surface owns the gesture is decided once, at the start of the gesture,
// and then held for its whole life: a pan that owns the canvas is never handed
// over to a card the pointer happens to drift across.
// ---------------------------------------------------------------------------
const ZOOM_MIN = .6
// The dot graph carries no text, so it stays readable much further out than the cards do.
const ZOOM_MIN_DOT = .1
const ZOOM_MAX = 4
const ZOOM_STEP = 1.25               // the +/- buttons step by ratio, not offset
const WHEEL_PAN_SPEED = 1.25         // canvas travel per pixel of finger travel
const WHEEL_ZOOM_PER_PIXEL = .0125   // pinch deltas are ~1-20 px per event
const WHEEL_ZOOM_PER_NOTCH = .00275  // a mouse wheel notch is ~100-120 px
const WHEEL_NOTCH_PIXELS = 40        // at or above this a ctrl+wheel is a wheel
const WHEEL_GESTURE_IDLE_MS = 140    // parks the refresh once the fingers stop
const WHEEL_OWNER_IDLE_MS = 1200     // keeps the canvas owning the gesture

let wheelFrame = 0
let wheelViewport = null
let wheelPanX = 0
let wheelPanY = 0
let wheelZoomTarget = null
let wheelZoomX = 0
let wheelZoomY = 0
let wheelGestureTimer = 0
let wheelOwnerTimer = 0
let wheelCanvasOnly = false

function zoomFloor() {
  return state.canvasStyle === 'dot' ? ZOOM_MIN_DOT : ZOOM_MIN
}

function clampZoom(zoom) {
  return Math.min(ZOOM_MAX, Math.max(zoomFloor(), zoom))
}

// deltaMode: 0 = pixels (trackpads), 1 = lines (Firefox), 2 = pages.
function wheelPixels(event, viewport) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (viewport.clientHeight || 800) : 1
  return { x: event.deltaX * unit, y: event.deltaY * unit }
}

// The gesture flag parks the canvas data refresh, and `canvasOnly` remembers
// that the canvas owns this gesture. A wheel gesture has no end event, so both
// are released by timers instead -- but on very different clocks: the refresh
// resumes 140ms after the fingers stop, while the canvas keeps owning the
// gesture for WHEEL_OWNER_IDLE_MS, so a pause mid-pan never hands the canvas
// over to the card the pointer came to rest on. .is-panning promotes the
// composited layer for the duration, exactly as a pointer pan does.
function markWheelGesture(viewport, canvasOnly) {
  if (wheelViewport !== null && wheelViewport !== viewport) wheelViewport.classList.remove('is-panning')
  wheelViewport = viewport
  viewport.classList.add('is-panning')
  wheelCanvasOnly = wheelCanvasOnly || canvasOnly
  state.canvasGesture = true
  if (wheelGestureTimer !== 0) window.clearTimeout(wheelGestureTimer)
  wheelGestureTimer = window.setTimeout(() => {
    wheelGestureTimer = 0
    state.canvasGesture = false
    if (wheelViewport !== null) wheelViewport.classList.remove('is-panning')
    deferCanvasRefresh(120)
  }, WHEEL_GESTURE_IDLE_MS)
  if (wheelOwnerTimer !== 0) window.clearTimeout(wheelOwnerTimer)
  wheelOwnerTimer = window.setTimeout(() => {
    wheelOwnerTimer = 0
    wheelCanvasOnly = false
  }, WHEEL_OWNER_IDLE_MS)
}

function flushWheel() {
  wheelFrame = 0
  const viewport = wheelViewport
  if (!(viewport instanceof HTMLElement)) return
  if (wheelPanX !== 0 || wheelPanY !== 0) {
    // screen = world * zoom + camera, so subtracting the finger travel moves
    // the content with the fingers.
    state.canvasCamera = { x: state.canvasCamera.x - wheelPanX, y: state.canvasCamera.y - wheelPanY }
    wheelPanX = 0
    wheelPanY = 0
    applyCanvasTransform()
    syncCanvasViewport()
  }
  if (wheelZoomTarget !== null) {
    const target = wheelZoomTarget
    wheelZoomTarget = null
    zoomCanvas(viewport, target, wheelZoomX, wheelZoomY)
  }
}

app.addEventListener('wheel', event => {
  const viewport = canvasViewport(event.target)
  if (!(viewport instanceof HTMLElement)) return
  const target = event.target instanceof Element ? event.target : null
  // Pinch and (Cmd|Ctrl)+wheel are zoom gestures and win even over a card:
  // otherwise pinching while the pointer rests on a card would scroll it.
  const zoomGesture = event.ctrlKey || event.metaKey
  // Only a gesture that *starts* on a scrollable answer is handed to that
  // answer -- and never one that already owns the canvas, so drifting the
  // pointer across a card mid-pan cannot interrupt the pan. A card's header,
  // its padding, and an answer that does not scroll all stay with the canvas.
  if (!zoomGesture && !wheelCanvasOnly && target !== null) {
    const answer = target.closest('.thread-answer')
    if (answer instanceof HTMLElement && answer.closest('.thread-card') !== null
      && answer.scrollHeight > answer.clientHeight) {
      deferCanvasRefresh()
      return
    }
  }
  event.preventDefault()
  markWheelGesture(viewport, !zoomGesture)
  const pixels = wheelPixels(event, viewport)
  if (zoomGesture) {
    // A wheel notch is ~100-120 px while a pinch delta is single digits, so
    // magnitude tells the two apart on the same ctrlKey signal.
    const perPixel = Math.abs(pixels.y) >= WHEEL_NOTCH_PIXELS ? WHEEL_ZOOM_PER_NOTCH : WHEEL_ZOOM_PER_PIXEL
    const base = wheelZoomTarget === null ? state.zoom : wheelZoomTarget
    // Exponential, so equal steps are equal *ratios*: zooming out and back in
    // by the same gesture returns to exactly the zoom you started from.
    wheelZoomTarget = clampZoom(base * Math.exp(-pixels.y * perPixel))
    wheelZoomX = event.clientX
    wheelZoomY = event.clientY
  } else {
    wheelPanX += (event.shiftKey ? pixels.y : pixels.x) * WHEEL_PAN_SPEED
    wheelPanY += (event.shiftKey ? pixels.x : pixels.y) * WHEEL_PAN_SPEED
  }
  if (wheelFrame === 0) wheelFrame = window.requestAnimationFrame(flushWheel)
}, { passive: false })

// Track pointer-down so the card click handler can tell a plain click from a
// text-selection or drag gesture; acting on the latter would re-render and
// wipe the user's selection.
let pointerDownPosition = null
app.addEventListener('pointerdown', event => { pointerDownPosition = { x: event.clientX, y: event.clientY } })
app.addEventListener('pointerdown', event => {
  const button = event.target instanceof Element ? event.target.closest('.selection-followup') : null
  if (button instanceof HTMLButtonElement) event.preventDefault()
  else hideSelectionFollowup()
})
app.addEventListener('pointerup', queueSelectionFollowup)
app.addEventListener('scroll', hideSelectionFollowup, true)
document.addEventListener('selectionchange', queueSelectionFollowup)
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return
  // Escape closes the open menu first: it is the newest, smallest thing on screen, and it sits
  // over a panel the reader is more likely to want to keep.
  if (state.composerMenu !== null) {
    event.preventDefault()
    state.composerMenu = null
    state.composerConfirmPreset = null
    render()
    return
  }
  if (state.mode !== 'canvas' || state.inspectorCardId === null) return
  event.preventDefault()
  closeCardInspector({ animate: false })
})

app.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]')
  if (!(button instanceof HTMLElement)) {
    const card = event.target instanceof Element ? event.target.closest('.thread-card[data-thread]:not(.draft-card), .dot-node[data-thread]') : null
    if (!(card instanceof HTMLElement) || event.target instanceof Element && event.target.closest('.node-handle, textarea, select, form')) return
    // A double-click selects a word and a drag selects a range; neither is a
    // select-click, so leave the selection intact instead of re-rendering.
    if (event.detail > 1) return
    if (pointerDownPosition !== null
      && Math.hypot(event.clientX - pointerDownPosition.x, event.clientY - pointerDownPosition.y) > 4) return
    const thread = state.workspace?.threads.find(item => item.id === card.dataset.thread)
    if (thread === undefined) return
    const cardId = card.dataset.cardId
    if (cardId === undefined) return
    state.activeId = thread.id
    state.selectedCardId = cardId
    openCardInspector(cardId)
    state.error = ''
    render()
    void loadThreadHistory(thread)
    // Bidirectional current-session sync: switch DSH's current session
    // without closing the map; the client confirms via chattree:current-session.
    if (thread.dshSessionId !== null) {
      if (thread.dshSessionId !== state.currentDsh?.id) state.mapCardSessionSwitches.add(thread.dshSessionId)
      post('chattree:activate-session', { sessionId: thread.dshSessionId })
    }
    return
  }
  const thread = state.workspace?.threads.find(item => item.id === button.dataset.thread)
  try {
    if (button.dataset.action === 'follow-selection') {
      const followup = selectionFollowup
      hideSelectionFollowup()
      if (followup !== null && thread !== undefined && thread.id === followup.threadId && state.draft === null) openContinue(thread, undefined, followup.text)
      return
    }
    if (button.dataset.action === 'insert-quick-phrase' && button.dataset.quickPhrase !== undefined) insertQuickPhrase(button.dataset.quickPhrase)
    if (button.dataset.action === 'open-quick-phrase-editor') { state.quickPhraseEditorOpen = true; render() }
    if (button.dataset.action === 'close-quick-phrase-editor') { state.quickPhraseEditorOpen = false; render() }
    if (button.dataset.action === 'add-quick-phrase') {
      const editor = button.closest('.draft-quick-phrase-add')
      const input = editor?.querySelector('input')
      if (input instanceof HTMLInputElement && addQuickPhrase(input.value)) {
        render()
        window.setTimeout(() => document.querySelector('.draft-quick-phrase-add input')?.focus(), 0)
      }
    }
    if (button.dataset.action === 'remove-quick-phrase') {
      const index = Number(button.dataset.quickPhraseIndex)
      if (Number.isInteger(index) && index >= 0 && index < state.quickPhrases.length) {
        state.quickPhrases.splice(index, 1)
        persistQuickPhrases()
        render()
      }
    }
    if (button.dataset.action === 'close') post('chattree:close')
    if (button.dataset.action === 'close-card-inspector') { closeCardInspector(); return }
    if (button.dataset.action === 'inspector-to-bottom') {
      const scroller = document.querySelector('.card-inspector-scroll')
      if (scroller instanceof HTMLElement) {
        // Jump now and re-arm following, so the rest of the stream keeps pinning to the
        // bottom. A smooth scroll would race the per-chunk pinning and bounce mid-flight.
        state.inspectorFollow = true
        scroller.scrollTop = scroller.scrollHeight
        syncInspectorJump(scroller)
      }
      return
    }
    if (button.dataset.action === 'toggle-sidebar') { state.sidebarCollapsed = !state.sidebarCollapsed; render() }
    if (button.dataset.action === 'toggle-rail-group') {
      const id = button.dataset.workspace
      if (id === undefined) return
      state.railMenu = null
      state.railChooser = false
      if (state.railOpen.has(id)) state.railOpen.delete(id)
      else state.railOpen.add(id)
      persistRailOpen()
      render()
      return
    }
    // One row's "more", toggled: the same row again closes it, another row moves it.
    if (button.dataset.action === 'rail-menu') {
      const kind = button.dataset.kind
      const id = button.dataset.id
      if (kind === undefined || id === undefined) return
      const open = state.railMenu !== null && state.railMenu.kind === kind && state.railMenu.id === id
      state.railMenu = open ? null : { kind, id, session: button.dataset.session, title: button.dataset.title ?? '' }
      state.railChooser = false
      render()
      return
    }
    if (button.dataset.action === 'rail-rename') {
      const kind = button.dataset.kind
      const id = button.dataset.id
      if (kind === undefined || id === undefined) return
      state.railMenu = null
      state.railChooser = false
      state.railEdit = { kind, id, session: button.dataset.session, title: button.dataset.title ?? '' }
      render()
      return
    }
    if (button.dataset.action === 'add-workspace') {
      state.railMenu = null
      state.railChooser = false
      render()
      // The host's own chooser is modal, and its answer is a path it registers itself.
      post('chattree:add-workspace', { requestId: `add-workspace-${Date.now()}` })
      return
    }
    if (button.dataset.action === 'choose-canvas-workspace') {
      const id = button.dataset.workspace
      if (id === undefined) return
      state.railChooser = false
      const choice = workspaceChoices().find(item => item.id === id)
      // The catch-all has no directory of its own, so it falls back to the current session's.
      if (id === UNGROUPED_WORKSPACE_ID) openNewSession()
      else openNewSession(id, choice?.path)
      return
    }
    if (button.dataset.action === 'create-session') {
      state.railMenu = null
      state.railChooser = state.railChooser !== true
      render()
      return
    }
    if (button.dataset.action === 'open-current' && state.currentDsh !== null) post('chattree:open-session', { sessionId: state.currentDsh.id })
    if (button.dataset.action === 'select-thread' && button.dataset.workspace !== undefined && button.dataset.workspace !== state.selectedDshWorkspaceId) {
      // A canvas in another workspace: the canvas view shows one workspace at a time, so the
      // workspace follows the canvas rather than the reader having to switch first.
      const target = button.dataset.workspace
      const wanted = button.dataset.thread
      void openDshWorkspace(target).then(opened => {
        if (!opened) return
        const thread = state.workspace?.threads.find(item => item.id === wanted)
        if (thread !== undefined) selectCanvas(thread)
      }).catch(setError)
      return
    }
    if (button.dataset.action === 'select-thread' && thread !== undefined) {
      selectCanvas(thread)
      return
    }
    // The card title and the footer 详情 button open the card inspector, since
    // the full-page thread view is gone.
    if (button.dataset.action === 'open-card' && button.dataset.card !== undefined) {
      const cardId = button.dataset.card
      if (thread !== undefined) state.activeId = thread.id
      state.selectedCardId = cardId
      state.error = ''
      openCardInspector(cardId)
      render()
    }
    if (button.dataset.action === 'open-branch' && thread !== undefined) {
      const requestedSeq = Number(button.dataset.seq)
      if (button.dataset.card !== undefined && !Number.isInteger(requestedSeq)) return setError('请等待这张卡片的最终回答后再创建分支')
      const fallbackSeq = latestMessage(thread, 'assistant')?.sourceSeq
      openBranch(thread, Number.isInteger(requestedSeq) ? requestedSeq : fallbackSeq, button.dataset.card)
    }
    if (button.dataset.action === 'cancel-draft') { state.draft = null; state.quickPhraseEditorOpen = false; render() }
    if (button.dataset.action === 'open-dsh' && thread?.dshSessionId !== null) post('chattree:open-session', { sessionId: thread.dshSessionId, seq: Number.isInteger(Number(button.dataset.seq)) ? Number(button.dataset.seq) : undefined })
    if (button.dataset.action === 'archive-card' && button.dataset.card !== undefined && state.workspace !== null) {
      const archived = conversationCards(state.workspace.threads).find(item => item.id === button.dataset.card)
      if (archived !== undefined) await archiveCard(archived)
    }
    if (button.dataset.action === 'zoom-in') zoomCanvasAtCenter(ZOOM_STEP)
    if (button.dataset.action === 'zoom-out') zoomCanvasAtCenter(1 / ZOOM_STEP)
    if (button.dataset.action === 'toggle-canvas-style') {
      setCanvasStyle(state.canvasStyle === 'dot' ? 'card' : 'dot')
      render()
    }
    if (button.dataset.action === 'focus-active') focusActiveCard()
    if (button.dataset.action === 'dismiss-error') { state.error = ''; render() }
    if (button.dataset.action === 'attach-file') {
      const form = button.closest('[data-inspector]')
      const input = form instanceof HTMLElement ? form.querySelector('[data-attach-input]') : null
      if (input instanceof HTMLInputElement) input.click()
      return
    }
    if (button.dataset.action === 'remove-attachment' && button.dataset.attachment !== undefined) {
      state.attachments = state.attachments.filter(item => item.handle !== button.dataset.attachment)
      render()
      return
    }
    if (button.dataset.action === 'composer-menu') {
      const menu = button.dataset.menu ?? null
      state.composerConfirmPreset = null
      state.composerMenu = state.composerMenu === menu ? null : menu
      render()
      return
    }
    if (button.dataset.action === 'composer-pick-model') {
      const sessionId = composerSessionId()
      if (sessionId === null) return
      const group = state.composer.models.find(item => item.provider === button.dataset.provider)
      const effort = group?.models.find(item => item.id === button.dataset.model)?.defaultEffort
      // The menu stays open: the model and its reasoning level are one choice made in one
      // visit, so picking the model must not close the row that sets the level. The tick moves
      // and the level row below it changes, which is the feedback that the pick landed.
      render()
      // A model arrives with its own default effort. An effort is a property of the model that
      // declares it, so the previous model's level is not carried over -- it could name one the
      // new model does not have.
      post('chattree:select-model', { requestId: `model-${Date.now()}`, sessionId, provider: button.dataset.provider, model: button.dataset.model, ...effort === undefined ? {} : { reasoningEffort: effort } })
      return
    }
    if (button.dataset.action === 'composer-pick-effort') {
      const sessionId = composerSessionId()
      const current = state.composer.model
      if (sessionId === null || current === null || current === undefined) return
      state.composerMenu = null
      render()
      post('chattree:select-model', { requestId: `effort-${Date.now()}`, sessionId, provider: current.provider, model: current.model, reasoningEffort: button.dataset.effort })
      return
    }
    if (button.dataset.action === 'composer-pick-permission') {
      // The one preset that lifts the sandbox and stops the agent asking is asked for twice.
      if (button.dataset.preset === DANGER_PRESET) {
        state.composerConfirmPreset = DANGER_PRESET
        render()
        return
      }
      applyPermissionPreset(button.dataset.preset)
      return
    }
    if (button.dataset.action === 'composer-confirm-permission') {
      applyPermissionPreset(button.dataset.preset)
      return
    }
    if (button.dataset.action === 'composer-cancel-permission') {
      state.composerConfirmPreset = null
      render()
      return
    }
    if (button.dataset.action === 'composer-compact') {
      const sessionId = composerSessionId()
      if (sessionId === null || state.compacting || composerSessionBusy()) return
      state.compacting = true
      state.compactNote = null
      render()
      post('chattree:compact', { requestId: `compact-${Date.now()}`, sessionId })
      // Summarising is a model call, so it can outlast the reply that would clear this. The
      // guard is here so a lost answer cannot leave the button answering "正在压缩" forever.
      window.clearTimeout(compactTimer)
      compactTimer = window.setTimeout(() => {
        compactTimer = 0
        if (!state.compacting) return
        state.compacting = false
        state.compactNote = '压缩仍在后台进行，可以稍后重新打开这里查看。'
        render()
      }, COMPACT_TIMEOUT_MS)
      return
    }
    if (questionAction(button)) return
    if (button.dataset.action === 'layout' && state.workspace !== null) {
      resetCardPositions()
      resetCanvasCamera()
      render()
      // A drag that raced this click may still be settling; clear again on the next
      // frame so the arrangement the user asked for is the one that survives.
      window.requestAnimationFrame(() => {
        resetCardPositions()
        render()
      })
    }
  } catch (error) { setError(error) }
})

app.addEventListener('change', event => {
  const quickPhrase = event.target instanceof Element ? event.target.closest('[data-quick-phrase-index]') : null
  if (quickPhrase instanceof HTMLInputElement) {
    updateQuickPhrase(Number(quickPhrase.dataset.quickPhraseIndex), quickPhrase.value)
    return
  }
})
app.addEventListener('input', event => {
  const input = event.target
  if (!(input instanceof HTMLTextAreaElement)) return
  // Keep a half-typed inspector message across re-renders, the same way the
  // question panel does: the panel is rebuilt on every live update.
  const inspector = input.closest('[data-inspector]')
  if (inspector instanceof HTMLElement && inspector.dataset.inspector !== undefined) {
    state.inspectorInputs.set(inspector.dataset.inspector, input.value)
    autoSizeComposerInput(input)
    return
  }
  if (input.closest('[data-draft]') && state.draft !== null) state.draft.text = input.value
})
// Attachment picking and the two host-backed selects. All three are fire and
// forget: the reply re-reads host state rather than trusting the control.
// Follow the newest turn until the reader scrolls away from the bottom; from
// then on the panel stays where they left it, and scrolling back re-arms it.
app.addEventListener('scroll', event => {
  const scroller = event.target
  if (!(scroller instanceof HTMLElement) || !scroller.classList.contains('card-inspector-scroll')) return
  state.inspectorFollow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= INSPECTOR_BOTTOM_SLACK
  syncInspectorJump(scroller)
}, true)
app.addEventListener('change', event => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const sessionId = composerSessionId()
  if (sessionId === null) return
  if (target instanceof HTMLInputElement && target.matches('[data-attach-input]')) {
    const files = [...(target.files ?? [])]
    target.value = ''
    if (files.length === 0) return
    state.attaching = true
    render()
    post('chattree:attach', { requestId: `attach-${Date.now()}`, sessionId, files })
  }
})
// The rail's rename box: Enter commits, Escape drops it, and leaving it commits too -- a row is a
// name, not a document, so there is nothing to come back to.
app.addEventListener('keydown', event => {
  const input = event.target
  if (!(input instanceof HTMLInputElement) || !input.classList.contains('rail-rename')) return
  if (event.key === 'Enter') {
    event.preventDefault()
    event.stopPropagation()
    commitRailRename()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    state.railEdit = null
    render()
  }
})
app.addEventListener('focusout', event => {
  const input = event.target
  if (!(input instanceof HTMLInputElement) || !input.classList.contains('rail-rename')) return
  commitRailRename()
})

// Enter sends from the panel's box; Shift+Enter keeps the newline. While an input method is
// composing the candidate window owns Enter, so a Chinese word is never sent the moment it is
// confirmed.
app.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
  const field = event.target
  if (!(field instanceof HTMLTextAreaElement)) return
  const form = field.closest('[data-inspector]')
  if (!(form instanceof HTMLFormElement)) return
  event.preventDefault()
  form.requestSubmit()
})

app.addEventListener('submit', event => {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  if (form.matches('[data-draft]')) { event.preventDefault(); void submitDraft(); return }
  if (form.matches('[data-inspector]')) { event.preventDefault(); void submitInspectorMessage(form); return }
})

// Keep typed answers across re-renders (a live reply can re-render mid-typing).
app.addEventListener('input', event => {
  const field = event.target
  if (pendingQuestion === null || !(field instanceof HTMLTextAreaElement)) return
  if (!field.classList.contains('question-custom')) return
  pendingQuestion.custom[pendingQuestion.questions[Number(field.dataset.question)]?.id] = field.value
})

window.addEventListener('message', event => {
  if (event.origin !== window.location.origin || event.data?.source !== 'dsh-chattree') return
  const data = event.data
  if (data.type === 'chattree:map-opened') {
    // Do NOT reset the camera here: toggling dialog<->map for the same
    // session must keep the user's viewport. A fresh canvas (canvasView
    // not initialized) still centers via prepareCanvas; a real session switch
    // re-centers in the current-session handler below.
    state.mode = 'canvas'
    render()
    window.requestAnimationFrame(() => post('chattree:map-ready'))
  }
  if (data.type === 'chattree:question') {
    pendingQuestion = {
      requestId: data.requestId,
      questions: Array.isArray(data.questions) ? data.questions : [],
      selected: {},
      custom: {}
    }
    // The panel is the only place the canvas asks, so open it -- on the selected
    // card or on the tip of the active session -- rather than let the question
    // sit behind a closed panel while the agent waits.
    if (state.inspectorCardId === null) {
      const cardId = inspectorFallbackCardId()
      if (cardId !== null) {
        state.inspectorCardId = cardId
        state.inspectorThreadId = state.canvasCardsById?.get(cardId)?.dshThreadId ?? state.inspectorThreadId
        state.inspectorOpening = true
        state.inspectorFollow = true
      }
    }
    render()
  }
  if (data.type === 'chattree:composer') {
    // The reply is taken for what it is. A Host that reports no catalog is not an error and
    // gets no banner: the model button is left out of the row, and the reason it is missing
    // waits inside the menu the reader would have opened -- which is the only place it means
    // anything. The rest of the reply (permissions, context) is used either way.
    state.composer = {
      requestedFor: data.sessionId,
      requestId: null,
      failedFor: null,
      retryAfter: 0,
      sessionId: data.sessionId,
      models: Array.isArray(data.models) ? data.models : [],
      model: data.model ?? null,
      catalogError: typeof data.catalogError === 'string' ? data.catalogError : null,
      permissions: Array.isArray(data.permissions) ? data.permissions : [],
      permission: data.permission ?? null,
      context: data.context ?? null,
      breakdown: data.breakdown ?? null,
      canCompact: data.canCompact === true
    }
    render()
  }
  if (data.type === 'chattree:renamed') {
    // DSH took the name. A workspace needs nothing further -- the bridge pushed DSH's own list --
    // while a conversation's title reaches this side through the host's copy of the session, so
    // that group is read again.
    state.railEdit = null
    if (data.scope === 'canvas' && state.selectedDshWorkspaceId !== null) void reloadRailGroup(state.selectedDshWorkspaceId)
    else render()
  }
  if (data.type === 'chattree:rename-failed') {
    // DSH refuses a blank or already-taken name; the box stays open with the old name.
    state.railEdit = null
    setError(new Error(typeof data.message === 'string' ? data.message : '重命名失败'))
    render()
  }
  if (data.type === 'chattree:workspace-added') {
    // `created` is false when the directory was already a workspace: the row is already there, so
    // there is nothing to add and nothing to say about it.
    if (data.cancelled !== true && data.created === false) setError(new Error('这个目录已经在工作区里了'))
    render()
  }
  if (data.type === 'chattree:workspace-add-failed') {
    setError(new Error(typeof data.message === 'string' ? data.message : '添加工作区失败'))
    render()
  }
  if (data.type === 'chattree:compacted') {
    // Ask the composer again straight away: the whole point of the click was to watch the
    // occupancy drop, and the projection only lands after the Host has committed the summary.
    window.clearTimeout(compactTimer)
    compactTimer = 0
    state.compacting = false
    state.compactNote = typeof data.text === 'string' && data.text !== '' ? data.text : '已经压缩。'
    state.composer = { ...state.composer, requestedFor: null }
    render()
  }
  if (data.type === 'chattree:compact-failed') {
    window.clearTimeout(compactTimer)
    compactTimer = 0
    state.compacting = false
    state.compactNote = null
    // This one is an action the reader took, so it is said out loud rather than left in a menu
    // they may have closed: "nothing to compact yet" and "a turn is still open" are both
    // answers they need.
    setError(new Error(typeof data.message === 'string' ? data.message : '压缩失败'))
    render()
  }
  if (data.type === 'chattree:composer-error') {
    // The host could not read the composer's options. Surface the reason instead of
    // leaving the picker blank with no explanation, and remember which session failed
    // (matched by requestId, so a late error cannot mark the session the panel has
    // since moved to) so syncComposer() waits out COMPOSER_RETRY_MS rather than
    // re-asking from the very render this error triggers.
    const failedFor = state.composer.requestId === data.requestId ? state.composer.requestedFor : null
    if (typeof failedFor === 'string' && failedFor !== 'unresolved') {
      state.composer = { ...state.composer, failedFor, retryAfter: Date.now() + COMPOSER_RETRY_MS }
    }
    setError(new Error(typeof data.message === 'string' ? data.message : '读取输入选项失败'))
    if (canReplaceView()) render()
  }
  if (data.type === 'chattree:attached') {
    for (const item of Array.isArray(data.attachments) ? data.attachments : []) {
      if (typeof item?.handle !== 'string' || item.part === null || typeof item.part !== 'object') continue
      state.attachments.push({ handle: item.handle, name: String(item.name ?? '附件'), size: Number(item.size) || 0, part: item.part })
    }
    state.attaching = false
    render()
  }
  if (data.type === 'chattree:model-selected' || data.type === 'chattree:permission-selected') {
    // Ask for the projection again: the host owns what actually applied.
    state.composer = { ...state.composer, requestedFor: null }
    render()
  }
  if (data.type === 'chattree:theme') {
    document.documentElement.dataset.theme = data.dark === true ? 'dark' : 'light'
  }
  if (data.type === 'chattree:workspaces') {
    state.dshWorkspaces = Array.isArray(data.workspaces) ? data.workspaces.filter(workspace => typeof workspace?.id === 'string' && typeof workspace.title === 'string' && Array.isArray(workspace.sessionIds)) : []
    const current = currentDshWorkspace()
    if (current !== undefined && current.id !== state.selectedDshWorkspaceId) void openDshWorkspace(current.id).catch(setError)
    else if (state.selectedDshWorkspaceId !== null) void openDshWorkspace(state.selectedDshWorkspaceId).catch(setError)
    else if (canReplaceView()) render()
  }
  if (data.type === 'chattree:current-session') {
    const previousId = state.currentDsh?.id
    state.currentDsh = data.session
    const thread = currentDshThread()
    // A click on a node already switched DSH's current session, so the echo that comes
    // back is not a switch the user made elsewhere. `requested` names the switch the
    // canvas itself asked for; `pending` covers an echo still in flight from an earlier
    // one -- landing late, it used to re-scope the graph to another canvas and then snap
    // back on the next echo, which is the jump seen after clicking a node.
    const requested = typeof data.session?.id === 'string' && state.mapCardSessionSwitches.delete(data.session.id)
    const pending = state.mapCardSessionSwitches.size > 0
    const onActiveCanvas = thread !== undefined
      && state.canvasViewInitialized
      && state.canvasCards !== undefined
      && state.canvasCards.some(card => card.dshThreadId === thread.id)
    // Only a conversation this canvas is not already showing may take over the view.
    if (thread !== undefined && !requested && !pending && !onActiveCanvas) {
      state.activeId = thread.id
      state.selectedCardId = null
      state.inspectorCardId = null
      state.inspectorOpening = false
      if (state.workspace !== null) revealConversationThread(conversationCards(state.workspace.threads), thread.id)
    }
    const preserveCanvasCamera = requested || pending || onActiveCanvas
    if (previousId !== data.session?.id) {
      // A session switch made in DSH itself: re-center on the new session's latest turn,
      // whether it lives in the same workspace (openCurrentWorkspace returns false) or a
      // different one (it resets the camera itself).
      void openCurrentWorkspace({ preserveCanvasCamera }).then(opened => {
        if (!opened && canReplaceView()) {
          render()
          if (!preserveCanvasCamera) focusActiveCard()
        }
      }).catch(setError)
    }
    else if (canReplaceView()) render()
  }
  if (data.type === 'chattree:live-reply' && typeof data.sessionId === 'string') {
    const thread = state.workspace?.threads.find(item => item.dshSessionId === data.sessionId)
    if (thread !== undefined) {
      if (data.running === true) {
        state.liveReplies.set(data.sessionId, { running: true, text: typeof data.text === 'string' ? data.text : '' })
        syncInspectorJump()
        // Streaming: patch the live card's answer in place instead of
        // rebuilding the whole canvas on every chunk; a full render reconciles
        // at stream end. The detail view is single-thread, so keep its cheap
        // throttled full render.
        if (state.mode === 'canvas') scheduleLiveCardUpdate(data.sessionId)
        else if (canReplaceView()) scheduleLiveRender()
      } else {
        // Keep the finished text instead of dropping it here. The saved turn only arrives
        // with the next projection fetch (up to a second later), and without it
        // messagesFor() falls back to an empty pending answer: the panel collapses, its
        // scroll clamps toward the top, and the saved turn then jumps it again.
        // settlePendingReply() removes this entry once the real message lands.
        const previous = state.liveReplies.get(data.sessionId)
        const streamed = typeof data.text === 'string' && data.text !== '' ? data.text : previous?.text ?? ''
        state.liveReplies.set(data.sessionId, { running: false, text: streamed })
        syncInspectorJump()
        if (canReplaceView() || state.pendingReplies.has(data.sessionId)) renderPreservingScroll()
      }
    }
  }
  if (data.type === 'chattree:forked-session' || data.type === 'chattree:created-session' || data.type === 'chattree:message-sent') settleRpc(data.requestId, data.session ?? data)
  if (data.type === 'chattree:bridge-error') {
    state.attaching = false
    settleRpc(data.requestId, undefined, new Error(data.message))
    if (data.requestId === undefined) setError(data.message)
  }
})

post('chattree:request-current')
refreshSummaries().catch(setError)
let polling = false
let liveRenderTimer = 0
let liveCardFrame = 0
let liveCardSessionId = null
// Stream into the panel when it is showing the turn that is being written.
function applyLiveReplyToInspector(sessionId) {
  if (state.inspectorCardId === null) return
  const card = state.canvasCardsById?.get(state.inspectorCardId)
  if (card === undefined) return
  const thread = state.workspace?.threads.find(item => item.id === card.dshThreadId)
  if (thread === undefined || thread.dshSessionId !== sessionId) return
  const live = state.liveReplies.get(sessionId)
  if (live?.running !== true) return
  const bubbles = app.querySelectorAll('.card-inspector-scroll .chat-turn.is-current .chat-bubble-assistant')
  const bubble = bubbles[bubbles.length - 1]
  if (!(bubble instanceof HTMLElement)) return
  const text = live.text
  bubble.innerHTML = text.trim() === ''
    ? '<p class="card-context-pending">正在回复</p>'
    : `${renderMarkdown(text)}<p class="card-context-pending">正在回复</p>`
  // Following has to be held up here, chunk by chunk. inspectorFollow only updates on a
  // scroll event, and text growing at the bottom never fires one -- so the flag went
  // stale and the end-of-stream render yanked the panel to the bottom even though the
  // reader had long since drifted away from it. A reader who scrolled up has already
  // cleared the flag, so this never fights them.
  if (state.inspectorFollow) {
    const scroller = app.querySelector('.card-inspector-scroll')
    if (scroller instanceof HTMLElement) scroller.scrollTop = scroller.scrollHeight
  }
}

function scheduleLiveCardUpdate(sessionId) {
  // Coalesce streaming chunks to one DOM patch per animation frame.
  liveCardSessionId = sessionId
  if (liveCardFrame !== 0) return
  liveCardFrame = window.requestAnimationFrame(() => {
    liveCardFrame = 0
    if (liveCardSessionId === null) return
    const id = liveCardSessionId
    liveCardSessionId = null
    applyLiveReplyToCard(id)
    applyLiveReplyToInspector(id)
  })
}
function applyLiveReplyToCard(sessionId) {
  if (state.mode !== 'canvas') return
  // Never patch cards mid-gesture: the reflow would compete with the drag or
  // pan frame; the next live-reply chunk re-applies after the gesture ends.
  if (state.dragging || state.canvasGesture) return
  const thread = state.workspace?.threads.find(item => item.dshSessionId === sessionId)
  if (thread === undefined) return
  const live = state.liveReplies.get(sessionId)
  if (live?.running !== true) return
  const cards = app.querySelectorAll(`.thread-card[data-thread="${CSS.escape(thread.id)}"]`)
  const card = cards[cards.length - 1]
  if (!(card instanceof HTMLElement)) return
  const answer = card.querySelector('.thread-answer')
  if (!(answer instanceof HTMLElement)) return
  const text = live.text
  answer.innerHTML = text.trim() === ''
    ? '<p class="thread-answer-pending">正在回复</p>'
    : `${renderMarkdown(text)}<p class="thread-answer-pending">正在回复</p>`
}
function scheduleLiveRender() {
  if (liveRenderTimer !== 0 || !canReplaceView()) return
  liveRenderTimer = window.setTimeout(() => {
    liveRenderTimer = 0
    if (canReplaceView()) renderPreservingScroll()
  }, 120)
}
async function pollProjection() {
  if (polling || document.hidden || !canReplaceView()) return
  polling = true
  try {
    await refreshProjection()
  } finally { polling = false }
}
window.setInterval(() => { void pollProjection() }, 1_000)
