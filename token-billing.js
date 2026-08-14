// token-billing: durable token billing meter for this dsh profile.
// Counts every model call's token usage via the `llm/stream` waterfall and
// prices it with a durable, editable price table (defaults: DeepSeek official
// CNY pricing per 1M tokens). Ledger persists in ~/.dsh/storages via the host
// `storageDomain` facility (backend: json).
import { z } from 'zod'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const name = 'token-billing'
export const inject = ['storageDomain', 'tools', 'webServer']

const MAX_CALLS = 300
const MAX_SESSIONS = 200

const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reasoningTokens: z.number(),
}).strict()

const priceRowSchema = z.object({
  pattern: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number().nullable(),
}).strict()

const pricesSchema = z.object({
  currency: z.string(),
  rows: z.array(priceRowSchema),
}).strict()

const callSchema = z.object({
  sessionId: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  usage: usageSchema.nullable(),
  cost: z.number(),
  durationMs: z.number(),
  at: z.number(),
  status: z.string(),
  finish: z.string().nullable(),
}).strict()

const sessionAggSchema = z.object({
  sessionId: z.string(),
  calls: z.number(),
  cost: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reasoningTokens: z.number(),
}).strict()

const totalsSchema = z.object({
  calls: z.number(),
  cost: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reasoningTokens: z.number(),
  perSession: z.record(z.string(), sessionAggSchema),
}).strict()

// Default price table: DeepSeek official CNY pricing (¥ per 1M tokens).
const DEFAULT_PRICES = {
  currency: 'CNY',
  rows: [
    { pattern: 'deepseek-reasoner', input: 4, output: 16, cacheRead: 1, cacheWrite: 4, reasoning: null },
    { pattern: 'deepseek-chat', input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2, reasoning: null },
    { pattern: '*', input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2, reasoning: null },
  ],
}

function initialTotals() {
  return {
    calls: 0, cost: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    perSession: {},
  }
}

const spec = defineDomain({
  name: 'token_billing',
  version: 1,
  global: { schema: pricesSchema, initial: DEFAULT_PRICES },
  tables: {
    calls: domainTable(callSchema),
    totals: domainTable(totalsSchema),
  },
})

