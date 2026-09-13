// Where the panel and the selection land after a question is sent.
//
// handPanelToLine() and carryOutPendingFocus() are pulled out of app.js and run against a fake
// state, so these assertions describe the shipped functions rather than a copy of them.
//
// The bug this locks: sending from the panel handed the panel to the new line, but the card it
// had been reading was left behind, and prepareCanvas() re-derives the panel's thread from that
// card -- so the panel went straight back to the old turn. Nothing later undid it either, now
// that a turn keeps its id from the moment it is asked for: carryOutPendingFocus() only acted
// when the newest id had *changed*, so it concluded there was nothing to do. The new question
// and its answer stayed invisible until the reader clicked the new node.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'app.js'), 'utf8')

const grab = (from, to) => {
  const start = source.indexOf(from)
  assert.notEqual(start, -1, `missing ${from}`)
  return source.slice(start, source.indexOf(to, start) + to.length)
}

const build = new Function('state', [
  grab('function handPanelToLine(threadId) {', '\n}\n'),
  grab('function carryOutPendingFocus() {', '\n}\n'),
  'return { handPanelToLine, carryOutPendingFocus }',
].join('\n'))

const makeState = overrides => ({
  inspectorThreadId: null,
  inspectorFollowNewest: false,
  inspectorCardId: null,
  inspectorOpening: false,
  inspectorFollow: false,
  selectedCardId: null,
  activeId: 'root',
  focusThreadId: null,
  focusCardId: null,
  focusRequestedAt: Date.now(),
  canvasCards: [],
  ...overrides
})

const card = (threadId, turnIndex) => ({ id: `${threadId}:turn-index:${turnIndex}`, dshThreadId: threadId })

test('sending hands the panel to the line and lets go of the card it was reading', () => {
  const state = makeState({ inspectorThreadId: 'root', inspectorCardId: 'root:turn-index:1', selectedCardId: 'root:turn-index:1' })
  const { handPanelToLine } = build(state)
  handPanelToLine('branch')
  assert.equal(state.inspectorThreadId, 'branch')
  assert.equal(state.inspectorFollowNewest, true)
  // This is the whole fix: a leftover card id is what prepareCanvas() re-derives the old
  // thread from, so the panel has to arrive at the new line with nothing pinned.
  assert.equal(state.inspectorCardId, null)
})

test('the hand-over runs even though the turn was already the newest one', () => {
  const state = makeState({
    focusThreadId: 'branch',
    focusCardId: 'branch:turn-index:0',
    selectedCardId: 'root:turn-index:1',
    inspectorCardId: 'root:turn-index:1',
    canvasCards: [card('root', 0), card('root', 1), card('branch', 0)]
  })
  const { carryOutPendingFocus } = build(state)
  carryOutPendingFocus()
  assert.equal(state.selectedCardId, 'branch:turn-index:0')
  assert.equal(state.activeId, 'branch')
  assert.equal(state.inspectorCardId, 'branch:turn-index:0')
  assert.equal(state.inspectorFollow, true)
})

test('the hand-over lands on the newest turn of the line, not the first', () => {
  const state = makeState({
    focusThreadId: 'branch',
    canvasCards: [card('root', 0), card('branch', 0), card('branch', 1)]
  })
  const { carryOutPendingFocus } = build(state)
  carryOutPendingFocus()
  assert.equal(state.selectedCardId, 'branch:turn-index:1')
})

test('the hand-over happens once and then lets go of the request', () => {
  const state = makeState({ focusThreadId: 'branch', canvasCards: [card('branch', 0)] })
  const { carryOutPendingFocus } = build(state)
  carryOutPendingFocus()
  assert.equal(state.focusThreadId, null)
  state.selectedCardId = 'root:turn-index:1'
  carryOutPendingFocus()
  assert.equal(state.selectedCardId, 'root:turn-index:1', 'a finished hand-over must not keep pulling the selection back')
})

test('a turn that has not been drawn yet leaves the request armed', () => {
  const state = makeState({ focusThreadId: 'branch', canvasCards: [card('root', 0)] })
  const { carryOutPendingFocus } = build(state)
  carryOutPendingFocus()
  assert.equal(state.focusThreadId, 'branch')
  assert.equal(state.selectedCardId, null)
})

test('a request that never found its card is dropped rather than carried out late', () => {
  const state = makeState({ focusThreadId: 'branch', focusRequestedAt: Date.now() - 16_000, canvasCards: [card('branch', 0)] })
  const { carryOutPendingFocus } = build(state)
  carryOutPendingFocus()
  assert.equal(state.focusThreadId, null)
  assert.equal(state.selectedCardId, null)
})

test('a closed panel is not reopened by the hand-over', () => {
  const state = makeState({ focusThreadId: 'branch', inspectorCardId: null, canvasCards: [card('branch', 0)] })
  const { carryOutPendingFocus } = build(state)
  carryOutPendingFocus()
  assert.equal(state.inspectorCardId, null)
  assert.equal(state.selectedCardId, 'branch:turn-index:0')
})

test('the send path hands the panel over through the one helper', () => {
  assert.ok(source.includes('handPanelToLine(result.thread.id)'), 'a branch must hand the panel over')
  // Setting the thread id by hand is what left the old card in place; the helper is the door.
  assert.ok(!source.includes('state.inspectorThreadId = result.thread.id'), 'the hand-over bypasses the helper')
  const helper = grab('function handPanelToLine(threadId) {', '\n}\n')
  assert.equal(/inspectorCardId\s*=\s*(\S+)/.exec(helper)?.[1], 'null', 'the helper pins a card again')
})
