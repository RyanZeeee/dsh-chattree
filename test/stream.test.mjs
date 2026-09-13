// What a turn renders while it is being written, and right after the stream stops.
//
// messagesFor() and its helpers are pulled out of app.js and evaluated against a fake
// state, so these assertions describe the shipped function rather than a copy of it.
//
// The bug this locks: the panel dropped the streamed text the moment the turn stopped,
// but the saved message only arrives with the next projection fetch (up to a second
// later). In that gap messagesFor() fell back to an empty pending answer, so the panel
// collapsed and its scroll clamped toward the top, then jumped again when the real
// message landed.
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

// It shares its line with threadsById(), so take it from its own start to the newline.
const persistedStart = source.indexOf('function persistedMessagesFor(thread) {')
assert.notEqual(persistedStart, -1, 'missing persistedMessagesFor')
const persistedMessagesFor = source.slice(persistedStart, source.indexOf('\n', persistedStart))

const buildMessagesFor = new Function('state', [
  persistedMessagesFor,
  grab('function pendingUserIndex(messages, pending) {', '\n}\n'),
  grab('function settlePendingReply(thread, messages) {', '\n}\n'),
  grab('function messagesFor(thread) {', '\n}\n'),
  'return messagesFor',
].join('\n'))

const thread = { id: 't1', dshSessionId: 's1', messages: [] }
const ask = text => ({ kind: 'user', text, at: new Date().toISOString(), sourceSeq: 1 })
const savedAnswer = text => ({ kind: 'assistant', text, at: new Date().toISOString(), sourceSeq: 2 })
const answer = messages => messages.at(-1)

function stateFor({ saved, pendingReply, liveReply }) {
  return {
    historyBySession: new Map([['s1', saved]]),
    pendingReplies: new Map(pendingReply === undefined ? [] : [['s1', pendingReply]]),
    liveReplies: new Map(liveReply === undefined ? [] : [['s1', liveReply]]),
  }
}

test('the streamed text is the pending answer while the turn runs', () => {
  const messages = buildMessagesFor(stateFor({
    saved: [ask('问题')],
    pendingReply: { text: '问题', at: Date.now() },
    liveReply: { running: true, text: '前半段' },
  }))(thread)
  assert.equal(answer(messages).text, '前半段')
  assert.equal(answer(messages).pending, true)
})

test('the finished text survives the gap before the saved turn arrives', () => {
  // The stream stopped, the projection has not landed, and the thread still holds only
  // the question. The answer must not blank out here.
  const messages = buildMessagesFor(stateFor({
    saved: [ask('问题')],
    pendingReply: { text: '问题', at: Date.now() },
    liveReply: { running: false, text: '完整回答' },
  }))(thread)
  assert.equal(answer(messages).text, '完整回答')
  assert.equal(answer(messages).pending, true)
})

test('a stream that never started still reports no answer', () => {
  // Without a stream record there is nothing to show but the pending placeholder, which
  // is what keeps this from inventing an answer for an idle turn.
  const messages = buildMessagesFor(stateFor({
    saved: [ask('问题')],
    pendingReply: { text: '问题', at: Date.now() },
  }))(thread)
  assert.equal(answer(messages).text, '')
  assert.equal(answer(messages).pending, true)
})

test('the saved turn wins once it lands, and the stream record goes with it', () => {
  const state = stateFor({
    saved: [ask('问题'), savedAnswer('完整回答')],
    pendingReply: { text: '问题', at: Date.now() },
    liveReply: { running: false, text: '完整回答' },
  })
  const messages = buildMessagesFor(state)(thread)
  assert.equal(answer(messages).text, '完整回答')
  assert.equal(answer(messages).pending, undefined)
  assert.equal(state.pendingReplies.has('s1'), false, 'the pending marker was not settled')
  assert.equal(state.liveReplies.has('s1'), false, 'the stream record outlived the saved turn')
})