export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(spec)
  // ctx.effect: the callback runs immediately as setup; its RETURN value is the
  // disposer invoked when the fiber stops. Close the domain only at disposal.
  ctx.effect(() => () => { void domain.close() })
  const callsTable = domain.table('calls')
  const totalsTable = domain.table('totals')
  const pricesGlobal = domain.global

  if (totalsTable.get('all') === undefined) await totalsTable.put('all', initialTotals())

  function roundCost(v) { return Math.round(v * 1e6) / 1e6 }
  function nowMs() { try { return typeof Date === 'function' ? Date.now() : 0 } catch (e) { return 0 } }
  function fallbackRow(prices) { for (const p of prices.rows) if (p.pattern === '*') return p; return prices.rows[prices.rows.length - 1] }

  function priceFor(prices, model) {
    if (typeof model !== 'string') return fallbackRow(prices)
    for (const p of prices.rows) if (p.pattern !== '*' && model === p.pattern) return p
    for (const p of prices.rows) if (p.pattern !== '*' && model.indexOf(p.pattern) === 0) return p
    return fallbackRow(prices)
  }

  // Billing formula (matches DeepSeek's split):
  // uncached input + cache write at the input price, cache read at the cache
  // read price, output at the output price, reasoning at its own or the output price.
  function costOf(model, usage) {
    const p = priceFor(pricesGlobal.get(), model)
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

  async function pruneCalls() {
    while (callsTable.size > MAX_CALLS) {
      const keys = Array.from(callsTable.keys(), Number).sort((a, b) => a - b)
      if (keys.length === 0) return
      await callsTable.delete(String(keys[0]))
    }
  }

  async function record(entry) {
    try {
      const next = await totalsTable.update('all', (cur) => {
        const u = entry.usage || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
        const perSession = { ...cur.perSession }
        if (typeof entry.sessionId === 'string' && entry.sessionId.length > 0) {
          const sid = entry.sessionId
          const prev = perSession[sid] || { sessionId: sid, calls: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
          perSession[sid] = {
            sessionId: sid,
            calls: prev.calls + 1,
            cost: prev.cost + entry.cost,
            inputTokens: prev.inputTokens + u.inputTokens,
            outputTokens: prev.outputTokens + u.outputTokens,
            cacheReadTokens: prev.cacheReadTokens + u.cacheReadTokens,
            cacheWriteTokens: prev.cacheWriteTokens + u.cacheWriteTokens,
            reasoningTokens: prev.reasoningTokens + u.reasoningTokens,
          }
        }
        let keys = Object.keys(perSession)
        while (keys.length > MAX_SESSIONS) {
          let cheapest = null
          for (const k of keys) if (cheapest === null || perSession[k].cost < perSession[cheapest].cost) cheapest = k
          if (cheapest === null) break
          delete perSession[cheapest]
          keys = keys.filter((k) => k !== cheapest)
        }
        return {
          calls: cur.calls + 1,
          cost: cur.cost + entry.cost,
          inputTokens: cur.inputTokens + u.inputTokens,
          outputTokens: cur.outputTokens + u.outputTokens,
          cacheReadTokens: cur.cacheReadTokens + u.cacheReadTokens,
          cacheWriteTokens: cur.cacheWriteTokens + u.cacheWriteTokens,
          reasoningTokens: cur.reasoningTokens + u.reasoningTokens,
          perSession,
        }
      })
      await callsTable.put(String(next.calls), entry)
      await pruneCalls()
    } catch (err) {
      console.error('[token-billing] record failed:', err)
    }
  }

  // Wrap the upstream stream: pass every chunk through untouched, only read
  // the usage / finish fields for accounting.
  async function* metered(upstream, options) {
    const started = nowMs()
    const entry = {
      sessionId: typeof options.sessionId === 'string' ? options.sessionId : null,
      provider: typeof options.provider === 'string' ? options.provider : '',
      model: typeof options.model === 'string' ? options.model : '',
      usage: null,
      cost: 0,
      durationMs: 0,
      at: started,
      status: 'ok',
      finish: null,
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
      throw err
    } finally {
      entry.durationMs = nowMs() - started
      entry.cost = entry.usage ? costOf(entry.model, entry.usage) : 0
      await record(entry)
    }
  }

  ctx.on('llm/stream', (options, next) => metered(next(), options))

  function symbol(prices) {
    if (prices.currency === 'CNY') return '¥'
    if (prices.currency === 'USD') return '$'
    return prices.currency + ' '
  }

  function summary() {
    const prices = pricesGlobal.get()
    const totals = totalsTable.get('all') || initialTotals()
    const sym = symbol(prices)
    const perSession = Object.values(totals.perSession).map((s) => ({ ...s, cost: roundCost(s.cost) })).sort((a, b) => b.cost - a.cost)
    const recent = []
    for (const rec of callsTable.entries()) recent.push({
      seq: Number(rec[0]),
      sessionId: rec[1].sessionId,
      provider: rec[1].provider,
      model: rec[1].model,
      usage: rec[1].usage,
      cost: roundCost(rec[1].cost),
      durationMs: rec[1].durationMs,
      status: rec[1].status,
      finish: rec[1].finish,
    })
    recent.sort((a, b) => b.seq - a.seq)
    return {
      currency: prices.currency,
      symbol: sym,
      totals: {
        calls: totals.calls, cost: roundCost(totals.cost),
        inputTokens: totals.inputTokens, outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens, cacheWriteTokens: totals.cacheWriteTokens,
        reasoningTokens: totals.reasoningTokens,
      },
      perSession: perSession.slice(0, 20),
      recent: recent.slice(0, 12),
      prices: { currency: prices.currency, rows: prices.rows.map((r) => ({ ...r })) },
    }
  }

  async function setPrice(args) {
    const pattern = typeof args.pattern === 'string' ? args.pattern : ''
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
    const current = pricesGlobal.get()
    const rows = current.rows.map((r) => ({ ...r }))
    let target = null
    for (const r of rows) if (r.pattern === pattern) target = r
    if (target === null) {
      target = { pattern, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null }
      const star = rows.findIndex((r) => r.pattern === '*')
      rows.splice(star >= 0 ? star : rows.length, 0, target)
    }
    for (const f of Object.keys(patch)) target[f] = patch[f]
    await pricesGlobal.set({ currency: current.currency, rows })
    return { ok: true, message: 'price row updated: "' + pattern + '" (' + current.currency + ' per 1M tokens)' }
  }

  async function removePrice(args) {
    const pattern = typeof args.pattern === 'string' ? args.pattern : ''
    if (pattern.length === 0) return { ok: false, message: 'pattern is required' }
    if (pattern === '*') return { ok: false, message: 'the fallback row "*" cannot be removed' }
    const current = pricesGlobal.get()
    const rows = current.rows.filter((r) => r.pattern !== pattern)
    if (rows.length === current.rows.length) return { ok: false, message: 'no price row matched "' + pattern + '"' }
    await pricesGlobal.set({ currency: current.currency, rows })
    return { ok: true, message: 'price row removed: "' + pattern + '"' }
  }

  async function setCurrency(args) {
    const code = typeof args.currency === 'string' ? args.currency.trim() : ''
    if (code.length === 0 || code.length > 8) return { ok: false, message: 'currency must be a 1-8 character code (e.g. CNY, USD)' }
    const current = pricesGlobal.get()
    await pricesGlobal.set({ currency: code, rows: current.rows })
    return { ok: true, message: 'currency set to "' + code + '"' }
  }

  async function resetLedger() {
    const keys = Array.from(callsTable.keys())
    for (const k of keys) await callsTable.delete(k)
    await totalsTable.put('all', initialTotals())
    return { ok: true, message: 'Billing ledger reset: all counters cleared.' }
  }

  // ── Web API for the client panel ─────────────────────────────────────
  function send(res, code, value) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/token-billing/summary',
    handler(req, res) {
      try {
        send(res, 200, summary())
      } catch (err) {
        send(res, 500, { ok: false, message: String(err && err.message ? err.message : err) })
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/token-billing/reset',
    async handler(req, res) {
      if (req.method !== 'POST') { send(res, 405, { ok: false, message: 'POST only' }); return }
      try {
        await resetLedger()
        send(res, 200, summary())
      } catch (err) {
        send(res, 500, { ok: false, message: String(err && err.message ? err.message : err) })
      }
    },
  })

  const tool = defineTool({
    name: 'billing_report',
    description: 'Token billing report and configuration for this harness. Reports every model call observed with token usage and cost priced against a durable, editable price table (default currency CNY, prices per 1M tokens); can also set/remove model price rows, change the currency, or reset the ledger.',
    parameters: {
      action: { type: 'string', required: true, enum: ['report', 'list-prices', 'set-price', 'remove-price', 'set-currency', 'reset'], description: 'What to do: report the ledger, list price rows, set a price row, remove a price row, change the currency, or reset all counters.' },
      pattern: { type: 'string', description: 'Model id or model prefix for the price row (set-price / remove-price).' },
      input: { type: 'number', description: 'Price per 1M tokens: uncached input.' },
      output: { type: 'number', description: 'Price per 1M tokens: output.' },
      cacheRead: { type: 'number', description: 'Price per 1M tokens: cached input read.' },
      cacheWrite: { type: 'number', description: 'Price per 1M tokens: cached input write.' },
      reasoning: { type: 'number', description: 'Price per 1M tokens: reasoning tokens (defaults to the output price).' },
      currency: { type: 'string', description: 'Currency code for set-currency (e.g. CNY, USD).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          summary: { type: 'object', additionalProperties: true },
        },
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
          '- currency: ' + s.currency,
          '- calls: ' + t.calls + ', total cost: ' + s.symbol + t.cost.toFixed(4),
          '- tokens: input ' + t.inputTokens + ', output ' + t.outputTokens + ', cache-read ' + t.cacheReadTokens + ', cache-write ' + t.cacheWriteTokens + ', reasoning ' + t.reasoningTokens,
        ]
        if (s.perSession.length > 0) {
          lines.push('per session:')
          for (const row of s.perSession.slice(0, 15)) lines.push('  - ' + String(row.sessionId).slice(0, 10) + ': ' + row.calls + ' calls, ' + s.symbol + row.cost.toFixed(4))
        } else {
          lines.push('per session: (none)')
        }
        return { ok: true, message: lines.join('\n'), summary: s }
      }
      if (action === 'list-prices') {
        const s = summary()
        const rows = s.prices.rows.map((p) => '- ' + p.pattern + ': input ' + p.input + ', output ' + p.output + ', cache-read ' + p.cacheRead + ', cache-write ' + p.cacheWrite + (typeof p.reasoning === 'number' ? ', reasoning ' + p.reasoning : ''))
        return { ok: true, message: 'price rows (' + s.currency + ' per 1M tokens):\n' + rows.join('\n') }
      }
      if (action === 'set-price') return setPrice(args)
      if (action === 'remove-price') return removePrice(args)
      if (action === 'set-currency') return setCurrency(args)
      if (action === 'reset') return resetLedger()
      return { ok: false, message: 'unknown action: ' + String(action) }
    },
  })
  ctx.tools.register(tool)

  console.log('[token-billing] durable meter active (currency: ' + pricesGlobal.get().currency + ')')
}
