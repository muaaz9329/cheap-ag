import type { Register } from 'claude-code'

// A cheapag delegate or research call: `mcp__cheapag__…` (user scope) or the plugin's `mcp__plugin_cheapag_cheapag__…`
const CHEAPAG = /^mcp__.*cheapag__(delegate|research)$/
// The server writes each job's latest progress line here (`step 1 · turn 3 · edit src/foo.ts · 12s`)
const JOBS = '.cheapag/jobs'

export const register: Register = on => {
  const running = new Set<string>()
  let line = ''

  on('tool.call', async ($, e, next) => {
    if (!CHEAPAG.test(e.tool)) return next(e)
    // only jobs this call starts: a job folder that wasn't there before it
    const before = new Set((await $.fs.list(JOBS).catch(() => [])).map(j => j.name))
    running.add(e.tool_use_id)
    const poll = async () => {
      const jobs = (await $.fs.list(JOBS).catch(() => [])).filter(j => j.kind === 'dir' && !before.has(j.name))
      let newest = { at: 0, text: '' }
      for (const job of jobs) {
        const at = (await $.fs.stat(`${JOBS}/${job.name}/progress.txt`).catch(() => undefined))?.mtimeMs ?? 0
        if (at > newest.at) newest = { at, text: (await $.fs.read(`${JOBS}/${job.name}/progress.txt`).catch(() => '')).trim() }
      }
      if (newest.text !== line) {
        line = newest.text
        $.ui.invalidate('ui.render')
      }
    }
    const timer = $.clock.every(1000, () => void poll())
    try {
      return await next(e)
    } finally {
      timer.cancel()
      running.delete(e.tool_use_id)
      if (running.size === 0 && line) {
        line = ''
        $.ui.invalidate('ui.render')
      }
    }
  }).catch(($, e, next) => next(e)) // a broken display never blocks the call

  // the row under the running call
  on('ui.render', { component: 'ToolProgress' }, ($, e, next) =>
    running.has(e.props.tool_use_id) && line
      ? next({ ...e, props: { ...e.props, hint: `cheapag · ${line}   ${e.props.hint}` } })
      : next(e),
  )

  // the animated line, for when the row isn't drawn
  on('ui.render', { component: 'Spinner' }, ($, e, next) =>
    running.size > 0 && line ? next({ ...e, props: { ...e.props, message: `cheapag · ${line}` } }) : next(e),
  )
}
