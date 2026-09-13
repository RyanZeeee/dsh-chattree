// Compatibility locks for running the same plugin in DSH Desktop and in a plain
// `dsh web` profile.
//
// Desktop adds two Host services on top of the ordinary DSH contract -- desktopProfiles
// and desktopPnpm -- and the plugin-development guidance is explicit about a plugin that
// wants to run in both:
//
//   - never put a Desktop service in a top-level required `inject`; check
//     `ctx.get('desktopProfiles')` first and scope the pair inside a nested `ctx.inject`;
//   - never infer the Desktop profile from process.argv, ctx.baseUrl, settings or
//     $DSH_HOME -- in Desktop it is `desktopProfiles.current`;
//   - do not depend on desktopRuntime, desktopPnpmBootstrap, ELECTRON_RUN_AS_NODE,
//     BrowserWindow, the generated shims or the tray registry.
//
// This plugin needs neither Desktop service, so its compatibility is locked by asserting
// that none of those surfaces or inference shortcuts appear at all.
// https://github.com/anywhere-labs/dsh-desktop/blob/master/docs/plugin-development.md
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = name => readFileSync(join(root, name), 'utf8')
const sources = {
  'index.js': read('index.js'),
  'client.js': read('client.js'),
  'app.js': read('app.js'),
}

// Desktop's public services plus the internals the guidance says not to depend on.
const DESKTOP_ONLY = [
  'desktopProfiles',
  'desktopPnpm',
  'desktopPnpmBootstrap',
  'desktopRuntime',
  'ELECTRON_RUN_AS_NODE',
  'BrowserWindow',
]

test('nothing depends on a Desktop-only service or internal', () => {
  for (const [file, source] of Object.entries(sources)) {
    for (const surface of DESKTOP_ONLY) {
      assert.ok(!source.includes(surface), `${file} depends on the Desktop-only surface "${surface}"`)
    }
  }
})

test('no profile is inferred from the environment', () => {
  // In Desktop the profile comes from desktopProfiles.current, never from argv, the base
  // URL, settings or the harness home. This plugin reads no profile at all, so none of
  // those guesses may appear.
  for (const file of ['index.js', 'client.js']) {
    assert.ok(!/process\.argv/.test(sources[file]), `${file} infers a profile from process.argv`)
    assert.ok(!/\bbaseUrl\b/.test(sources[file]), `${file} infers a profile from ctx.baseUrl`)
    assert.ok(!/DSH_HOME/.test(sources[file]), `${file} infers a profile from DSH_HOME`)
    assert.ok(!/['"]desktop['"]/.test(sources[file]), `${file} hard-codes the desktop profile name`)
  }
})

test('both halves declare what they need, so a missing service fails loudly', () => {
  // The guidance asks for clear declarations over runtime coincidence: an undeclared
  // service leaves the fiber pending instead of half-working, which is how a plugin that
  // only happens to work in one host gets shipped.
  assert.match(sources['index.js'], /export const inject = \[/, 'the host half declares no inject list')
  assert.match(sources['client.js'], /module\.exports\.inject = \[/, 'the client half declares no inject list')
})
