// What the host does when it is handed a session to replay.
//
// The bug this locks: the replay loop walked `session.events` directly. The live session object
// this build hands out has no such field, so every replay threw
// `TypeError: session.events is not iterable` -- and because the replay is reported rather than
// thrown, the only trace was a warning line and a canvas that was never re-seeded from its
// session log.
//
// WorkspaceStore.sessionLog() is pulled out of index.js and run against a fake context, so these
// assertions describe the shipped method rather than a copy of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'index.js'), 'utf8')

const start = source.indexOf('  async sessionLog(session) {')
assert.notEqual(start, -1, 'missing sessionLog')
const end = source.indexOf('\n  }\n', start)
assert.notEqual(end, -1, 'missing the end of sessionLog')
const body = source.slice(source.indexOf('{', start) + 1, end)

// The method as it is written, bound to whatever `this` the test wants.
const sessionLog = new Function(`return async function sessionLog(session) {${body}\n}`)()

const event = seq => ({ seq, type: 'user/message', time: '2026-01-01T00:00:00.000Z', data: { content: [{ type: 'text', text: `turn ${seq}` }] } })
const storeWith = ctx => ({ ctx })

test('a session with no event list has its log read from the query service', async () => {
  const calls = []
  const read = { events: [event(0), event(1)] }
  const store = storeWith({ get: name => name === 'sessionQuery' ? { readSession: id => { calls.push(id); return Promise.resolve(read) } } : undefined })
  const events = await sessionLog.call(store, { id: 's1', header: {} })
  assert.deepEqual(calls, ['s1'], 'the session was not read')
  assert.equal(events.length, 2)
  assert.deepEqual(events[1].data.content[0].text, 'turn 1', 'the payload is what gets projected')
})

test('a build that does hand the log out on the session never touches the query', async () => {
  let asked = false
  const ctx = { get: () => { asked = true; return { readSession: () => Promise.resolve({ events: [] }) } } }
  const events = await sessionLog.call(storeWith(ctx), { id: 's1', events: [event(0)] })
  assert.equal(events.length, 1, 'the log on the session was not used')
  assert.equal(asked, false, 'the query was consulted anyway')
})

test('a log that is present but not iterable falls through to the query', async () => {
  // `session.events` as a plain object is exactly the shape that produced the original TypeError.
  const ctx = { get: () => ({ readSession: () => Promise.resolve({ events: [event(0)] }) }) }
  const events = await sessionLog.call(storeWith(ctx), { id: 's1', events: { 0: event(0) } })
  assert.equal(events.length, 1)
})

test('a build without the query service reports an empty log instead of throwing', async () => {
  assert.deepEqual(await sessionLog.call(storeWith({ get: () => undefined }), { id: 's1' }), [])
  assert.deepEqual(await sessionLog.call(storeWith(undefined), { id: 's1' }), [], 'a store without a context')
  assert.deepEqual(await sessionLog.call(storeWith({ get: () => ({ readSession: 'not a function' }) }), { id: 's1' }), [])
})

test('an unreadable log is reported once and treated as empty', async () => {
  const warnings = []
  const ctx = {
    get: () => ({ readSession: () => Promise.reject(new Error('SESSION_QUERY_SESSION_NOT_FOUND')) }),
    logger: { warn: error => warnings.push(error.message) }
  }
  assert.deepEqual(await sessionLog.call(storeWith(ctx), { id: 's1' }), [])
  assert.deepEqual(warnings, ['SESSION_QUERY_SESSION_NOT_FOUND'])
})

test('a read that answers something unexpected is treated as empty', async () => {
  const ctx = { get: () => ({ readSession: () => Promise.resolve({ events: 'nope' }) }) }
  assert.deepEqual(await sessionLog.call(storeWith(ctx), { id: 's1' }), [])
})

test('the replay never walks a field the session may not have', () => {
  const project = source.slice(source.indexOf('async projectSession('), source.indexOf('/** Project one committed DSH session event.'))
  assert.ok(project.includes('const events = await this.sessionLog(session)'), 'the log is read through sessionLog')
  assert.ok(!/for \(const event of session\.events\)/.test(project), 'the replay still walks session.events directly')
  assert.ok(source.includes('async sessionLog(session)'), 'sessionLog is gone')
  assert.ok(source.includes("query.readSession(session.id)"), 'the query service is the door')
  // listEvents returns metadata only (no `data`), so it cannot carry a projection.
  assert.ok(!/\.listEvents\(/.test(source), 'listEvents was called, and it carries no payload')
})
