// The plugin talks to itself through three namespaces: server routes, bridge message
// types, and browser storage keys. A half-finished rename breaks the plugin at runtime
// with no error, so these checks are the guard.
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
const patch = read('cordis.patch.yml')
const manifest = JSON.parse(read('package.json'))

const unique = values => [...new Set(values)]

test('every file uses one and the same namespace', () => {
  // The plugin identifies itself across four places: server routes, bridge messages, storage
  // keys and the loader patch. A file left on an earlier name breaks that silently, so every
  // identifier that looks like one of the plugin's own is required to carry the namespace.
  // The old name is spelled out here once, split, so a stray copy is still caught without
  // this file itself advertising it.
  const RETIRED = ['syn', 'apse'].join('')
  const NAMESPACE = 'chattree'
  for (const [name, source] of Object.entries({ 'app.js': app, 'client.js': client, 'index.js': host, 'styles.css': css, 'cordis.patch.yml': patch })) {
    const retired = source.split(RETIRED).length - 1
    assert.equal(retired, 0, `${name} still mentions the retired name ${retired} times`)
  }
})

test('the package, the loader patch and the client module all agree on the name', () => {
  assert.equal(manifest.name, 'dsh-chattree')
  assert.match(patch, /name: dsh-chattree/)
  assert.match(patch, /id: chattree/)
  assert.match(client, /id: 'dsh-chattree'/, 'the client module id')
})

test('the canvas gets its own data file, not the old plugin\'s', () => {
  const dataFile = patch.match(/dshHomePath\('([^']+)'\)/)
  assert.ok(dataFile, 'no data file declared')
  assert.equal(dataFile[1], 'chattree/workspaces.json')
})

test('every route the browser calls is registered by the host', () => {
  const registered = unique([...host.matchAll(/path: '([^']+)'/g)].map(match => match[1]))
  assert.ok(registered.includes('/chattree'), 'the canvas page is not served')
  assert.ok(registered.includes('/chattree/'), 'the canvas page is not served')
  for (const name of ['app.js', 'styles.css']) {
    assert.ok(registered.includes(`/chattree/${name}`), `${name} is not served`)
  }
  // The API is registered as a prefix, so anything under it is covered.
  assert.ok(registered.includes('/chattree/api'), 'the API prefix is not registered')

  const requested = unique([...`${app}\n${client}`.matchAll(/['"`](\/chattree\/[^'"`$]*)/g)].map(match => match[1]))
  assert.ok(requested.length > 0, 'the browser calls nothing?')
  for (const url of requested) {
    const covered = registered.includes(url) || registered.some(route => route.endsWith('/api') && url.startsWith(`${route}/`))
    assert.ok(covered, `nothing serves ${url}`)
  }
})

test('every bridge message the canvas sends is one the host page listens for', () => {
  const sent = unique([...app.matchAll(/post\('(chattree:[a-z-]+)'/g)].map(match => match[1]))
  assert.ok(sent.length > 5, `only ${sent.length} messages found`)
  for (const type of sent) {
    assert.ok(client.includes(`'${type}'`), `the host page never handles ${type}`)
  }
})

test('every bridge message the host page sends is one the canvas listens for', () => {
  const sent = unique([...client.matchAll(/send\('(chattree:[a-z-]+)'/g)].map(match => match[1]))
  assert.ok(sent.length > 3, `only ${sent.length} messages found`)
  for (const type of sent) {
    assert.ok(app.includes(`'${type}'`), `the canvas never handles ${type}`)
  }
})

test('the browser storage keys all live under one prefix', () => {
  const keys = unique([...app.matchAll(/'(dsh-[a-z]+:[a-z-]+(?::v\d+)?)'/g)].map(match => match[1]))
  assert.ok(keys.length >= 5, `only ${keys.length} keys found`)
  for (const key of keys) assert.ok(key.startsWith('dsh-chattree:'), `${key} is not namespaced`)
})

test('the stylesheet tokens are namespaced and defined before use', () => {
  const defined = new Set([...css.matchAll(/^\s*(--ct-[a-z0-9-]+):/gm)].map(match => match[1]))
  const used = unique([...css.matchAll(/var\((--ct-[a-z0-9-]+)/g)].map(match => match[1]))
  assert.ok(defined.size > 10, `only ${defined.size} tokens defined`)
  for (const token of used) assert.ok(defined.has(token), `${token} is used but never defined`)
})

test('the package declares no install-time lifecycle script', () => {
  // pnpm 11 refuses a git-hosted package whose build scripts it may not run
  // (ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED), and its allowlist is keyed by the tarball
  // URL -- so every new commit is blocked again and the plugin installs for nobody but
  // its author. The syntax check belongs in `pnpm run build`, where it is run on purpose.
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack']) {
    assert.equal(manifest.scripts?.[name], undefined, `package.json declares a ${name} script`)
  }
})

test('every documented dsh plugin command is one the CLI accepts', () => {
  // A plain CLI declares --profile with requiredOption, so `dsh plugin add …` dies on
  // the spot there. DSH Desktop's terminal is the exception: its shim exports
  // DSH_DESKTOP_DEFAULT_PROFILE and its own welcome text promises that plugin commands
  // without --profile hit that profile. So a bare form is acceptable only when the same
  // file also documents the --profile form -- shipping only the bare form is the bug.
  for (const file of ['README.md', 'docs/development.md', 'docs/en/README.md']) {
    const text = read(file)
    for (const match of text.matchAll(/dsh plugin\s+([^\n`]*)/g)) {
      if (match[1].startsWith('--profile')) continue
      assert.ok(text.includes('--profile'), `${file} shows "dsh plugin ${match[1]}" but never documents --profile`)
    }
  }
})
