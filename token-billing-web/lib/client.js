// Client half of the durable token billing package (hand-written module bundle).
// Registers:
//  1. "Token 计费" readout in `conversation.composer.dock` (the stats band under the composer)
//  2. "Token 计费" page in `settings.section`
// Data comes from the host's /api/token-billing/summary (+ POST /reset).
window.__ModuleLoader__.load({
	id: "token-billing-web",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
		var React = require("react")

		exports.name = "token-billing-web"
		exports.inject = ["slots", "timer"]

		function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0 }
		function cost(v) { return "¥" + num(v).toFixed(4) }

		function fetchSummary() {
			return fetch("/api/token-billing/summary").then(function (r) {
				if (!r.ok) throw new Error("HTTP " + r.status)
				return r.json()
			})
		}

		function resetLedger() {
			return fetch("/api/token-billing/reset", { method: "POST" }).then(function (r) {
				if (!r.ok) throw new Error("HTTP " + r.status)
				return r.json()
			})
		}

		// Shared polling hook: `interval` is ctx.interval from the timer service.
		function useBillingData(interval) {
			var aliveRef = React.useRef(true)
			var dataState = React.useState(null)
			var errorState = React.useState(null)
			var data = dataState[0], setData = dataState[1]
			var error = errorState[0], setError = errorState[1]
			React.useEffect(function () {
				aliveRef.current = true
				function refresh() {
					fetchSummary().then(function (d) {
						if (!aliveRef.current) return
						setData(d); setError(null)
					}).catch(function (e) {
						if (!aliveRef.current) return
						setError(String(e && e.message ? e.message : e))
					})
				}
				refresh()
				var timer = interval(refresh, 5000)
				return function () { aliveRef.current = false; timer() }
			}, [])
			return { data: data, error: error }
		}

		// ── shared style tokens ──────────────────────────────────────────
		var MONO = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }
		var THEME = {
			label: "var(--dsw-alias-label-primary, inherit)",
			label2: "var(--dsw-alias-label-secondary, rgba(128,128,128,.8))",
			border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))",
			layer: "var(--dsw-alias-bg-layer-1, transparent)",
			layer2: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12))",
			error: "var(--dsw-alias-state-error-primary, #e5484d)",
		}

		// ── 1. stats-band readout ─────────────────────────────────────────
		function BillingDock(props) {
			var ctx = props.__ctx
			var poll = useBillingData(ctx.interval)
			var data = poll.data, error = poll.error
			if (error !== null && data === null) {
				return React.createElement("span", { style: { fontSize: 12, color: THEME.error } }, "计费数据不可用")
			}
			if (data === null) {
				return React.createElement("span", { style: { fontSize: 12, color: THEME.label2 } }, "计费加载中…")
			}
			var sid = props.sessionId
			var row = null
			for (var i = 0; i < data.perSession.length; i++) if (data.perSession[i].sessionId === sid) { row = data.perSession[i]; break }
			return React.createElement("span", { style: { fontSize: 12, color: THEME.label2 } },
				"💰 本会话 ", React.createElement("b", { style: Object.assign({}, MONO, { color: THEME.label }) }, row !== null ? cost(row.cost) : "¥0.0000"),
				" · 累计 ", React.createElement("b", { style: Object.assign({}, MONO, { color: THEME.label }) }, cost(data.totals.cost)),
				" · ", React.createElement("b", { style: Object.assign({}, MONO, { color: THEME.label }) }, String(num(data.totals.calls))), " 次调用"
			)
		}

		// ── 2. settings page ──────────────────────────────────────────────
		function thStyle(first) {
			return { textAlign: first ? "left" : "right", fontWeight: 500, opacity: 0.7, padding: "3px 8px", fontSize: 12 }
		}
		function tdStyle(first) {
			return { textAlign: first ? "left" : "right", padding: "3px 8px", fontSize: 12, borderTop: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))" }
		}
		function btnStyle() {
			return { background: THEME.layer2, color: THEME.label, border: THEME.border, borderRadius: 6, padding: "3px 12px", cursor: "pointer", fontSize: 12 }
		}
		function sectionStyle() {
			return { fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", opacity: 0.7, margin: "16px 0 6px" }
		}
		function tableStyle() {
			return { width: "100%", borderCollapse: "collapse" }
		}

		function BillingSettings(props) {
			var ctx = props.__ctx
			var poll = useBillingData(ctx.interval)
			var data = poll.data, error = poll.error
			var armedState = React.useState(false)
			var armed = armedState[0], setArmed = armedState[1]

			function onReset() {
				if (!armed) { setArmed(true); ctx.timeout(function () { setArmed(false) }, 3000); return }
				setArmed(false)
				resetLedger().then(function (d) { /* poll refreshes */ }).catch(function () {})
			}

			return React.createElement("div", { style: { padding: "8px 8px 24px", maxWidth: 760 } },
				React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 } },
					React.createElement("span", { style: { fontWeight: 600, fontSize: 15, marginRight: "auto" } }, "🧾 Token 计费 (实时)"),
					React.createElement("button", { style: btnStyle(), onClick: function () { /* next poll ticks */ } }, "5 秒自动刷新"),
					React.createElement("button", { style: btnStyle(), onClick: onReset }, armed ? "确认清零?" : "清零账单"),
				),
				error !== null && data === null ? React.createElement("div", { style: { color: THEME.error, fontSize: 12 } }, error) : null,
				data === null ? React.createElement("div", { style: { fontSize: 12, color: THEME.label2 } }, "加载中…") : React.createElement("div", null,
					React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "8px 24px", fontSize: 13 } },
						React.createElement("span", null, "币种 ", React.createElement("b", { style: MONO }, data.currency)),
						React.createElement("span", null, "累计成本 ", React.createElement("b", { style: MONO }, cost(data.totals.cost))),
						React.createElement("span", null, "调用 ", React.createElement("b", { style: MONO }, String(num(data.totals.calls)))),
						React.createElement("span", null, "输入 ", React.createElement("b", { style: MONO }, String(num(data.totals.inputTokens)))),
						React.createElement("span", null, "输出 ", React.createElement("b", { style: MONO }, String(num(data.totals.outputTokens)))),
						React.createElement("span", null, "缓存读 ", React.createElement("b", { style: MONO }, String(num(data.totals.cacheReadTokens)))),
					),
					React.createElement("div", { style: sectionStyle() }, "按会话"),
					React.createElement("table", { style: tableStyle() },
						React.createElement("thead", null, React.createElement("tr", null,
							React.createElement("th", { style: thStyle(true) }, "会话"),
							React.createElement("th", { style: thStyle() }, "调用"),
							React.createElement("th", { style: thStyle() }, "输入"),
							React.createElement("th", { style: thStyle() }, "输出"),
							React.createElement("th", { style: thStyle() }, "成本 (¥)"),
						)),
						React.createElement("tbody", null,
							data.perSession.length === 0
								? React.createElement("tr", null, React.createElement("td", { colSpan: 5, style: tdStyle(true) }, "暂无会话记录"))
								: data.perSession.map(function (s) {
									return React.createElement("tr", { key: s.sessionId },
										React.createElement("td", { style: tdStyle(true) }, String(s.sessionId).slice(0, 12)),
										React.createElement("td", { style: Object.assign({}, tdStyle(), MONO) }, String(num(s.calls))),
										React.createElement("td", { style: Object.assign({}, tdStyle(), MONO) }, String(num(s.inputTokens))),
										React.createElement("td", { style: Object.assign({}, tdStyle(), MONO) }, String(num(s.outputTokens))),
										React.createElement("td", { style: Object.assign({}, tdStyle(), MONO) }, cost(s.cost)),
									)
								}),
						),
					),
					React.createElement("div", { style: sectionStyle() }, "最近调用"),
					React.createElement("table", { style: tableStyle() },
						React.createElement("thead", null, React.createElement("tr", null,
							React.createElement("th", { style: thStyle(true) }, "模型"),
							React.createElement("th", { style: thStyle() }, "输入"),
							React.createElement("th", { style: thStyle() }, "输出"),
							React.createElement("th", { style: thStyle() }, "缓存读"),
							React.createElement("th", { style: thStyle() }, "成本 (¥)"),
						)),
						React.createElement("tbody", null,
							data.recent.length === 0
								? React.createElement("tr", null, React.createElement("td", { colSpan: 5, style: tdStyle(true) }, "暂无调用记录"))
								: data.recent.map(function (e) {
									return React.createElement("tr", { key: "c" + e.seq },
										React.createElement("td", { style: tdStyle(true) }, String(e.model || "?")),
										React.createElement("td", { style: Object.assign({}, tdStyle(), MONO) }, String(num(e.usage && e.usage.inputTokens))),
										React.createElement("td", { style: Object.assign({}, tdStyle(), MONO) }, String(num(e.usage && e.usage.outputTokens))),
										React.createElement("td", { style: Object.assign({}, tdStyle(), MONO) }, String(num(e.usage && e.usage.cacheReadTokens))),
										React.createElement("td", { style: Object.assign({}, tdStyle(), MONO) }, cost(e.cost)),
									)
								}),
						),
					),
					React.createElement("div", { style: sectionStyle() }, "单价表 (每 1M tokens)"),
					React.createElement("table", { style: tableStyle() },
						React.createElement("thead", null, React.createElement("tr", null,
							React.createElement("th", { style: thStyle(true) }, "匹配"),
							React.createElement("th", { style: thStyle() }, "输入"),
							React.createElement("th", { style: thStyle() }, "输出"),
							React.createElement("th", { style: thStyle() }, "缓存读"),
							React.createElement("th", { style: thStyle() }, "缓存写"),
						)),
						React.createElement("tbody", null,
							data.prices.rows.map(function (p) {
								return React.createElement("tr", { key: p.pattern },
									React.createElement("td", { style: tdStyle(true) }, p.pattern),
									React.createElement("td", { style: Object.assign({}, tdStyle(), MONO) }, "¥" + num(p.input).toFixed(2)),
									React.createElement("td", { style: Object.assign({}, tdStyle(), MONO) }, "¥" + num(p.output).toFixed(2)),
									React.createElement("td", { style: Object.assign({}, tdStyle(), MONO) }, "¥" + num(p.cacheRead).toFixed(2)),
									React.createElement("td", { style: Object.assign({}, tdStyle(), MONO) }, "¥" + num(p.cacheWrite).toFixed(2)),
								)
							}),
						),
					),
					React.createElement("div", { style: { opacity: 0.6, fontSize: 11, marginTop: 16 } },
						"数据每 5 秒刷新; 单价可通过对话中的 billing_report 工具修改, 账单持久保存于 " + "~/.dsh/storages" + "。"
					),
				),
			)
		}

		// ── apply ─────────────────────────────────────────────────────────
		function apply(ctx) {
			var slots = ctx.get("slots")
			if (slots === undefined) return

			slots.inject("settings.section", function () {
				return slots.register(
					{ name: "settings.section", id: "token-billing", order: 25, label: "Token 计费" },
					function (props) { return React.createElement(BillingSettings, { __ctx: ctx, close: props.close }) },
				)
			})
			slots.inject("conversation.composer.dock", function () {
				return slots.register(
					{ name: "conversation.composer.dock", id: "billing", order: 1, label: "Token 计费" },
					function (props) { return React.createElement(BillingDock, { __ctx: ctx, sessionId: props.sessionId }) },
				)
			})
		}
		exports.apply = apply

		return module.exports
	}
})
