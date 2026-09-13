window.__ModuleLoader__.load({
  id: 'dsh-chattree',
  factory: () => {
    const module = { exports: {} }
    const currentSession = ctx => {
      const snapshot = ctx.sessions.list.getSnapshot()
      const id = snapshot.current
      if (id === undefined) return null
      const session = snapshot.byId[id]
      return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null }
    }
    const sessionSnapshot = ctx => {
      const snapshot = ctx.sessions.list.getSnapshot()
      return snapshot.ids.map(id => {
        const session = snapshot.byId[id]
        return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null, parentId: session.parentId ?? null, blank: session.blank }
      }).filter(Boolean)
    }
    const workspaceSnapshot = ctx => {
      const sessions = ctx.sessions.list.getSnapshot()
      const snapshot = ctx.workspaces.list.getSnapshot()
      const accounted = new Set(snapshot.items.flatMap(workspace => workspace.sessionIds))
      return [
        ...snapshot.items.map(workspace => ({ id: workspace.workspaceId, title: workspace.title, path: workspace.path, sessionIds: workspace.sessionIds })),
        { id: 'dsh-ungrouped', title: '未分组', path: null, sessionIds: sessions.ids.filter(id => !accounted.has(id)) },
      ]
    }

    // Only real client services belong here. `sessionProjections` is a Host-only
    // service: injecting it leaves this fiber pending forever (no error, no
    // apply), which the Desktop boot report surfaces as "Renderer boot failed".
    // Projection values are read per Session instead -- see the composer bridge.
    module.exports.inject = ['sessions', 'remote', 'fileUpload', 'uiConversation', 'workspaces']
    module.exports.apply = ctx => {
      // A DSH fork's seed runs from the anchor turn's `turn/end` forward to just
      // before the NEXT `turn/start` (the host advances its cut until it lands on
      // a turn/start). The parent's "user message queued for the next turn"
      // agent/inbox/spliced event sits exactly in that gap, so the child inherits
      // it and replays it as its own first turn: the branch opens with the
      // parent's NEXT question instead of the one the user just typed. No atSeq
      // avoids this, so the child's inherited queue has to be dropped before the
      // branch question is sent.
      const forkedSessionIds = new Set()

      // Append-only trace in localStorage so nothing overwrites itself and the
      // run can be read back from disk. Never throws.
      const trace = entry => {
        try {
          const key = 'chattree:fork-trace'
          const previous = JSON.parse(window.localStorage.getItem(key) ?? '[]')
          previous.push({ at: Date.now(), ...entry })
          window.localStorage.setItem(key, JSON.stringify(previous.slice(-24)))
        } catch { /* storage unavailable */ }
      }

      const clearInheritedQueue = async sessionId => {
        const scope = ctx.sessions.scope(sessionId)
        const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
        if (session === undefined || typeof session.updateQueue !== 'function') {
          trace({ stage: 'cleanup-bailed', sessionId, sessionFound: session !== undefined })
          return
        }
        const rows = () => {
          try {
            if (session.queueMirror !== undefined) return session.queueMirror.snapshot()
            if (typeof session.getSnapshot === 'function') return session.getSnapshot().queue ?? []
          } catch { /* session not bound yet */ }
          return []
        }
        trace({ stage: 'cleanup-start', sessionId, firstRead: rows().map(row => row.placement) })
        const deadline = Date.now() + 1500
        let nudged = false
        for (;;) {
          const pending = rows()
          if (pending.length > 0) {
            let removed = 0
            let failed = 0
            for (const row of pending) {
              try { await session.updateQueue(row.id, { kind: 'remove' }); removed += 1 } catch { failed += 1 }
            }
            trace({ stage: 'cleanup-removed', sessionId, removed, failed, after: rows().map(row => row.placement) })
            return
          }
          if (!nudged && Date.now() > deadline - 1100) {
            nudged = true
            try { ctx.sessions.open(sessionId) } catch { /* ignore */ }
          }
          if (Date.now() >= deadline) {
            trace({ stage: 'cleanup-gaveup', sessionId, nudged })
            return
          }
          await new Promise(resolve => window.setTimeout(resolve, 25))
        }
      }

      // DSH takes images inline as base64 and every other file as an uploaded
      // receipt, so each attachment becomes its final prompt part here -- the
      // canvas only carries an opaque handle back to us.
      const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

      const encodeImage = file => new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const url = typeof reader.result === 'string' ? reader.result : ''
          const comma = url.indexOf(',')
          if (comma < 0) reject(new Error('图片读取失败'))
          else resolve(url.slice(comma + 1))
        }
        reader.onerror = () => reject(new Error('图片读取失败'))
        reader.readAsDataURL(file)
      })

      const toAttachment = async (sessionId, file) => {
        const name = typeof file.name === 'string' && file.name !== '' ? file.name : '附件'
        const size = typeof file.size === 'number' ? file.size : 0
        if (typeof file.type === 'string' && IMAGE_MEDIA_TYPES.includes(file.type)) {
          const data = await encodeImage(file)
          return { handle: `image-${name}-${size}`, name, size, part: { type: 'image', mediaType: file.type, data, ...name === '附件' ? {} : { name } } }
        }
        const result = await ctx.fileUpload.upload(sessionId, file, name)
        if (result?.ok === false) throw new Error(result.error?.message ?? '附件上传失败')
        const value = result?.value ?? result
        if (typeof value?.receiptId !== 'string') throw new Error('附件上传失败')
        return { handle: value.receiptId, name, size, part: { type: 'file', receiptId: value.receiptId } }
      }

      const prompt = async (sessionId, text, parts = []) => {
        const isFreshFork = forkedSessionIds.delete(sessionId)
        trace({ stage: 'prompt', sessionId, isFreshFork, stillTracked: [...forkedSessionIds] })
        if (isFreshFork) await clearInheritedQueue(sessionId)
        const scope = ctx.sessions.scope(sessionId)
        const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
        if (session === undefined) throw new Error('关联的 DSH 会话已不可用')
        // Attachments first, then the instruction -- the order the built-in
        // composer uses.
        const content = [...parts, ...text === '' ? [] : [{ type: 'text', text }]]
        const result = await session.prompt(content, 'queue')
        if (!result.ok) throw new Error(result.error?.message ?? 'DSH 未接受这条消息')
        window.setTimeout(() => {
          try {
            const rows = session.queueMirror !== undefined
              ? session.queueMirror.snapshot()
              : (typeof session.getSnapshot === 'function' ? session.getSnapshot().queue ?? [] : [])
            trace({ stage: 'after-send', sessionId, rows: rows.map(row => row.placement) })
          } catch { /* ignore */ }
        }, 600)
      }
      const style = document.createElement('style')
      style.textContent = '.dsh-chattree-switch{position:fixed;z-index:80;top:12px;left:50%;display:flex;gap:2px;transform:translateX(-50%);border:1px solid #d1d5db;border-radius:999px;background:rgba(255,255,255,.96);padding:3px;backdrop-filter:blur(10px)}.dsh-chattree-switch button{height:28px;border:0;border-radius:999px;background:transparent;padding:0 11px;color:#6b7280;font:600 12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}.dsh-chattree-switch button:hover{background:#f3f4f6;color:#111827}.dsh-chattree-switch button.active{background:#111827;color:#fff}.dsh-chattree-switch button:focus-visible{outline:2px solid #111827;outline-offset:2px}.dsh-chattree-overlay{position:fixed;z-index:100;inset:0;background:#f5f7fa}.dsh-chattree-overlay.is-opening{visibility:hidden}.dsh-chattree-overlay[hidden]{display:none}.dsh-chattree-overlay iframe{display:block;width:100%;height:100%;border:0}'
      document.head.append(style)
      const host = document.createElement('div')
      host.className = 'dsh-chattree-host'
      host.innerHTML = '<div class="dsh-chattree-switch" role="group" aria-label="视图切换"><button type="button" data-view="dialog" class="active" aria-pressed="true">对话</button><button type="button" data-view="map" aria-pressed="false">Chat Tree</button></div><section class="dsh-chattree-overlay" hidden><iframe title="Chat Tree" src="/chattree/"></iframe></section>'
      document.body.append(host)
      const dialogButton = host.querySelector('[data-view="dialog"]')
      const mapButton = host.querySelector('[data-view="map"]')
      const overlay = host.querySelector('.dsh-chattree-overlay')
      const frame = host.querySelector('iframe')

      const setView = view => {
        const showingMap = view === 'map'
        dialogButton.classList.toggle('active', !showingMap)
        dialogButton.setAttribute('aria-pressed', String(!showingMap))
        mapButton.classList.toggle('active', showingMap)
        mapButton.setAttribute('aria-pressed', String(showingMap))
      }
      const close = () => {
        window.clearTimeout(mapOpenFallback)
        mapOpening = false
        overlay.classList.remove('is-opening')
        overlay.hidden = true
        setView('dialog')
      }
      const send = (type, payload) => { frame.contentWindow?.postMessage({ source: 'dsh-chattree', type, ...payload }, location.origin) }
      // Resolve the assembled conversation view for one session. `binding()`
      // throws for sessions the view does not cover yet, so this stays total.
      // The Host-generation catalog and the model switch both live on the `session` Remote
      // namespace, which the api-remotes assembly mounts asynchronously while the page boots.
      // It is therefore resolved per call, never captured.
      //
      // Capturing it once, while this plugin applied, froze the empty answer in place: the
      // namespace was not up yet, the fallback (`ctx.sessions`) carries no model methods
      // either, and every composer read after that answered the reader with "DSH 未提供模型
      // 目录接口". The old first probe -- `session.models.getSnapshot()` -- named a face this
      // build does not have at all: the per-session model service is `ctx.modelDirectories`.
      const remoteSession = () => {
        try {
          const mounted = typeof ctx.get === 'function' ? ctx.get('remote.session') : undefined
          if (mounted !== undefined && mounted !== null) return mounted
        } catch { /* the typed namespace is not registered in this build */ }
        try {
          const direct = ctx.remote?.session
          if (direct !== undefined && direct !== null) return direct
        } catch { /* the typed namespace is not registered in this build */ }
        return ctx.sessions
      }
      // Pick whichever candidate actually carries the method. A namespace can
      // exist and still lack it, so the method is what is probed, not the object.
      const apiWith = method => {
        for (const candidate of [remoteSession(), ctx.sessions]) {
          if (candidate !== undefined && candidate !== null && typeof candidate[method] === 'function') return candidate
        }
        return undefined
      }
      // The command registry is its own namespace, read the same way and for the same reason.
      // `/compact` is not a host service: it is mounted by whichever agent preset the session
      // runs under, so a session is asked what it actually has instead of being assumed to
      // have it.
      const remoteCommands = () => {
        try {
          const mounted = typeof ctx.get === 'function' ? ctx.get('remote.commands') : undefined
          if (mounted !== undefined && mounted !== null) return mounted
        } catch { /* the typed namespace is not registered in this build */ }
        try {
          const direct = ctx.remote?.commands
          if (direct !== undefined && direct !== null) return direct
        } catch { /* the typed namespace is not registered in this build */ }
        return undefined
      }
      // A build that cannot answer leaves the catalog empty. That is a missing capability,
      // not a failed read, so it is reported back to the canvas as data and never thrown:
      // the model pickers simply stay out of the composer, which is what the panel expects
      // of a build with nothing to say.
      const modelCatalogOf = () => {
        const api = apiWith('modelCatalog')
        return api === undefined ? null : api.modelCatalog()
      }
      const selectModelOf = (session, request) => {
        if (typeof session?.selectModel === 'function') return session.selectModel(request)
        const api = apiWith('selectModel')
        if (api === undefined) throw new Error('DSH 未提供模型切换接口')
        return api.selectModel(request)
      }

      const chatTarget = id => {
        try { return ctx.uiConversation?.binding?.(id)?.target?.('chat') } catch { return undefined }
      }
      const liveText = id => {
        const blocks = chatTarget(id)?.getSnapshot()?.legacy?.partial?.blocks
        if (!Array.isArray(blocks)) return ''
        return blocks.filter(block => block?.kind === 'text').map(block => String(block.text ?? '')).join(String.fromCharCode(10))
      }
      let syncQueued = false
      let knownSessionIds = new Set()
      const liveUnsubscribers = new Map()
      const syncLiveSessions = () => {
        const snapshot = ctx.sessions.list.getSnapshot()
        for (const id of snapshot.ids) {
          if (liveUnsubscribers.has(id)) continue
          const scope = ctx.sessions.scope(id)
          const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
          if (session === undefined) continue
          const publish = () => {
            if (overlay.hidden) return
            const state = session.getSnapshot()
            send('chattree:live-reply', { sessionId: id, running: state.running, text: liveText(id) })
          }
          const target = chatTarget(id)
          const disposers = [session.subscribe(publish)]
          if (target !== undefined) disposers.push(target.subscribe(publish))
          liveUnsubscribers.set(id, () => { for (const dispose of disposers) dispose() })
          publish()
        }
        for (const [id, unsubscribe] of liveUnsubscribers) if (!snapshot.ids.includes(id)) { unsubscribe(); liveUnsubscribers.delete(id) }
      }
      const syncSessions = () => {
        if (syncQueued) return
        syncQueued = true
        queueMicrotask(() => {
          syncQueued = false
          const sessions = sessionSnapshot(ctx)
          const sessionIds = new Set(sessions.map(session => session.id))
          const removedSessionIds = [...knownSessionIds].filter(id => !sessionIds.has(id))
          knownSessionIds = sessionIds
          void fetch('/chattree/api/sessions/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions, removedSessionIds }) }).catch(() => {})
        })
      }
      const syncTheme = () => {
        const dark = document.body?.hasAttribute?.('data-ds-dark-theme') === true
        send('chattree:theme', { dark })
      }
      const syncCurrentSession = () => {
        syncSessions()
        syncLiveSessions()
        syncTheme()
        if (!overlay.hidden) {
          send('chattree:workspaces', { workspaces: workspaceSnapshot(ctx) })
          send('chattree:current-session', { session: currentSession(ctx) })
        }
      }
      let mapOpenFallback = 0
      let mapOpening = false

      // The map overlay covers DSH's own question card, so while it is up the
      // canvas answers `ask_user_question` instead. The built-in answerer sits on
      // the same waterfall, and only the outermost listener decides, so this one
      // is prepended: calling `next()` (the stock behaviour) hands the request
      // back when the map is not showing.
      const pendingQuestions = new Map()
      const remote = ctx.remote ?? (typeof ctx.get === 'function' ? ctx.get('remote') : undefined)
      const answerQuestionOnCanvas = function (request, next) {
        if (overlay.hidden === true) return next()
        const requestId = `chattree-question-${Date.now()}-${pendingQuestions.size}`
        return new Promise((resolve, reject) => {
          pendingQuestions.set(requestId, { resolve, reject })
          request.signal?.addEventListener('abort', () => {
            if (pendingQuestions.delete(requestId)) reject(new Error('the question was aborted'))
          }, { once: true })
          send('chattree:question', { requestId, questions: request.questions ?? [] })
        })
      }
      const questionEvent = 'user-questions/request'
      const questionKey = remote?.events?.eventKey
      if (typeof questionKey === 'function' && typeof ctx.on === 'function') {
        ctx.on(questionKey.call(remote.events, questionEvent), answerQuestionOnCanvas, { prepend: true })
      } else if (typeof remote?.$on === 'function') {
        remote.$on(questionEvent, answerQuestionOnCanvas)
      }
      const showMapOverlay = () => {
        window.clearTimeout(mapOpenFallback)
        mapOpening = false
        overlay.hidden = false
        overlay.classList.remove('is-opening')
        syncCurrentSession()
      }
      const open = () => {
        window.clearTimeout(mapOpenFallback)
        mapOpening = true
        setView('map')
        // Keep the iframe laid out while hidden so its canvas can receive a
        // real scroll offset. display:none would clamp scrollTop back to zero.
        overlay.hidden = false
        overlay.classList.add('is-opening')
        window.requestAnimationFrame(() => {
          send('chattree:map-opened')
          syncCurrentSession()
        })
        mapOpenFallback = window.setTimeout(showMapOverlay, 300)
      }
      const onFrameLoad = () => {
        syncCurrentSession()
        if (mapOpening) send('chattree:map-opened')
      }
      const onMessage = event => {
        if (event.origin !== location.origin || event.data?.source !== 'dsh-chattree') return
        if (event.data.type === 'chattree:close') return close()
        if (event.data.type === 'chattree:map-ready') return showMapOverlay()
        if (event.data.type === 'chattree:request-current') {
          send('chattree:workspaces', { workspaces: workspaceSnapshot(ctx) })
          return send('chattree:current-session', { session: currentSession(ctx) })
        }
        if (event.data.type === 'chattree:open-session') {
          try { ctx.sessions.open(event.data.sessionId); close() } catch { send('chattree:bridge-error', { message: '关联的 DSH 会话已不可用' }) }
          // Best-effort anchor to the requested turn: chat nodes expose their
          // source event seq (anchorSeq) and render with data-chat-anchor-key,
          // so resolve seq -> node key -> scroll once the view materializes.
          const seq = event.data.seq
          if (Number.isInteger(seq)) {
            const tryScroll = attempt => {
              const scope = ctx.sessions.scope(event.data.sessionId)
              const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
              if (session === undefined) return
              const chat = session.getSnapshot()?.chat
              if (chat === undefined) return
              let key = undefined
              for (const node of chat.nodes.values()) {
                if (node.anchorSeq === seq) { key = node.key; break }
              }
              if (key !== undefined) {
                const row = document.querySelector(`[data-chat-anchor-key="${CSS.escape(key)}"]`)
                if (row instanceof HTMLElement) row.scrollIntoView({ block: 'start' })
                return
              }
              if (attempt < 3) window.setTimeout(() => tryScroll(attempt + 1), 500)
            }
            window.setTimeout(() => tryScroll(0), 300)
          }
          return
        }
        if (event.data.type === 'chattree:activate-session') {
          // Bidirectional current-session sync: switch DSH's current session
          // without closing the map; the sessions-list subscription re-sends
          // chattree:current-session so the map follows the new highlight.
          try { ctx.sessions.open(event.data.sessionId) } catch { send('chattree:bridge-error', { message: '关联的 DSH 会话已不可用' }) }
          return
        }
        if (event.data.type === 'chattree:fork-session') {
          const atSeq = Number.isInteger(event.data.atSeq) ? event.data.atSeq : undefined
          ctx.sessions.fork({ sessionId: event.data.sessionId, atSeq, increaseTitle: true }).then(id => {
            forkedSessionIds.add(id)
            trace({ stage: 'forked', childId: id, sourceId: event.data.sessionId, atSeq: atSeq ?? null })
            const snapshot = ctx.sessions.list.getSnapshot()
            send('chattree:forked-session', { requestId: event.data.requestId, session: { id, title: snapshot.byId[id]?.displayTitle ?? 'DSH 分支' } })
          }).catch(() => { send('chattree:bridge-error', { message: 'DSH 分支创建失败，请确认源会话已经完成当前轮次' }) })
          return
        }
        if (event.data.type === 'chattree:answer-question') {
          const pending = pendingQuestions.get(event.data.requestId)
          if (pending !== undefined) {
            pendingQuestions.delete(event.data.requestId)
            if (event.data.answer == null) pending.reject(new Error('the user dismissed the question'))
            else pending.resolve(event.data.answer)
          }
          return
        }
        if (event.data.type === 'chattree:load-composer') {
          const { requestId, sessionId } = event.data
          const fail = error => send('chattree:composer-error', { requestId, message: error instanceof Error ? error.message : '读取输入选项失败' })
          Promise.resolve().then(async () => {
            const scope = ctx.sessions.scope(sessionId)
            const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
            if (session === undefined) throw new Error('关联的 DSH 会话已不可用')
            // The catalog is a Session-addressed remote; `listModels` lives on the
            // host-only ctx.llm, so this is the client's only route to it. Failing to
            // read it leaves the model pickers empty and the reason in `catalogError`;
            // it must not take the permissions and context reads down with it.
            const catalogResult = await modelCatalogOf(session)
            const catalogError = catalogResult?.ok === false
              ? String(catalogResult.error?.message ?? '无法读取模型目录')
              : null
            const catalog = catalogError === null ? catalogResult?.value ?? catalogResult ?? {} : {}
            // Client projections are Session-scoped observable faces, not a
            // Cordis service: `faceOf(key)` is the identity-stable face and
            // `getSnapshot()` its current value (undefined = capability absent).
            const projected = key => session.projections.faceOf(key).getSnapshot()
            const values = {
              modelSelection: projected('modelSelection'),
              permissions: projected('permissions'),
              contextPressure: projected('contextPressure'),
              // The heuristic composition of the retained surface -- system prompt,
              // tools, conversation -- that the context panel lists under the total.
              contextBreakdown: projected('contextBreakdown')
            }
            // Whether this session can compact at all. The command comes from the agent preset,
            // so a preset without compaction must not be offered a button that cannot work --
            // and asking is the only way to tell one preset from another.
            let canCompact = false
            try {
              const commands = remoteCommands()
              if (commands !== undefined && typeof commands.list === 'function') {
                const listed = await commands.list(sessionId)
                canCompact = listed?.ok !== false && Array.isArray(listed?.value)
                  && listed.value.some(command => command?.name === 'compact')
              }
            } catch { /* a build without a command registry simply offers no compaction */ }
            send('chattree:composer', {
              requestId,
              sessionId,
              canCompact,
              models: (catalog.groups ?? []).map(group => ({
                provider: group.id,
                name: group.name ?? group.id,
                models: (group.models ?? []).map(model => ({
                  id: model.id,
                  name: model.name,
                  efforts: (model.reasoning?.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name })),
                  ...model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }
                }))
              })),
              // Ship the catalog's own key names back: a shape mismatch is
              // otherwise invisible (the reply arrives, the picker is just empty).
              catalogKeys: catalog !== null && typeof catalog === 'object' ? Object.keys(catalog) : [],
              catalogError,
              providers: Array.isArray(catalog.routableProviders) ? catalog.routableProviders : [],
              failures: Array.isArray(catalog.failures) ? catalog.failures.map(item => String(item?.message ?? item?.name ?? '')).filter(Boolean) : [],
              model: values.modelSelection?.next ?? catalog.default ?? null,
              permissions: values.permissions?.options ?? [],
              permission: values.permissions?.currentValue ?? null,
              context: values.contextPressure ?? null,
              breakdown: values.contextBreakdown ?? null
            })
          }).catch(fail)
          return
        }
        if (event.data.type === 'chattree:select-model') {
          const { requestId, sessionId, provider, model } = event.data
          const reasoningEffort = event.data.reasoningEffort
          const scope = ctx.sessions.scope(sessionId)
          const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
          Promise.resolve().then(() => selectModelOf(session, {
            sessionId,
            provider,
            model,
            ...reasoningEffort === undefined ? {} : { reasoningEffort }
          })).then(result => {
            if (result?.ok === false) throw new Error(result.error?.message ?? 'DSH 未能切换模型')
            send('chattree:model-selected', { requestId, sessionId })
          }).catch(error => send('chattree:bridge-error', { requestId, message: error instanceof Error ? error.message : 'DSH 未能切换模型' }))
          return
        }
        if (event.data.type === 'chattree:select-permission') {
          const { requestId, sessionId, preset } = event.data
          Promise.resolve().then(() => ctx.remote.commands.execute(sessionId, `/permission ${preset}`, [])).then(result => {
            if (result?.ok === false) throw new Error(result.error?.message ?? 'DSH 未能切换权限')
            send('chattree:permission-selected', { requestId, sessionId })
          }).catch(error => send('chattree:bridge-error', { requestId, message: error instanceof Error ? error.message : 'DSH 未能切换权限' }))
          return
        }
        // Compaction is the Host's own `/compact`: this only asks for it and reports what came
        // back. It stays a command rather than a service call because that is the seam the Host
        // exposes, and because the command owns the idle check, the durability checkpoint and
        // the "nothing to compact yet" answer -- all of which belong on that side.
        if (event.data.type === 'chattree:compact') {
          const { requestId, sessionId } = event.data
          Promise.resolve().then(async () => {
            const commands = remoteCommands()
            if (commands === undefined || typeof commands.execute !== 'function') throw new Error('DSH 未提供命令接口，无法压缩')
            const response = await commands.execute(sessionId, '/compact', [])
            if (response?.ok === false) throw new Error(response.error?.message ?? '压缩失败')
            // The registry answers `undefined` for a line it does not know, which means this
            // session has no `/compact` at all -- a missing capability, not a failed attempt.
            if (response?.value === undefined || response.value === null) throw new Error('这个会话没有 /compact 命令')
            const result = response.value.result ?? {}
            if (result.kind === 'error') throw new Error(typeof result.text === 'string' ? result.text : '压缩失败')
            send('chattree:compacted', { requestId, sessionId, text: typeof result.text === 'string' ? result.text : '' })
          }).catch(error => send('chattree:compact-failed', { requestId, sessionId, message: error instanceof Error ? error.message : '压缩失败' }))
          return
        }
        if (event.data.type === 'chattree:attach') {
          const { requestId, sessionId } = event.data
          const files = Array.isArray(event.data.files) ? event.data.files : []
          Promise.resolve().then(async () => {
            const attachments = []
            for (const file of files) attachments.push(await toAttachment(sessionId, file))
            send('chattree:attached', { requestId, sessionId, attachments })
          }).catch(error => send('chattree:bridge-error', { requestId, message: error instanceof Error ? error.message : '附件上传失败' }))
          return
        }
        if (event.data.type === 'chattree:send-message') {
          const text = typeof event.data.text === 'string' ? event.data.text.trim() : ''
          const parts = (Array.isArray(event.data.parts) ? event.data.parts : []).filter(part => part !== null && typeof part === 'object' && typeof part.type === 'string')
          if (text === '' && parts.length === 0) return send('chattree:bridge-error', { requestId: event.data.requestId, message: '消息不能为空' })
          prompt(event.data.sessionId, text, parts).then(() => {
            send('chattree:message-sent', { requestId: event.data.requestId, sessionId: event.data.sessionId })
          }).catch(error => {
            send('chattree:bridge-error', { requestId: event.data.requestId, message: error instanceof Error ? error.message : 'DSH 消息发送失败' })
          })
          return
        }
        if (event.data.type === 'chattree:create-session') {
          const workspaceId = typeof event.data.workspaceId === 'string' && event.data.workspaceId !== '' && event.data.workspaceId !== 'dsh-ungrouped' ? event.data.workspaceId : undefined
          const cwd = typeof event.data.cwd === 'string' && event.data.cwd !== '' ? event.data.cwd : undefined
          const create = workspaceId === undefined ? ctx.sessions.create(cwd === undefined ? {} : { cwd }) : ctx.sessions.create({ workspaceId })
          create.then(id => {
            const snapshot = ctx.sessions.list.getSnapshot()
            const title = snapshot.byId[id]?.displayTitle ?? '新会话'
            const reply = threadId => send('chattree:created-session', { requestId: event.data.requestId, session: { id, threadId, title, cwd: snapshot.byId[id]?.cwd ?? cwd ?? null } })
            // Ask the host which thread it minted for this session, then answer with
            // that id so the canvas can key its optimistic thread correctly.
            void fetch('/chattree/api/sessions/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions: [{ id, title, cwd: snapshot.byId[id]?.cwd ?? cwd ?? '' }] }) })
              .then(function (response) { return response.ok ? response.json() : undefined })
              .then(function (body) {
                // The host keys a thread by its dshSessionId; read back the id it minted.
                const workspaces = (body && Array.isArray(body.workspaces)) ? body.workspaces : []
                let threadId
                for (const workspace of workspaces) {
                  for (const thread of (workspace && workspace.threads) || []) {
                    if (thread && thread.dshSessionId === id) threadId = thread.id
                  }
                }
                reply(threadId)
              })
              .catch(function () { reply(undefined) })
          }).catch(() => { send('chattree:bridge-error', { requestId: event.data.requestId, message: 'DSH 会话创建失败，请先在 DSH 选择工作目录' }) })
        }
      }
      const onKeyDown = event => { if (event.key === 'Escape' && !overlay.hidden) close() }
      // Follow DSH's live theme switch: body[data-ds-dark-theme] is the web
      // client's dark-mode signal, mirrored into the map iframe via chattree:theme.
      const themeObserver = typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => syncTheme())
      if (themeObserver !== null && document.body) {
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
      }
      const unsubscribeSessions = ctx.sessions.list.subscribe(syncCurrentSession)
      const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(syncCurrentSession)
      dialogButton.addEventListener('click', close)
      mapButton.addEventListener('click', open)
      frame.addEventListener('load', onFrameLoad)
      window.addEventListener('message', onMessage)
      window.addEventListener('keydown', onKeyDown)
      ctx.effect(() => () => {
        dialogButton.removeEventListener('click', close)
        mapButton.removeEventListener('click', open)
        frame.removeEventListener('load', onFrameLoad)
        window.removeEventListener('message', onMessage)
        window.removeEventListener('keydown', onKeyDown)
        themeObserver?.disconnect()
        unsubscribeSessions()
        unsubscribeWorkspaces()
        for (const unsubscribe of liveUnsubscribers.values()) unsubscribe()
        host.remove()
        style.remove()
      }, 'chattree: web workspace switch')
    }
    return module.exports
  },
})
