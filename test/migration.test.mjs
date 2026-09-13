// The version-5 card-id migration, run against the real source.
//
// retargetCardIds() is pulled out of index.js and evaluated, so these assertions describe
// the shipped migration rather than a copy of it. If the card id scheme ever moves again,
// this is the file that has to translate the ids an old workspaces.json still holds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'index.js'), 'utf8')

const start = source.indexOf('function retargetCardIds(workspaces) {')
assert.notEqual(start, -1, 'missing retargetCardIds')
const retargetCardIds = new Function(`${source.slice(start, source.indexOf('\n}\n', start) + 3)}\nreturn retargetCardIds`)()

// A thread whose turns carry DSH sequence numbers, the way the projection writes them.
const thread = (id, seqs, extra = {}) => ({
  id,
  messages: seqs.flatMap(seq => [
    { kind: 'user', text: `q${seq}`, sourceSeq: seq },
    { kind: 'assistant', text: `a${seq}`, sourceSeq: seq + 1 },
  ]),
  ...extra,
})

test('an archived root moves from the sequence id to the turn index', () => {
  const workspaces = [{ archivedCardIds: ['t1:turn:27'], threads: [thread('t1', [13, 27, 35])] }]
  assert.equal(retargetCardIds(workspaces), true)
  assert.deepEqual(workspaces[0].archivedCardIds, ['t1:turn-index:1'])
})

test('an index-derived root moves too, because a pending turn had no sequence yet', () => {
  // A pending message was keyed by its position in the message list: turn 0 is the first
  // user message, whose index is also 0.
  const workspaces = [{ archivedCardIds: ['t1:turn:0'], threads: [thread('t1', [13, 27, 35])] }]
  retargetCardIds(workspaces)
  assert.deepEqual(workspaces[0].archivedCardIds, ['t1:turn-index:0'])
})

test('a fork anchor is retargeted with it', () => {
  const workspaces = [{
    archivedCardIds: [],
    threads: [thread('t1', [13, 27, 35]), thread('t2', [45], { anchorCardId: 't1:turn:35' })],
  }]
  assert.equal(retargetCardIds(workspaces), true)
  assert.equal(workspaces[0].threads[1].anchorCardId, 't1:turn-index:2')
})

test('a root nothing resolves is dropped, not left to resurrect the node', () => {
  const workspaces = [{ archivedCardIds: ['gone:turn:99', 't1:turn:13'], threads: [thread('t1', [13])] }]
  retargetCardIds(workspaces)
  assert.deepEqual(workspaces[0].archivedCardIds, ['t1:turn-index:0'])
})

test('ids already in the stable form are left alone and report no change', () => {
  const workspaces = [{
    archivedCardIds: ['t1:turn-index:1'],
    threads: [thread('t1', [13, 27], { anchorCardId: 't1:turn-index:0' })],
  }]
  assert.equal(retargetCardIds(workspaces), false)
  assert.deepEqual(workspaces[0].archivedCardIds, ['t1:turn-index:1'])
  assert.equal(workspaces[0].threads[0].anchorCardId, 't1:turn-index:0')
})
