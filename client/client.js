/**
 * dsh-activity-view, browser half.
 *
 * Hand-written loader bundle on purpose: the host serves this file as a
 * classic script and takes the factory, so the plugin runs with no build step.
 * ponytail: add esbuild + JSX when this file outgrows createElement.
 *
 * Seam: the shipped session browser owns `sidebar.workspaces` as one `single`
 * slot, header and list together, so the bell cannot be a slot entry without
 * replacing the header too. Instead the plugin adds the bell to the shipped
 * header actions row and swaps only the list body:
 *
 *   - bell  -> appended inside the shipped `headerActions` container, and it
 *              copies the class list of a neighbouring icon button, so size,
 *              hover and focus styling stay whatever the shell ships.
 *   - body  -> the shipped `listArea` gets `data-dsav-hidden` and our own
 *              scroll container is appended beside it, holding a React root.
 *
 * Both anchors are CSS-module local names (`headerActions`, `listArea`), which
 * survive build hashes. A MutationObserver remounts whichever node the shell
 * drops, and the fast path is a few parent reads, so streaming renders do
 * not pay for a document scan.
 */
window.__ModuleLoader__.load({
  id: 'dsh-activity-view',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** @type {typeof import('react')} */
    const React = require('react')
    /** @type {typeof import('react-dom/client')} */
    const { createRoot } = require('react-dom/client')
    /** @type {typeof import('@deepseek-ai/dsh-client-ui-primitives')} */
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    // One language for now; add ctx.locale.register when someone asks for zh.
    const COPY = {
      on: 'Turn off activity view',
      off: 'Turn on activity view',
      attention: 'Needs attention',
      attentionEmpty: 'Nothing needs attention',
      working: 'Working',
      today: 'Today',
      none: 'No activity today',
    }

    const STORE_KEY = 'dsh-activity-view.v2'
    /** Pending kinds the shipped row shows; anything else is internal and not a reason to look. */
    const VISIBLE_PENDING = new Set(['approval', 'plan-review', 'question'])
    /** Same short units as the shipped rows ("now", "32min", "5h", "3d", "2mo", "1y"). */
    const UNIT = { minutes: 'min', hours: 'h', days: 'd', months: 'mo', years: 'y' }

    /**
     * @typedef {{ id: string, displayTitle: string, updatedAt?: number, running?: boolean, blank?: boolean, origin?: string, retainedBy?: Record<string, number> }} Session
     * @typedef {{ ids: string[], byId: Record<string, Session> }} SessionList
     * @typedef {{ running?: boolean, completionUnread?: boolean, pendingInteraction?: { kind: string } }} Status
     * @typedef {'attention' | 'working' | 'today'} Group
     * @typedef {{ id: string, session: Session, status: Status | undefined, time: number, group: Group }} Row
     */
    /**
     * @template T
     * @typedef {{ getSnapshot(): T, subscribe(listener: () => void): () => void }} Source
     */

    // ---- config: browser-local, no host round trip -------------------------

    const config = { enabled: true }
    try {
      Object.assign(config, JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}'))
    } catch {}
    config.enabled = config.enabled !== false

    const configListeners = new Set()

    function subscribeConfig(listener) {
      configListeners.add(listener)
      return () => configListeners.delete(listener)
    }

    function writeConfig(patch) {
      Object.assign(config, patch)
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(config))
      } catch {}
      for (const listener of [...configListeners]) listener()
    }

    // ---- the three groups --------------------------------------------------

    /** Whether two instants fall on the same local calendar day. @param {number} time @param {number} now */
    function isToday(time, now) {
      const then = new Date(time)
      const current = new Date(now)
      return then.getFullYear() === current.getFullYear() && then.getMonth() === current.getMonth() && then.getDate() === current.getDate()
    }

    /** @param {Status | undefined} status */
    const waitsForYou = (status) => VISIBLE_PENDING.has(status?.pendingInteraction?.kind)

    /**
     * Sort one session into a group, or drop it.
     * Attention wins over running, running wins over today.
     * @param {Session} session
     * @param {Status | undefined} status
     * @param {number} now
     * @returns {Group | null}
     */
    function groupOf(session, status, now) {
      if (waitsForYou(status) || status?.completionUnread) return 'attention'
      if (status?.running ?? session.running) return 'working'
      if (isToday(session.updatedAt ?? 0, now)) return 'today'
      return null
    }

    /**
     * Visible rows per group, newest first. Blank, subagent and archived sessions stay out.
     * @param {SessionList | undefined} list
     * @param {Map<string, Status> | undefined} statuses
     * @param {Set<string>} archived
     * @param {number} now
     * @returns {Record<Group, Row[]>}
     */
    function collect(list, statuses, archived, now) {
      const groups = { attention: [], working: [], today: [] }
      const rows = (list?.ids ?? [])
        .map((id) => ({ id, session: list.byId?.[id], status: statuses?.get?.(id) }))
        .filter(({ id, session }) => session && !session.blank && session.origin !== 'subagent' && !archived.has(id))
        .map((row) => ({ ...row, time: row.session.updatedAt ?? 0, group: groupOf(row.session, row.status, now) }))
        .filter((row) => row.group !== null)
        .sort((a, b) => b.time - a.time)
      for (const row of rows) groups[row.group].push(row)
      return groups
    }

    /**
     * Bell tone: none, done (something finished) or warn (something waits for you).
     * @param {Row[]} attention
     */
    function toneOf(attention) {
      if (attention.length === 0) return 'none'
      return attention.some((row) => waitsForYou(row.status)) ? 'warn' : 'done'
    }

    /** @param {number} time @param {number} now */
    function timeText(time, now) {
      const { unit, n } = primitives.relativeTime(time, now)
      return unit === 'now' ? 'now' : `${n}${UNIT[unit] ?? ''}`
    }

    // ---- reactive reads ----------------------------------------------------

    /** @template T @param {Source<T>} source @returns {T} */
    function useSource(source) {
      const subscribe = React.useCallback((listener) => source.subscribe(listener), [source])
      const snapshot = React.useCallback(() => source.getSnapshot(), [source])
      return React.useSyncExternalStore(subscribe, snapshot)
    }

    const EMPTY = new Set()
    let archivedCache = { ids: null, set: EMPTY }

    /** Archived ids as a Set, cached on the store's array identity so snapshots stay stable. */
    function archivedSet() {
      const ids = sources.workspaces?.getSnapshot()?.archivedSessionIds
      if (ids !== archivedCache.ids) archivedCache = { ids, set: new Set(ids ?? []) }
      return archivedCache.set
    }

    function useArchived() {
      const subscribe = React.useCallback((listener) => sources.workspaces?.subscribe(listener) ?? (() => {}), [])
      return React.useSyncExternalStore(subscribe, archivedSet)
    }

    function useNow(intervalMs = 30000) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs)
        return () => clearInterval(timer)
      }, [intervalMs])
      return now
    }

    // ---- styles ------------------------------------------------------------

    const STYLE_ID = 'dsh-activity-view-styles'
    // A typed search query hands the list back to the shipped browser, which
    // renders its results inside the list we hide; clearing it brings us back.
    // The collapsed rail keeps no bell (no list to swap there).
    // Metrics mirror the shipped session browser (Rows.module.css,
    // WorkspaceBrowser.module.css), on the same theme tokens.
    // ponytail: copied px values, re-check when DSH restyles the session list.
    const CSS = `
[data-dsav-hidden]{display:none!important}
[data-dsav-root]:has(input:not(:placeholder-shown))>[data-dsav-hidden]{display:flex!important}
[data-dsav-root]:has(input:not(:placeholder-shown))>.dsav-body{display:none}
:is([class$="_rail"],[class*="_rail "]) [data-dsav-bell]{display:none}
[class*="headerActions"]:has([data-dsav-bell]):not([class*="headerActionsHidden"]){max-width:92px}
[data-dsav-bell]{position:relative}
[data-dsav-bell][aria-pressed=true]{color:var(--dsw-alias-label-primary)}
[data-dsav-bell] .dsav-bell-filled{display:none}
[data-dsav-bell][aria-pressed=true] .dsav-bell-outline{display:none}
[data-dsav-bell][aria-pressed=true] .dsav-bell-filled{display:block}
.dsav-body{flex:1;min-height:0;overflow-y:auto;scrollbar-gutter:stable;margin-left:-4px;padding:0 calc(var(--dsh-session-list-edge-inset,12px) - 7px) 16px 4px;margin-right:calc(2px - var(--dsh-session-list-edge-inset,12px))}
.dsav-body>*+*{margin-top:2px}
.dsav-group{display:flex;align-items:center;height:32px;padding:0 8px;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px}
.dsav-body>.dsav-group+.dsav-group,.dsav-body>*+.dsav-group{margin-top:8px}
.dsav-body>.dsav-group:first-child{margin-top:0}
.dsav-note{padding:0 8px 0 28px;color:var(--dsw-alias-label-caption);font-size:13px;line-height:20px}
.dsav-row{box-sizing:border-box;display:flex;align-items:center;gap:0;width:100%;height:32px;padding:0 8px;border:0;border-radius:var(--dsw-radius-md);background:0 0;font:inherit;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;user-select:none}
.dsav-row:hover,.dsav-row[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dsav-row:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dsav-slot{display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:20px;color:var(--dsw-alias-label-tertiary)}
.dsav-title{flex:1;min-width:0;margin:0 6px 0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px}
.dsav-time{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}
.dsav-dot{position:absolute;top:4px;right:4px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);pointer-events:none}
.dsav-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}
.dsav-dot[data-tone=none]{display:none}
`

    function installStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function removeStyles() {
      document.getElementById(STYLE_ID)?.remove()
    }

    // ---- the shell seam ----------------------------------------------------

    const ACTION_SELECTOR = '[class*="headerActions"]'
    const LIST_SELECTOR = '[class*="listArea"]'
    const BELL_OUTLINE =
      '<svg class="dsav-bell-outline" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 1.9a3.9 3.9 0 0 0-3.9 3.9c0 2.5-.6 3.7-1.2 4.3-.3.3 0 .8.4.8h9.4c.4 0 .7-.5.4-.8-.6-.6-1.2-1.8-1.2-4.3A3.9 3.9 0 0 0 8 1.9Z"></path>' +
      '<path d="M6.4 12.7a1.7 1.7 0 0 0 3.2 0"></path></svg>'
    const BELL_FILLED =
      '<svg class="dsav-bell-filled" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 1.9a3.9 3.9 0 0 0-3.9 3.9c0 2.5-.6 3.7-1.2 4.3-.3.3 0 .8.4.8h9.4c.4 0 .7-.5.4-.8-.6-.6-1.2-1.8-1.2-4.3A3.9 3.9 0 0 0 8 1.9Z"></path>' +
      '<path d="M6.4 12.7a1.7 1.7 0 0 0 3.2 0" fill="none"></path></svg>'

    let runtime = null
    /** @type {{ list: Source<SessionList>, statuses: Source<Map<string, Status>>, workspaces?: Source<{ archivedSessionIds?: string[] }> } | null} */
    let sources = null
    let bell = null
    let dot = null
    let bodyHost = null
    let bodyRoot = null
    let hiddenBody = null
    // CSS-module names end in the local name, so `_rail` as a whole token, not `_railRow`.
    const isRail = (root) => [...root.classList].some((name) => name.endsWith('_rail'))

    /** Nearest ancestor of the header that also holds the list body. */
    function regionRootFrom(actions) {
      let node = actions?.parentElement ?? null
      while (node && node !== document.body) {
        if ([...node.children].some((child) => child.matches?.(LIST_SELECTOR))) return node
        node = node.parentElement
      }
      return null
    }

    function ensureBell(actions) {
      const reference = [...actions.querySelectorAll('button')].find((button) => button !== bell)
      if (bell?.isConnected && bell.parentElement === actions) {
        if (reference && bell.className !== reference.className) bell.className = reference.className
        placeBell(actions)
        return
      }
      removeBell()
      bell = document.createElement('button')
      bell.type = 'button'
      bell.setAttribute('data-dsav-bell', '1')
      if (reference) bell.className = reference.className
      bell.innerHTML = BELL_OUTLINE + BELL_FILLED
      dot = document.createElement('span')
      dot.className = 'dsav-dot'
      bell.appendChild(dot)
      bell.addEventListener('click', () => writeConfig({ enabled: !config.enabled }))
      actions.appendChild(bell)
      placeBell(actions)
    }

    /** Sit between the view options and the add-workspace button, whatever order the shell builds. */
    function placeBell(actions) {
      const kids = [...actions.children]
      if (kids.length < 2) return
      const last = kids[kids.length - 1]
      if (last === bell) {
        actions.insertBefore(bell, kids[kids.length - 2])
        return
      }
      if (bell.nextElementSibling !== last) actions.insertBefore(bell, last)
    }

    function removeBell() {
      bell?.remove()
      bell = null
      dot = null
    }

    function ensureBody(root) {
      const shipped = [...root.children].find((child) => child.matches?.(LIST_SELECTOR))
      if (!shipped) return
      if (bodyHost?.isConnected && bodyHost.parentElement === root) {
        shipped.setAttribute('data-dsav-hidden', '1')
        hiddenBody = shipped
        return
      }
      removeBody()
      hiddenBody = shipped
      shipped.setAttribute('data-dsav-hidden', '1')
      root.setAttribute('data-dsav-root', '1')
      bodyHost = document.createElement('div')
      bodyHost.className = 'dsav-body'
      root.appendChild(bodyHost)
      bodyRoot = createRoot(bodyHost)
      renderBody()
    }

    function renderBody() {
      bodyRoot?.render(h(ActivityBody))
    }

    function removeBody() {
      if (bodyRoot) {
        bodyRoot.unmount()
        bodyRoot = null
      }
      bodyHost?.remove()
      bodyHost = null
      hiddenBody?.parentElement?.removeAttribute('data-dsav-root')
      hiddenBody?.removeAttribute('data-dsav-hidden')
      hiddenBody = null
    }

    function syncBell() {
      if (!bell) return
      const label = config.enabled ? COPY.on : COPY.off
      bell.title = label
      bell.setAttribute('aria-label', label)
      bell.setAttribute('aria-pressed', String(config.enabled))
      if (!dot) return
      dot.dataset.tone = toneOf(collect(sources.list.getSnapshot(), sources.statuses.getSnapshot(), archivedSet(), Date.now()).attention)
    }

    /** Idempotent reconcile of both nodes. Called on mount, mutation and config change. */
    function sync() {
      if (!document.body) return
      // Other panels use a `headerActions` class too; take the one above the session list.
      const actions = [...document.querySelectorAll(ACTION_SELECTOR)].find((node) => regionRootFrom(node))
      if (actions) ensureBell(actions)
      const root = actions ? regionRootFrom(actions) : null
      // The collapsed rail has no list to replace; CSS hides the bell there.
      if (config.enabled && root && !isRail(root)) {
        ensureBody(root)
      } else {
        removeBody()
      }
      syncBell()
    }

    let observer = null
    let queued = false

    /** rAF when the page has one, a timer in tests and non-browser hosts. */
    const nextFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16)

    function schedule() {
      if (queued) return
      queued = true
      nextFrame(() => {
        queued = false
        try {
          sync()
        } catch (error) {
          console.warn('[dsh-activity-view] sync failed:', error)
        }
      })
    }

    /**
     * Cheap check (no document scan) that both nodes are where they belong, so the observer can
     * skip the document scan on every unrelated render.
     */
    function domIsSettled() {
      if (!bell?.isConnected) return false
      const actions = bell.parentElement
      const kids = actions ? [...actions.children] : []
      if (kids.length >= 2) {
        const last = kids[kids.length - 1]
        if (last === bell || bell.nextElementSibling !== last) return false
      }
      const root = regionRootFrom(actions)
      if (!config.enabled || !root || isRail(root)) return !bodyHost
      return Boolean(bodyHost?.isConnected && hiddenBody?.isConnected)
    }

    function onMutations() {
      if (domIsSettled()) return
      schedule()
    }

    function startWatching() {
      observer = new MutationObserver(onMutations)
      observer.observe(document.body, { childList: true, subtree: true })
      schedule()
    }

    function stopWatching() {
      observer?.disconnect()
      observer = null
      removeBody()
      removeBell()
    }

    // ---- components --------------------------------------------------------

    /** Leading dot: only unread or waiting rows get one, working rows get the native spinner. */
    function leadState(row) {
      if (waitsForYou(row.status)) return 'warning'
      if (row.status?.completionUnread) return 'done'
      if (row.group === 'working') return 'ongoing'
      return null
    }

    function ActivityRow({ row, now, current }) {
      const state = leadState(row)
      return h(
        'button',
        {
          type: 'button',
          role: 'treeitem',
          'aria-selected': row.id === current,
          className: 'dsav-row',
          title: row.session.displayTitle,
          onClick: () => runtime.get('uiWorkspace')?.openSession(row.id)
        },
        h('span', { className: 'dsav-slot' }, state ? h(primitives.StateDot, { state }) : null),
        h('span', { className: 'dsav-title' }, row.session.displayTitle),
        h('span', { className: 'dsav-time' }, timeText(row.time, now))
      )
    }

    const label = (key, text) => h('div', { className: 'dsav-group', key }, text)
    const note = (key, text) => h('div', { className: 'dsav-note', key }, text)

    function ActivityBody() {
      const list = useSource(sources.list)
      const statuses = useSource(sources.statuses)
      const archived = useArchived()
      const now = useNow()
      const groups = collect(list, statuses, archived, now)
      const current = Object.values(list?.byId ?? {}).find((session) => (session.retainedBy?.mainView ?? 0) > 0)?.id
      const rows = (group) => groups[group].map((row) => h(ActivityRow, { key: row.id, row, now, current }))
      const quiet = groups.attention.length + groups.working.length + groups.today.length === 0
      return h(
        React.Fragment,
        null,
        label('attention', COPY.attention),
        groups.attention.length === 0 && note('attention-empty', COPY.attentionEmpty),
        rows('attention'),
        groups.working.length > 0 && label('working', COPY.working),
        rows('working'),
        groups.today.length > 0 && label('today', COPY.today),
        rows('today'),
        quiet && note('none', COPY.none)
      )
    }

    // ---- wiring ------------------------------------------------------------

    function apply(root) {
      runtime = root
      const sessions = root.get('sessions')
      const uiSession = root.get('uiSession')
      if (!sessions?.list || !uiSession?.sessionStatus) {
        console.warn('[dsh-activity-view] session sources unavailable; plugin idle')
        return
      }
      sources = { list: sessions.list, statuses: uiSession.sessionStatus, workspaces: root.get('workspaces')?.list }

      root.effect(() => {
        installStyles()
        return removeStyles
      }, 'dsh-activity-view: styles')

      root.effect(() => {
        const unsubscribe = []
        unsubscribe.push(sources.list.subscribe(syncBell))
        unsubscribe.push(sources.statuses.subscribe(syncBell))
        if (sources.workspaces) unsubscribe.push(sources.workspaces.subscribe(syncBell))
        unsubscribe.push(subscribeConfig(sync))
        startWatching()
        return () => {
          for (const off of unsubscribe) off()
          stopWatching()
        }
      }, 'dsh-activity-view: sidebar mount')
    }

    exports.apply = apply
    exports.inject = ['sessions', 'uiSession', 'uiWorkspace', 'workspaces']
    exports.__internals = { collect, groupOf, isToday, timeText, toneOf, writeConfig, config }

    return module.exports
  }
})
