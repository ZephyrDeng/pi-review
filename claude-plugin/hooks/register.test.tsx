import { expect, mock, test } from 'claude-code/testing'

const NOW = 10_000_000
const ROOT = '/tmp/t/pi-review-ui'
const base = { v: 1, runId: 'run-1' }
const meta = {
  verdict: 'request_changes',
  status: 'has_findings',
  consensusPolicy: 'quorum',
  consensusThreshold: 2,
  confirmedClusters: [{ id: 'C1', summary: 'Dirty reviews exit zero', severity: 'high', path: 'src/cli.ts', confirmed: true, supportCount: 2 }],
  advisories: [],
}
const lines = [
  { ...base, seq: 1, at: NOW, type: 'panel.started', target: '@src', mode: 'code', panelPreset: 'code-experts',
    reviewers: [{ reviewerId: 'r1', role: 'correctness', model: 'm/a' }, { reviewerId: 'r2', role: 'security', model: 'm/b' }] },
  { ...base, seq: 2, at: NOW, type: 'reviewer.started', reviewerId: 'r1' },
  { ...base, seq: 3, at: NOW, type: 'reviewer.tool.started', reviewerId: 'r1', tool: 'read', summary: 'src/cli.ts' },
]
const done = [{ ...base, seq: 4, at: NOW + 5000, type: 'panel.completed', meta }]

test('the pane follows the newest panel run and shows its verdict', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { TMPDIR: '/tmp/t/' })
  let text = lines.map(l => JSON.stringify(l)).join('\n') + '\n'
  on('fs.list', async (_$, e) => ({ value: e.path === ROOT ? [{ name: 'run-1', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] : [] }))
  on('fs.stat', async () => ({ value: { kind: 'file' as const, size: text.length, mtimeMs: NOW, isLink: false } }))
  on('fs.read', async () => ({ value: text }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  let opened = 0
  on('ui.open', async () => {
    opened++
    return { value: { isPlaced: true as const } }
  })

  let uiEnv: string | undefined
  on('env.set', async (_$, e) => {
    if (e.name === 'PI_REVIEW_UI') uiEnv = e.value
    return { value: undefined }
  })

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(uiEnv).toBe('pane')
  await clock.advance(1000)
  expect(opened).toBe(1)

  const props = { title: 'pi-review', isFocused: false, bodyColumns: 140, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }
  const ui = await $.ui.mount({ plugin: 'pi-review', surface: 'terminal', component: 'Pane', requestId: 'pi-review', props })
  expect(await ui.find({ text: /code-experts/ })).toBeDefined()
  expect(await ui.find({ text: /REVIEWING/ })).toBeDefined()
  expect(await ui.find({ text: /src\/cli\.ts/ })).toBeDefined()

  // A partial trailing line waits; the completed event lands on the next poll.
  text += JSON.stringify(done[0]).slice(0, 20)
  await clock.advance(1000)
  expect(await ui.find({ text: /REQUEST CHANGES/ })).toBeUndefined()
  text = text.slice(0, text.lastIndexOf('\n') + 1) + JSON.stringify(done[0]) + '\n'
  await clock.advance(1000)
  expect(await ui.find({ text: /REQUEST CHANGES/ })).toBeDefined()
  expect(await ui.find({ text: /DONE/ })).toBeDefined()
  expect(await ui.find({ text: /^\s*5s$/ })).toBeDefined()
  // Findings slide in a few frames after the verdict.
  expect(await ui.find({ text: /Dirty reviews exit zero/ })).toBeUndefined()
  await clock.advance(1000)
  expect(await ui.find({ text: /Dirty reviews exit zero/ })).toBeDefined()
  await ui.unmount()
})
