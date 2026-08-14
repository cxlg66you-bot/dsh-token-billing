// 归档:pkg-1(首个版本,USD 默认价)。
// 该版本 defineTool 的 parameters 根节点带 additionalProperties:false,
// 且 output schema 使用根级 required 数组 —— 两者均不被 DSL 接受,host 启动失败。
// 本文件为演进史归档,不代表可用代码;可用的持久版见仓库根目录 token-billing.js。
return {
  apply(ctx) {
    const MAX_LEDGER = 1000
    const MAX_SESSIONS = 200

    // 单价表: USD / 1M tokens。'*' 为兜底行。默认值参考 DeepSeek 官方定价,可随时通过工具/RPC 修改。
    const DEFAULT_FALLBACK = { pattern: '*', input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 }
    const prices = [
      { pattern: 'deepseek-reasoner', input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
      { pattern: 'deepseek-chat', input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0.27 },
      { pattern: '*', input: DEFAULT_FALLBACK.input, output: DEFAULT_FALLBACK.output, cacheRead: DEFAULT_FALLBACK.cacheRead, cacheWrite: DEFAULT_FALLBACK.cacheWrite },
    ]

    const ledger = []
    const perSession = new Map()
    const totals = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

    function roundUsd(v) { return Math.round(v * 1e6) / 1e6 }
    function nowMs() { try { return typeof Date === 'function' ? Date.now() : 0 } catch (e) { return 0 } }
    function fallbackRow() { for (const p of prices) if (p.pattern === '*') return p; return DEFAULT_FALLBACK }

    function priceFor(model) {
      if (typeof model !== 'string') return fallbackRow()
      for (const p of prices) if (p.pattern !== '*' && model === p.pattern) return p
      for (const p of prices) if (p.pattern !== '*' && model.indexOf(p.pattern) === 0) return p
      return fallbackRow()
    }

    // 计费口径: inputTokens(未命中缓存) + cacheWriteTokens 按输入单价; cacheReadTokens 按缓存读单价; outputTokens 按输出单价;
    // reasoningTokens 默认按输出单价(DeepSeek 推理 token 即按输出计价)。
    function costOf(model, usage) {
      const p = priceFor(model)
      const input = usage.inputTokens || 0
      const output = usage.outputTokens || 0
      const cacheRead = usage.cacheReadTokens || 0
      const cacheWrite = usage.cacheWriteTokens || 0
      const reasoning = usage.reasoningTokens || 0
      const reasoningPrice = typeof p.reasoning === 'number' ? p.reasoning : (p.output || 0)
      return (
        (input + cacheWrite) * (p.input || 0) +
        cacheRead * (p.cacheRead || 0) +
        output * (p.output || 0) +
        reasoning * reasoningPrice
      ) / 1e6
    }

    function addTokens(target, usage) {
      target.inputTokens += usage.inputTokens || 0
      target.outputTokens += usage.outputTokens || 0
      target.cacheReadTokens += usage.cacheReadTokens || 0
      target.cacheWriteTokens += usage.cacheWriteTokens || 0
      target.reasoningTokens += usage.reasoningTokens || 0
    }

    function record(entry) {
      entry.seq = ledger.length + 1
      ledger.push(entry)
      while (ledger.length > MAX_LEDGER) ledger.shift()
      totals.calls += 1
      totals.costUsd += entry.costUsd
      if (entry.usage) addTokens(totals, entry.usage)
      const sid = entry.sessionId
      if (typeof sid === 'string' && sid.length > 0) {
        let agg = perSession.get(sid)
        if (agg === undefined) {
          agg = { sessionId: sid, calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
          perSession.set(sid, agg)
        }
        agg.calls += 1
        agg.costUsd += entry.costUsd
        if (entry.usage) addTokens(agg, entry.usage)
      }
      if (perSession.size > MAX_SESSIONS) {
        let cheapest = null
        for (const agg of perSession.values()) if (cheapest === null || agg.costUsd < cheapest.costUsd) cheapest = agg
        if (cheapest !== null) perSession.delete(cheapest.sessionId)
      }
    }

    // 包装上游流: 透传全部 chunk,只读取 usage / finish 字段做记账。
    async function* metered(upstream, options) {
      const started = nowMs()
      const entry = {
        sessionId: typeof options.sessionId === 'string' ? options.sessionId : null,
        provider: typeof options.provider === 'string' ? options.provider : '',
        model: typeof options.model === 'string' ? options.model : '',
        usage: null,
        costUsd: 0,
        durationMs: 0,
        status: 'ok',
        finish: null,
        error: null,
      }
      try {
        for await (const chunk of upstream) {
          if (chunk !== null && typeof chunk === 'object') {
            if (chunk.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
              entry.usage = {
                inputTokens: Number(chunk.usage.inputTokens) || 0,
                outputTokens: Number(chunk.usage.outputTokens) || 0,
                cacheReadTokens: Number(chunk.usage.cacheReadTokens) || 0,
                cacheWriteTokens: Number(chunk.usage.cacheWriteTokens) || 0,
                reasoningTokens: Number(chunk.usage.reasoningTokens) || 0,
              }
            } else if (chunk.type === 'finish') {
              entry.finish = chunk.reason && chunk.reason.kind ? String(chunk.reason.kind) : 'unknown'
            }
          }
          yield chunk
        }
      } catch (err) {
        entry.status = 'error'
        entry.error = String(err && err.message ? err.message : err)
        throw err
      } finally {
        entry.durationMs = nowMs() - started
        entry.costUsd = entry.usage ? costOf(entry.model, entry.usage) : 0
        record(entry)
      }
    }

    ctx.on('llm/stream', (options, next) => metered(next(), options))

    function summary() {
      const sessions = []
      for (const agg of perSession.values()) sessions.push({
        sessionId: agg.sessionId, calls: agg.calls, costUsd: roundUsd(agg.costUsd),
        inputTokens: agg.inputTokens, outputTokens: agg.outputTokens,
        cacheReadTokens: agg.cacheReadTokens, cacheWriteTokens: agg.cacheWriteTokens,
        reasoningTokens: agg.reasoningTokens,
      })
      sessions.sort((a, b) => b.costUsd - a.costUsd)
      const recent = []
      for (let i = ledger.length - 1; i >= 0 && recent.length < 12; i--) {
        const e = ledger[i]
        recent.push({
          seq: e.seq, sessionId: e.sessionId, provider: e.provider, model: e.model,
          usage: e.usage, costUsd: roundUsd(e.costUsd), durationMs: e.durationMs,
          status: e.status, finish: e.finish,
        })
      }
      return {
        totals: {
          calls: totals.calls, costUsd: roundUsd(totals.costUsd),
          inputTokens: totals.inputTokens, outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens, cacheWriteTokens: totals.cacheWriteTokens,
          reasoningTokens: totals.reasoningTokens,
        },
        sessions,
        recent,
        prices: prices.map((p) => ({
          pattern: p.pattern, input: p.input || 0, output: p.output || 0,
          cacheRead: p.cacheRead || 0, cacheWrite: p.cacheWrite || 0,
          reasoning: typeof p.reasoning === 'number' ? p.reasoning : null,
        })),
      }
    }

    function resetLedger() {
      ledger.length = 0
      perSession.clear()
      totals.calls = 0; totals.costUsd = 0
      totals.inputTokens = 0; totals.outputTokens = 0
      totals.cacheReadTokens = 0; totals.cacheWriteTokens = 0; totals.reasoningTokens = 0
      return summary()
    }

    function setPrice(args) {
      const pattern = args && typeof args.pattern === 'string' ? args.pattern : ''
      if (pattern.length === 0) return { ok: false, message: 'pattern must be a non-empty string' }
      const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']
      const patch = {}
      for (const f of fields) {
        const v = args[f]
        if (v === undefined) continue
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return { ok: false, message: f + ' must be a non-negative number' }
        patch[f] = v
      }
      if (Object.keys(patch).length === 0) return { ok: false, message: 'provide at least one price field' }
      let target = null
      for (const p of prices) if (p.pattern === pattern) target = p
      if (target === null) {
        target = { pattern, input: DEFAULT_FALLBACK.input, output: DEFAULT_FALLBACK.output, cacheRead: DEFAULT_FALLBACK.cacheRead, cacheWrite: DEFAULT_FALLBACK.cacheWrite }
        prices.splice(Math.max(0, prices.length - 1), 0, target)
      }
      for (const f of Object.keys(patch)) target[f] = patch[f]
      return { ok: true, message: 'price row updated: "' + pattern + '"' }
    }

    function removePrice(args) {
      const pattern = args && typeof args.pattern === 'string' ? args.pattern : ''
      if (pattern.length === 0) return { ok: false, message: 'pattern is required' }
      if (pattern === '*') return { ok: false, message: 'the fallback row "*" cannot be removed' }
      const before = prices.length
      for (let i = prices.length - 1; i >= 0; i--) if (prices[i].pattern === pattern) prices.splice(i, 1)
      return before === prices.length
        ? { ok: false, message: 'no price row matched "' + pattern + '"' }
        : { ok: true, message: 'price row removed: "' + pattern + '"' }
    }

    harness.handle('summary', () => summary())
    harness.handle('reset', () => resetLedger())
    harness.handle('set-price', (args) => setPrice(args))
    harness.handle('remove-price', (args) => removePrice(args))

    const tool = harness.defineTool({
      name: 'billing_report',
      description: 'Token billing report and configuration. Reports every model call observed in this process with token usage and USD cost (prices are per 1M tokens); can also set/remove model price rows or reset the meter.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['report', 'list-prices', 'set-price', 'remove-price', 'reset'], description: 'What to do: report the ledger, list price rows, set a price row, remove a price row, or reset all counters.' },
          pattern: { type: 'string', description: 'Model id or model prefix for the price row (set-price / remove-price).' },
          input: { type: 'number', description: 'USD per 1M tokens: uncached input.' },
          output: { type: 'number', description: 'USD per 1M tokens: output.' },
          cacheRead: { type: 'number', description: 'USD per 1M tokens: cached input read.' },
          cacheWrite: { type: 'number', description: 'USD per 1M tokens: cached input write.' },
          reasoning: { type: 'number', description: 'USD per 1M tokens: reasoning tokens (defaults to output price).' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            summary: { type: 'object' },
          },
          required: ['ok', 'message'],
        },
        render(args, value) {
          return [{ type: 'text', text: typeof value.message === 'string' ? value.message : '' }]
        },
      },
      async execute(args) {
        const action = args.action
        if (action === 'report') {
          const s = summary()
          const t = s.totals
          const lines = [
            'Token billing report:',
            '- calls: ' + t.calls + ', total cost: $' + t.costUsd.toFixed(6),
            '- tokens: input ' + t.inputTokens + ', output ' + t.outputTokens + ', cache-read ' + t.cacheReadTokens + ', cache-write ' + t.cacheWriteTokens + ', reasoning ' + t.reasoningTokens,
          ]
          if (s.sessions.length > 0) {
            lines.push('per session:')
            for (const row of s.sessions.slice(0, 15)) lines.push('  - ' + String(row.sessionId).slice(0, 10) + ': ' + row.calls + ' calls, $' + row.costUsd.toFixed(6))
          } else {
            lines.push('per session: (none)')
          }
          return { ok: true, message: lines.join('\n'), summary: s }
        }
        if (action === 'list-prices') {
          const rows = prices.map((p) => '- ' + p.pattern + ': input ' + (p.input || 0) + ', output ' + (p.output || 0) + ', cache-read ' + (p.cacheRead || 0) + ', cache-write ' + (p.cacheWrite || 0) + (typeof p.reasoning === 'number' ? ', reasoning ' + p.reasoning : ''))
          return { ok: true, message: 'price rows (USD per 1M tokens):\n' + rows.join('\n') }
        }
        if (action === 'set-price') return setPrice(args)
        if (action === 'remove-price') return removePrice(args)
        if (action === 'reset') {
          resetLedger()
          return { ok: true, message: 'Billing meter reset: all counters cleared.' }
        }
        return { ok: false, message: 'unknown action: ' + String(action) }
      },
    })
    harness.registerTool(ctx, tool)

    console.log('[tokbl] token billing meter active')
  },
}
