// Claude Code mod: draws the live pi-review panel in a pane.
// At session start it sets PI_REVIEW_UI=pane, so every pi-review the session's
// Bash runs writes ReviewEvent v1 lines to $TMPDIR/pi-review-ui/<runId>/events.jsonl
// with no dashboard server or browser (src/panel-ui.ts); an older CLI run with
// `--ui web` writes the same file. This module tails the newest one and folds
// it through the reducer the Pi renderer uses. ../vendor holds copies of src/
// files made by scripts/sync-claude-plugin.mjs: edit src/, then sync.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { createPanelViewState, reducePanelEvent } from '../vendor/panel-view.js'
import type { PanelReviewerView, PanelViewState } from '../vendor/panel-view.js'
import type { ReviewEvent } from '../vendor/review-events.js'
import type { FindingCluster, TokenUsage } from '../vendor/types.js'
import type { PiReviewTick } from '../types'

const PANE = 'pi-review'
const TITLE = 'pi-review'
const FRAME_MS = 125
/** Read the events file every this many frames (1 s). */
const POLL_FRAMES = 8
/** A run dir last written this long before load is someone else's old run. */
const STALE_MS = 120_000
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** The animation frame; each write redraws the pane. */
const tick = atom({ plugin: 'pi-review', key: 'tick' } as const, 0 as PiReviewTick)

type Run = { dir: string; size: number; consumed: number; view: PanelViewState; now: number; doneFrame?: number }
let run: Run | undefined
let frame = 0

/** Folds the complete lines past `consumed` into the view; a partial tail waits for the next read. */
export function foldEvents(view: PanelViewState, text: string, consumed: number) {
  const end = text.lastIndexOf('\n') + 1
  if (end <= consumed) return { view, consumed }
  for (const line of text.slice(consumed, end).split('\n')) {
    if (!line) continue
    try {
      view = reducePanelEvent(view, JSON.parse(line) as ReviewEvent)
    } catch {
      /* a malformed line is skipped, as the web dashboard does */
    }
  }
  return { view, consumed: end }
}

async function tmpRoot($: EngineInterface) {
  const tmp = (await $.env.get('TMPDIR')) ?? (await $.env.get('TMP')) ?? (await $.env.get('TEMP')) ?? '/tmp'
  return `${tmp.replace(/[\\/]+$/, '')}/pi-review-ui`
}

/** Run dirs found stale once stay stale: a finished run is never written again. */
const stale = new Set<string>()

async function newestRunDir($: EngineInterface, root: string, since: number) {
  const entries = await $.fs.list(root).catch(() => [])
  let best: { dir: string; mtimeMs: number } | undefined
  for (const entry of entries) {
    if (entry.kind !== 'dir' || stale.has(entry.name)) continue
    const dir = `${root}/${entry.name}`
    const stat = await $.fs.stat(`${dir}/events.jsonl`).catch(() => undefined)
    if (stat && stat.mtimeMs < since) stale.add(entry.name)
    else if (stat && (!best || stat.mtimeMs > best.mtimeMs)) best = { dir, mtimeMs: stat.mtimeMs }
  }
  return best?.dir
}

async function poll($: EngineInterface, root: string, since: number) {
  const dir = await newestRunDir($, root, since)
  if (dir && dir !== run?.dir) {
    run = { dir, size: -1, consumed: 0, view: createPanelViewState(), now: 0 }
    void $.ui.open({ id: PANE, title: TITLE })
  }
  if (!run) return false
  run.now = await $.clock.now()
  const stat = await $.fs.stat(`${run.dir}/events.jsonl`).catch(() => undefined)
  // The file is gone once a dashboard server exits: keep the last view.
  if (stat === undefined || stat.size === run.size) return false
  const text = await $.fs.read(`${run.dir}/events.jsonl`).catch(() => undefined)
  if (text === undefined) return false
  const wasDone = run.view.phase === 'completed'
  Object.assign(run, { size: stat.size }, foldEvents(run.view, text, text.length < run.consumed ? 0 : run.consumed))
  const meta = run.view.meta
  if (!wasDone && meta) {
    run.doneFrame = frame
    $.ui.toast(`pi-review ${verdictLabel(meta.verdict)} · ${meta.confirmedClusters.length} confirmed · ${meta.advisories.length} advisories`)
  }
  return true
}

/** Frames the results take to slide in, one finding every two frames. */
function revealFrames(view: PanelViewState) {
  return 2 * ((view.meta?.confirmedClusters.length ?? 0) + (view.meta?.advisories.length ?? 0)) + 4
}

