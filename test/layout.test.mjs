// The canvas arrangement, run against the real source.
//
// The layout function is pulled out of app.js and evaluated with the constants it closes
// over, so these assertions describe the shipped code rather than a copy of it.
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

// The geometry comes out of the source too, so a change to the card size or the gap is
// reflected here instead of being asserted against a stale copy.
const constants = {}
for (const name of ['CARD_WIDTH', 'CARD_HEIGHT', 'CARD_GAP_X', 'CARD_GAP_Y']) {
  const match = source.match(new RegExp(`^const ${name} = .*$`, 'm'))
  assert.ok(match, `missing ${name}`)
  constants[name] = Number(match[0].split('=')[1].trim())
  assert.ok(Number.isFinite(constants[name]), `${name} is not a number`)
}
const STEP_X = constants.CARD_WIDTH + constants.CARD_GAP_X
const STEP_Y = constants.CARD_HEIGHT + constants.CARD_GAP_Y

const layout = new Function('cards', 'threads', [
  ...Object.entries(constants).map(([name, value]) => `const ${name} = ${value}`),
  grab('function overlapsCard(position, other) {', '\n}\n'),
  grab('function firstAvailableCardPosition(position, occupied) {', '\n}\n'),
  grab('function placeConversationCards(cards) {', '\n}\n'),
  grab('function layoutConversationGraph(cards, threads) {', '\n}\n'),
  'return layoutConversationGraph(cards, threads)',
].join('\n'))

const columnOf = position => Math.round((position.x - 86) / STEP_X)
const rowOf = position => Math.round((position.y - 82) / STEP_Y)

// A card list from a compact description: each thread is a list of turns, and a thread
// with a parent forks from the parent's last card unless `from` says otherwise.
function build(threads) {
  const byId = new Map()
  const cards = []
  for (const thread of threads) {
    const list = thread.turns.map((_, index) => ({
      id: `${thread.id}:${index}`,
      dshThreadId: thread.id,
      turnIndex: index,
      parentId: index === 0 ? null : `${thread.id}:${index - 1}`,
      naturalPosition: null,
      position: { x: 0, y: 0 },
    }))
    byId.set(thread.id, list)
    cards.push(...list)
  }
  for (const thread of threads) {
    if (thread.parent === undefined) continue
    const anchor = byId.get(thread.parent)
    const from = thread.from === undefined ? anchor.length - 1 : thread.from
    byId.get(thread.id)[0].parentId = anchor[from].id
  }
  const meta = threads.map(thread => ({ id: thread.id, parentId: thread.parent ?? null }))
  return { cards, threads: meta }
}

const run = description => {
  const { cards, threads } = build(description)
  return layout(cards, threads)
}

const holesInRows = laid => {
  const rows = new Map()
  for (const card of laid) {
    const row = rowOf(card.position)
    rows.set(row, [...(rows.get(row) ?? []), columnOf(card.position)])
  }
  let holes = 0
  for (const columns of rows.values()) {
    const sorted = [...columns].sort((a, b) => a - b)
    for (let column = sorted[0]; column <= sorted[sorted.length - 1]; column++) {
      if (!sorted.includes(column)) holes += 1
    }
  }
  return holes
}

const crossings = laid => {
  const byId = new Map(laid.map(card => [card.id, card]))
  const links = laid
    .filter(card => card.parentId !== null && byId.has(card.parentId))
    .map(card => ({ from: columnOf(byId.get(card.parentId).position), to: columnOf(card.position), row: rowOf(card.position) }))
  let found = 0
  for (let i = 0; i < links.length; i++) {
    for (let j = i + 1; j < links.length; j++) {
      const a = links[i]
      const b = links[j]
      if (a.row !== b.row) continue
      if ((a.from - b.from) * (a.to - b.to) < 0) found += 1
    }
  }
  return found
}

test('a plain conversation runs straight down one column', () => {
  const laid = run([{ id: 'a', turns: [1, 2, 3, 4] }])
  assert.deepEqual(laid.map(card => rowOf(card.position)), [0, 1, 2, 3])
  assert.deepEqual(laid.map(card => columnOf(card.position)), [0, 0, 0, 0])
})

test('a branch starts on the row below the card it forked from', () => {
  const laid = run([
    { id: 'a', turns: [1, 2, 3] },
    { id: 'b', parent: 'a', from: 0, turns: [1, 2] },
  ])
  const anchor = laid.find(card => card.id === 'a:0')
  const branch = laid.find(card => card.id === 'b:0')
  assert.equal(rowOf(branch.position), rowOf(anchor.position) + 1)
})

test('siblings fork at the same row and sit side by side', () => {
  const laid = run([
    { id: 'a', turns: [1, 2] },
    { id: 'b', parent: 'a', turns: [1] },
    { id: 'c', parent: 'a', turns: [1] },
  ])
  const first = laid.find(card => card.id === 'b:0')
  const second = laid.find(card => card.id === 'c:0')
  assert.equal(rowOf(first.position), rowOf(second.position))
  assert.equal(Math.abs(columnOf(first.position) - columnOf(second.position)), 1)
})

test('no row is left with a gap in it', () => {
  const laid = run([
    { id: 'a', turns: [1, 2, 3] },
    { id: 'b', parent: 'a', turns: [1] },
    { id: 'c', parent: 'a', turns: [1, 2, 3] },
    { id: 'd', parent: 'c', turns: [1, 2] },
    { id: 'e', parent: 'b', turns: [1] },
  ])
  assert.equal(holesInRows(laid), 0)
})

test('no two connectors cross', () => {
  // The case that used to cross: a later-created branch of an earlier conversation.
  const laid = run([
    { id: 'root', turns: [1] },
    { id: 'left', parent: 'root', turns: [1] },
    { id: 'right', parent: 'root', turns: [1] },
    { id: 'rightChild', parent: 'right', turns: [1] },
    { id: 'leftChild', parent: 'left', turns: [1] },
  ])
  assert.equal(crossings(laid), 0)
})

test('a branch lands beside its parent, never on the far side of the tree', () => {
  const laid = run([
    { id: 'root', turns: [1, 2, 3, 4] },
    { id: 'a', parent: 'root', turns: [1, 2] },
    { id: 'b', parent: 'root', turns: [1, 2] },
    { id: 'deep', parent: 'a', turns: [1] },
  ])
  const parent = laid.find(card => card.id === 'a:0')
  const child = laid.find(card => card.id === 'deep:0')
  assert.equal(columnOf(child.position), columnOf(parent.position))
})

test('every card gets a cell of its own', () => {
  const laid = run([
    { id: 'a', turns: [1, 2, 3] },
    { id: 'b', parent: 'a', turns: [1, 2] },
    { id: 'c', parent: 'b', turns: [1] },
  ])
  const cells = new Set(laid.map(card => `${columnOf(card.position)}:${rowOf(card.position)}`))
  assert.equal(cells.size, laid.length)
})
