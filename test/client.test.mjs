/**
 * Self-check for the browser half. Runs the real client bundle in node with a
 * fake loader, then checks the parts that break silently at runtime: the slot
 * wiring, the config toggle, and the three-way grouping.
 *
 * The DOM seam (bell inside the shell header, list body swap) is verified
 * against the running app instead, because a hand-rolled DOM fake would test
 * the fake, not the shell.
 *
 *   node test/client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

/** Minimal loader harness: the bundle is a classic script that registers a factory. */
function loadBundle() {
  let registered = null
  const frames = []
  const window = { __ModuleLoader__: { load: (spec) => { registered = spec } } }
  const storage = new Map()
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value))
  }
  const document = {
    body: { nodeType: 1 },
    head: { appendChild: () => {} },
    getElementById: () => null,
    createElement: () => ({ dataset: {}, setAttribute: () => {}, appendChild: () => {}, addEventListener: () => {}, remove: () => {} }),
    querySelector: () => null,
    querySelectorAll: () => []
  }
  const observers = []
  class MutationObserver {
    constructor(handler) {
      this.handler = handler
      observers.push(this)
    }
    observe() {}
    disconnect() {
      this.disconnected = true
    }
  }
  globalThis.requestAnimationFrame = (fn) => frames.push(fn)
  new Function('window', 'localStorage', 'document', 'MutationObserver', source)(window, localStorage, document, MutationObserver)
  assert.ok(registered, 'bundle did not call window.__ModuleLoader__.load')
  assert.equal(registered.id, 'dsh-activity-view')

  const React = {
    createElement: () => null,
    Fragment: 'Fragment',
    useCallback: (fn) => fn,
    useEffect: () => {},
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot()
  }
  // Copy of the shipped relativeTime, enough for the time label check.
  const relativeTime = (at, now) => {
    const diff = Math.max(0, now - at)
    if (diff < 6e4) return { unit: 'now', n: 0 }
    if (diff < 36e5) return { unit: 'minutes', n: Math.floor(diff / 6e4) }
    if (diff < 864e5) return { unit: 'hours', n: Math.floor(diff / 36e5) }
    return { unit: 'days', n: Math.floor(diff / 864e5) }
  }
  const primitives = { StateDot: 'StateDot', relativeTime }
  const require = (name) => {
    if (name === 'react') return React
    if (name === 'react-dom/client') return { createRoot: () => ({ render: () => {}, unmount: () => {} }) }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${name}`)
  }
  const exports = registered.factory(require)
  return { exports, storage, frames, observers }
}

function observable(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    push: (next) => {
      value = next
      for (const listener of [...listeners]) listener()
    }
  }
}

function fakeContext() {
  const registrations = []
  const effects = []
  const list = observable({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  const statuses = observable(new Map())
  const ctx = {
    get: (name) => {
      if (name === 'sessions') return { list }
      if (name === 'uiSession') return { sessionStatus: statuses }
      if (name === 'uiWorkspace') return { openSession: () => {} }
      return undefined
    },
    effect: (fn, label) => {
      effects.push({ label, dispose: fn() ?? (() => {}) })
      return () => {}
    },
    slots: {
      register: (options, component) => {
        const record = { options, component, disposed: false }
        registrations.push(record)
        return () => { record.disposed = true }
      },
      inject: (key, callback) => {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      }
    }
  }
  return { ctx, registrations, effects, list, statuses }
}

// --- wiring ----------------------------------------------------------------

const { exports: bundle, storage, frames, observers } = loadBundle()
assert.equal(typeof bundle.apply, 'function')
assert.deepEqual(bundle.inject, ['sessions', 'uiSession', 'uiWorkspace', 'workspaces'])

const { ctx, registrations, effects, list } = fakeContext()
bundle.apply(ctx)
assert.equal(registrations.length, 0, 'the plugin registers no slot entries')
assert.ok(observers.length === 1, 'the sidebar watcher did not start')
assert.ok(frames.length === 1, 'the first reconcile was not scheduled')
frames.shift()()  // empty DOM: reconcile finds no region and must not throw

// No source, no mount: the plugin stays idle instead of throwing.
const idle = fakeContext()
idle.ctx.get = () => undefined
bundle.apply(idle.ctx)
assert.equal(idle.registrations.length, 0, 'idle apply must not register UI')

// Teardown releases the watcher and both subscriptions.
effects[1].dispose()
assert.ok(observers[0].disconnected, 'watcher kept running after teardown')

// --- config ----------------------------------------------------------------

bundle.__internals.writeConfig({ enabled: false })
assert.equal(JSON.parse(storage.get('dsh-activity-view.v2')).enabled, false)
bundle.__internals.writeConfig({ enabled: true })
assert.equal(bundle.__internals.config.enabled, true)

// --- grouping --------------------------------------------------------------

const { collect, groupOf, isToday, timeText, toneOf } = bundle.__internals
const now = Date.now()
const midnight = new Date(now).setHours(0, 0, 0, 0)
const yesterday = midnight - 60000
const rows = {
  unread: { id: 'unread', displayTitle: 'unread', updatedAt: yesterday, running: false },
  waiting: { id: 'waiting', displayTitle: 'waiting', updatedAt: yesterday, running: false },
  internal: { id: 'internal', displayTitle: 'internal', updatedAt: yesterday, running: false },
  running: { id: 'running', displayTitle: 'running', updatedAt: yesterday, running: true },
  stale: { id: 'stale', displayTitle: 'stale', updatedAt: yesterday, running: true },
  today: { id: 'today', displayTitle: 'today', updatedAt: now - 5 * 60000, running: false },
  archived: { id: 'archived', displayTitle: 'archived', updatedAt: now, running: false },
  old: { id: 'old', displayTitle: 'old', updatedAt: yesterday, running: false },
  blank: { id: 'blank', displayTitle: 'blank', updatedAt: now, blank: true },
  sub: { id: 'sub', displayTitle: 'sub', updatedAt: now, origin: 'subagent' }
}
const snapshot = { ids: Object.keys(rows), byId: rows, phase: 'ready', projectionsBySession: {} }
const statusMap = new Map([
  ['unread', { completionUnread: true, running: false }],
  ['waiting', { completionUnread: false, pendingInteraction: { kind: 'approval' } }],
  // a pending kind the shipped row hides is not a reason to look
  ['internal', { completionUnread: false, pendingInteraction: { kind: 'internal' } }],
  // the live status wins over the summary flag, like the shipped row
  ['stale', { completionUnread: false, running: false }],
  ['today', { completionUnread: false, running: false }]
])
const archived = new Set(['archived'])

const ids = (list) => list.map((row) => row.id)
const groups = collect(snapshot, statusMap, archived, now)
assert.deepEqual(ids(groups.attention), ['unread', 'waiting'], 'attention grouping is wrong')
assert.deepEqual(ids(groups.working), ['running'], 'working grouping is wrong')
assert.deepEqual(ids(groups.today), ['today'], 'today grouping is wrong')
assert.equal(groupOf(rows.old, undefined, now), null)
assert.equal(isToday(yesterday, now), false)
assert.equal(isToday(now, now), true)

// The bell is loud only for real attention, and louder while something waits.
assert.equal(toneOf(groups.attention), 'warn')
assert.equal(toneOf(groups.attention.filter((row) => row.id === 'unread')), 'done')
assert.equal(toneOf(collect(snapshot, new Map(), archived, now).attention), 'none')

// --- time text -------------------------------------------------------------

assert.equal(timeText(now, now), 'now')
assert.equal(timeText(now - 32 * 60000, now), '32min')
assert.equal(timeText(now - 5 * 3600000, now), '5h')
assert.equal(timeText(now - 3 * 86400000, now), '3d')

console.log('dsh-activity-view: client self-check passed')