function isAnimating() {
  if (!run || run.view.phase === 'idle') return false
  if (run.view.phase !== 'completed') return true
  return frame - (run.doneFrame ?? 0) <= revealFrames(run.view)
}

// ---------------------------------------------------------------- drawing

function verdictLabel(verdict: string) {
  return verdict.replace(/_/g, ' ').toUpperCase()
}

function tokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}

function usageText(usage?: TokenUsage) {
  if (!usage) return '—'
  const cost = typeof usage.costTotal === 'number' ? ` · $${usage.costTotal.toFixed(2)}` : ''
  return `${tokens(usage.totalTokens)} tok${cost}`
}

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

function oneLine(text: string, max = 160) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `…${flat.slice(-max)}` : flat
}

const STATUS_COLOR: Record<PanelReviewerView['status'], string> = {
  queued: 'inactive',
  running: 'warning',
  completed: 'success',
  failed: 'error',
  cancelled: 'inactive',
}

function severityColor(severity?: string) {
  if (severity === 'critical' || severity === 'high') return 'error'
  if (severity === 'medium') return 'warning'
  return 'suggestion'
}

function verdictColor(status: string) {
  return status === 'clean' ? 'success' : status === 'has_findings' ? 'error' : 'warning'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Every Bash child started from now on inherits it: pi-review then skips the web dashboard.
    await $.env.set('PI_REVIEW_UI', 'pane')
    await $.command.register({ name: 'pi-review-panel', description: 'Show the live pi-review panel pane' })
    const root = await tmpRoot($)
    const since = (await $.clock.now()) - STALE_MS
    let busy = false
    $.clock.every(FRAME_MS, () => {
      if (busy) return
      busy = true
      frame++
      const due = frame % POLL_FRAMES === 0
      void (due ? poll($, root, since) : Promise.resolve(false))
        .then(changed => (changed || isAnimating() ? update($, tick, n => n + 1) : undefined))
        .finally(() => {
          busy = false
        })
    })
    return next(e)
  })

  on('command.run', { command: 'pi-review-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: run ? 'pi-review panel opened.' : 'pi-review panel opened; it fills in when a pi-review panel run starts.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await read($, tick)
    const view = run?.view
    if (!run || !view || view.phase === 'idle') {
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold color="claude">◆ pi-review</Text>
            <Text dimColor>  waiting for a panel review</Text>
          </Text>
          <Text dimColor>Ask for a pi-review panel (--panel code-experts or --reviewers N); it shows up here live.</Text>
        </Box>
      )
    }
    const reviewers = Object.values(view.reviewers)
    const { aggregate, meta } = view
    const now = run.now
    const spin = (offset = 0) => SPIN[(frame + offset) % SPIN.length]
    const done = view.phase === 'completed'
    const phase = done ? (
      <Text bold color={meta ? verdictColor(meta.status) : 'success'}>● DONE</Text>
    ) : (
      <Text bold color={view.phase === 'aggregating' ? 'claude' : 'warning'}>
        {spin()} {view.phase === 'aggregating' ? 'AGGREGATING' : 'REVIEWING'}
      </Text>
    )

    // One segment per reviewer, coloured by its status; a running one carries a moving glint.
    const barWidth = Math.max(12, Math.min(48, (e.props.bodyColumns ?? 80) - 44))
    const seg = Math.max(2, Math.floor(barWidth / Math.max(1, reviewers.length)))
    const bar = reviewers.map((r, i) => {
      if (r.status !== 'running') {
        return <Text color={STATUS_COLOR[r.status]} dimColor={r.status === 'queued'}>{(r.status === 'queued' ? '─' : '━').repeat(seg)}</Text>
      }
      const glint = (frame + i * 3) % (seg + 4)
      const cells = Array.from({ length: seg }, (_, c) => Math.abs(c - glint) <= 1)
      return <Text>{cells.map(isLit => <Text color={isLit ? 'claude' : 'warning'} dimColor={!isLit}>━</Text>)}</Text>
    })

    const elapsed = (view.completedAt ?? now) - (view.startedAt ?? now)
    const findings = meta ? [...meta.confirmedClusters, ...meta.advisories] : []
    const shown = done ? Math.max(0, Math.floor((frame - (run.doneFrame ?? frame)) / 2)) : 0
    const findingRow = (c: FindingCluster) => (
      <Text wrap="truncate-end">
        {'  '}
        <Text color={c.confirmed ? severityColor(c.severity) : 'inactive'}>{c.confirmed ? '●' : '○'} </Text>
        <Text bold={c.confirmed} color={c.confirmed ? severityColor(c.severity) : 'inactive'}>{(c.severity ?? '—').toUpperCase().padEnd(8)}</Text>
        {c.path ? <Text color="suggestion">{c.path} </Text> : ''}
        <Text dimColor={!c.confirmed}>{c.summary}</Text>
        <Text dimColor>  {c.supportCount}/{aggregate.total}</Text>
      </Text>
    )
    const nameWidth = Math.max(...reviewers.map(r => r.reviewerId.length))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text bold color="claude">◆ pi-review</Text>
            <Text dimColor>  {view.mode ?? 'code'}{view.panelPreset ? ` · ${view.panelPreset}` : ''}</Text>
          </Text>
          <Text>
            {phase}
            <Text dimColor>  {duration(elapsed)}</Text>
          </Text>
        </Box>
        {view.target && <Text dimColor wrap="truncate-end">{oneLine(view.target, 400)}</Text>}

        <Box marginTop={1}>
          <Text wrap="truncate-end">
            {bar}
            <Text bold>  {aggregate.completed}/{aggregate.total}</Text>
            <Text dimColor> done</Text>
            {aggregate.failed > 0 && <Text color="error"> · {aggregate.failed} failed</Text>}
            <Text dimColor>  ·  {usageText(aggregate.usage)}</Text>
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={1} gap={0}>
          {reviewers.map((r, i) => {
            const icon = r.status === 'running' ? spin(i * 3) : r.status === 'completed' ? '✔' : r.status === 'failed' ? '✖' : r.status === 'cancelled' ? '⊘' : '○'
            const role = r.role.length <= 24 && r.role.toLowerCase() !== r.reviewerId.toLowerCase() ? r.role : ''
            const took = r.startedAt ? duration((r.completedAt ?? now) - r.startedAt) : ''
            const result = r.submission?.result
            return (
              <Box flexDirection="column">
                <Box flexDirection="row" justifyContent="space-between">
                  <Text wrap="truncate-end">
                    <Text color={STATUS_COLOR[r.status]}>{icon} </Text>
                    <Text bold dimColor={r.status === 'queued'}>{r.reviewerId.padEnd(nameWidth)}</Text>
                    {role && <Text> {role}</Text>}
                    <Text dimColor>  {r.model ?? 'default model'}{r.thinking ? ` · ${r.thinking}` : ''}</Text>
                  </Text>
                  <Text dimColor>
                    {r.turns ? `t${r.turns} · ` : ''}
                    {r.usage ? `${tokens(r.usage.totalTokens)} · ` : ''}
                    {took}
                  </Text>
                </Box>
                <Text wrap="truncate-end">
                  <Text dimColor>  └ </Text>
                  {r.status === 'failed' || r.status === 'cancelled' ? (
                    <Text color="error">{oneLine(r.error ?? r.status)}</Text>
                  ) : result ? (
                    <Text>
                      <Text color={result.verdict === 'approve' ? 'success' : 'error'}>{verdictLabel(result.verdict)}</Text>
                      <Text dimColor> · {result.findings.length} findings</Text>
                    </Text>
                  ) : r.activeTool ? (
                    <Text>
                      <Text color="suggestion">{r.activeTool}</Text>
                      <Text dimColor> {oneLine(r.activeToolSummary ?? '')}</Text>
                    </Text>
                  ) : r.status === 'running' ? (
                    <Text dimColor>
                      {oneLine(r.recentActivity.at(-1) ?? 'thinking')}
                      {'.'.repeat((frame >> 1) % 4)}
                    </Text>
                  ) : (
                    <Text dimColor>queued</Text>
                  )}
                </Text>
              </Box>
            )
          })}
        </Box>

        {meta && (
          <Box flexDirection="column" marginTop={1}>
            <Text wrap="truncate-end">
              <Text bold backgroundColor={verdictColor(meta.status)} color="inverseText"> {verdictLabel(meta.verdict)} </Text>
              <Text dimColor>  {meta.status.replace(/_/g, ' ')} · {meta.consensusPolicy} ≥{meta.consensusThreshold}</Text>
              <Text>  {meta.confirmedClusters.length} confirmed</Text>
              <Text dimColor> · {meta.advisories.length} advisories</Text>
            </Text>
            {findings.slice(0, shown).map(findingRow)}
          </Box>
        )}
      </Box>
    )
  })
}
