// 归档:pkg-5 客户端半(人民币面板,最终修复版)。
// 修复 pkg-4:字段改为 cost(与宿主一致),并加 num()/cost() 数值兜底,渲染不再崩溃。
// 宿主半与 pkg-4 完全相同。此后动态插件使命结束,由持久版(仓库根目录)接管。
return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    styles.insert(`
      .tbill { max-width: 640px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, transparent); padding: 10px 12px; font-size: 12px; color: var(--dsw-alias-label-primary, inherit); }
      .tbill-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
      .tbill-title { font-weight: 600; margin-right: auto; }
      .tbill-btn { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.15)); color: inherit; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35)); border-radius: 6px; padding: 2px 10px; cursor: pointer; font-size: 12px; }
      .tbill-stats { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 6px 0; }
      .tbill-mono, .tbill-stat b { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .tbill-section { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .7; margin: 10px 0 4px; }
      .tbill table { width: 100%; border-collapse: collapse; }
      .tbill th { text-align: right; font-weight: 500; opacity: .7; padding: 2px 6px; }
      .tbill th:first-child, .tbill td:first-child { text-align: left; padding-left: 0; }
      .tbill td { text-align: right; padding: 2px 6px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22)); }
      .tbill-current td { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.09)); }
      .tbill-error { color: var(--dsw-alias-state-error-primary, #e5484d); }
      .tbill-note { opacity: .6; font-size: 11px; margin-top: 10px; }
    `)

    function BillingPanel(props) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [armed, setArmed] = React.useState(false)

      function refresh() {
        host.call('summary').then((d) => { setData(d); setError(null) }).catch((err) => setError(String(err && err.message ? err.message : err)))
      }
      function resetMeter() {
        if (!armed) {
          setArmed(true)
          ctx.timeout(() => setArmed(false), 3000)
          return
        }
        setArmed(false)
        host.call('reset').then((d) => { setData(d); setError(null) }).catch((err) => setError(String(err && err.message ? err.message : err)))
      }

      React.useEffect(() => {
        refresh()
        return ctx.interval(() => refresh(), 5000)
      }, [])

      const t = data === null ? null : data.totals
      const current = props.sessionId

      function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0 }
      function cost(v) { return '¥' + num(v).toFixed(4) }

      function statRow(label, value) {
        return React.createElement('span', { className: 'tbill-stat', key: label }, label + ' ', React.createElement('b', null, value))
      }

      return React.createElement('div', { className: 'tbill' },
        React.createElement('div', { className: 'tbill-head' },
          React.createElement('span', { className: 'tbill-title' }, '🧾 Token 计费 (¥)'),
          React.createElement('button', { className: 'tbill-btn', onClick: refresh }, '刷新'),
          React.createElement('button', { className: 'tbill-btn', onClick: resetMeter }, armed ? '确认清零?' : '清零'),
        ),
        error !== null ? React.createElement('div', { className: 'tbill-error' }, error) : null,
        t === null
          ? React.createElement('div', null, '加载中…')
          : React.createElement('div', null,
              React.createElement('div', { className: 'tbill-stats' },
                statRow('调用', String(num(t.calls))),
                statRow('成本', cost(t.cost)),
                statRow('输入', String(num(t.inputTokens))),
                statRow('输出', String(num(t.outputTokens))),
                statRow('缓存读', String(num(t.cacheReadTokens))),
                statRow('缓存写', String(num(t.cacheWriteTokens))),
              ),
              React.createElement('div', { className: 'tbill-section' }, '按会话'),
              React.createElement('table', null,
                React.createElement('thead', null, React.createElement('tr', null,
                  React.createElement('th', null, '会话'),
                  React.createElement('th', null, '调用'),
                  React.createElement('th', null, '成本 (¥)'),
                )),
                React.createElement('tbody', null,
                  data.sessions.length === 0
                    ? React.createElement('tr', null, React.createElement('td', { colSpan: 3 }, '暂无会话记录'))
                    : data.sessions.map((s) => React.createElement('tr', { key: s.sessionId, className: s.sessionId === current ? 'tbill-current' : undefined },
                        React.createElement('td', null, String(s.sessionId).slice(0, 10) + (s.sessionId === current ? ' ⬅' : '')),
                        React.createElement('td', { className: 'tbill-mono' }, String(num(s.calls))),
                        React.createElement('td', { className: 'tbill-mono' }, cost(s.cost)),
                      )),
                ),
              ),
              React.createElement('div', { className: 'tbill-section' }, '最近调用'),
              React.createElement('table', null,
                React.createElement('thead', null, React.createElement('tr', null,
                  React.createElement('th', null, '模型'),
                  React.createElement('th', null, '输入'),
                  React.createElement('th', null, '输出'),
                  React.createElement('th', null, '成本 (¥)'),
                )),
                React.createElement('tbody', null,
                  data.recent.length === 0
                    ? React.createElement('tr', null, React.createElement('td', { colSpan: 4 }, '暂无调用记录'))
                    : data.recent.map((e) => React.createElement('tr', { key: String(e.seq) },
                        React.createElement('td', null, String(e.model || '?')),
                        React.createElement('td', { className: 'tbill-mono' }, String(num(e.usage && e.usage.inputTokens))),
                        React.createElement('td', { className: 'tbill-mono' }, String(num(e.usage && e.usage.outputTokens))),
                        React.createElement('td', { className: 'tbill-mono' }, cost(e.cost)),
                      )),
                ),
              ),
              React.createElement('div', { className: 'tbill-section' }, '单价表 (¥ / 1M tokens)'),
              React.createElement('table', null,
                React.createElement('thead', null, React.createElement('tr', null,
                  React.createElement('th', null, '匹配'),
                  React.createElement('th', null, '输入'),
                  React.createElement('th', null, '输出'),
                  React.createElement('th', null, '缓存读'),
                  React.createElement('th', null, '缓存写'),
                )),
                React.createElement('tbody', null,
                  data.prices.map((p) => React.createElement('tr', { key: p.pattern },
                    React.createElement('td', null, p.pattern),
                    React.createElement('td', { className: 'tbill-mono' }, '¥' + num(p.input).toFixed(2)),
                    React.createElement('td', { className: 'tbill-mono' }, '¥' + num(p.output).toFixed(2)),
                    React.createElement('td', { className: 'tbill-mono' }, '¥' + num(p.cacheRead).toFixed(2)),
                    React.createElement('td', { className: 'tbill-mono' }, '¥' + num(p.cacheWrite).toFixed(2)),
                  )),
                ),
              ),
              React.createElement('div', { className: 'tbill-note' }, '本会话临时计费面板(人民币默认价); 重启 dsh web 后由持久化版本接管。'),
            ),
      )
    }

    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      (props) => React.createElement(BillingPanel, { sessionId: props.sessionId }),
    ))
  },
}
