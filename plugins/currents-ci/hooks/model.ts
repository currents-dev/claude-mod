// Pure helpers: the Currents API's JSON in, the mod's shapes and words out.

import type {
  CompletionState,
  FailedTest,
  Run,
  RunDetail,
  RunStatus,
  SpecRow,
  TestCounts,
  TestStat,
  Verdict,
} from '../types'

export const DASHBOARD = 'https://app.currents.dev'

type Json = Record<string, unknown>

const obj = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const numOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const STATUSES: readonly RunStatus[] = ['PASSED', 'FAILED', 'RUNNING', 'FAILING']
const STATES: readonly CompletionState[] = ['COMPLETE', 'IN_PROGRESS', 'CANCELED', 'TIMEOUT']

const status = (value: unknown): RunStatus =>
  STATUSES.includes(value as RunStatus) ? (value as RunStatus) : 'RUNNING'
const completion = (value: unknown): CompletionState =>
  STATES.includes(value as CompletionState) ? (value as CompletionState) : 'IN_PROGRESS'

const firstLine = (text: string | null) => (text === null ? null : (text.split('\n')[0] ?? '').trim() || null)

/** `github:github.com/org/repo#42` → `42`. */
export const prNumberOf = (id: string | null): string | null => {
  if (id === null) return null
  const found = /#(\d+)$/.exec(id) ?? /^(\d+)$/.exec(id)
  return found?.[1] ?? null
}

/** The dashboard's title chain: PR title, `Pull Request #N`, commit message, `Run #<build>`. */
const titleOf = (meta: Json, runId: string): string => {
  const pr = obj(meta.pr)
  const commit = obj(meta.commit)
  const prNumber = prNumberOf(str(pr.id))
  return (
    firstLine(str(meta.title)) ??
    firstLine(str(pr.title)) ??
    (prNumber ? `Pull Request #${prNumber}` : null) ??
    firstLine(str(commit.message)) ??
    `Run #${str(meta.ciBuildId) ?? runId.slice(0, 8)}`
  )
}

/** One run from `currents-get-runs`, or the run a `currents-get-run-details` reply describes. */
export const toRun = (raw: unknown): Run => {
  const run = obj(raw)
  const meta = obj(run.meta)
  const commit = obj(meta.commit)
  const pr = obj(meta.pr)
  const framework = obj(meta.framework)
  const groups = arr(run.groups).map(obj)
  const runId = str(run.runId) ?? ''

  const tests: TestCounts = { total: 0, recorded: 0, passes: 0, failures: 0, skipped: 0, pending: 0, flaky: 0 }
  const specs = { total: 0, complete: 0, claimed: 0 }
  for (const group of groups) {
    const t = obj(group.tests)
    const i = obj(group.instances)
    tests.total += num(t.total ?? t.tests)
    tests.recorded += num(t.recorded ?? t.overall)
    tests.passes += num(t.passes)
    tests.failures += num(t.failures)
    tests.skipped += num(t.skipped)
    tests.pending += num(t.pending)
    tests.flaky += num(t.flaky)
    specs.total += num(i.overall)
    specs.complete += num(i.complete)
    specs.claimed += num(i.claimed)
  }
  tests.recorded = Math.max(tests.recorded, tests.passes + tests.failures + tests.skipped + tests.pending)
  tests.total = Math.max(tests.total, tests.recorded)

  const frameworkName = str(framework.name ?? framework.type)
  const prId = str(pr.id)
  return {
    runId,
    projectId: str(run.projectId) ?? '',
    createdAt: str(run.createdAt) ?? new Date(0).toISOString(),
    durationMs: numOrNull(run.durationMs),
    status: status(run.status),
    completionState: completion(run.completionState),
    title: titleOf(meta, runId),
    branch: str(commit.branch),
    sha: str(commit.sha),
    author: str(commit.authorName),
    ciBuildId: str(meta.ciBuildId),
    prNumber: prNumberOf(prId),
    prLink: str(pr.link),
    prBase: str(pr.destination),
    framework: frameworkName === null ? null : [frameworkName, str(framework.version)].filter(Boolean).join(' '),
    tags: arr(run.tags).filter((tag): tag is string => typeof tag === 'string'),
    groups: groups.length,
    tests,
    specs,
  }
}

const objOrNull = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null

const specState = (spec: Json): SpecRow['state'] => {
  const results = objOrNull(spec.results)
  if (results === null) return str(spec.claimedAt) ? 'running' : 'queued'
  const stats = obj(results.stats)
  if (num(stats.failures) + num(stats.skipped) > 0) return 'failed'
  if (num(stats.flaky) + num(results.flaky) > 0) return 'flaky'
  return str(spec.completedAt) || num(stats.tests) > 0 ? 'passed' : 'running'
}

const SPEC_ORDER: Record<SpecRow['state'], number> = { failed: 0, running: 1, flaky: 2, queued: 3, passed: 4 }

const toSpecRow = (raw: unknown): SpecRow => {
  const spec = obj(raw)
  const stats = obj(obj(spec.results).stats)
  return {
    instanceId: str(spec.instanceId) ?? '',
    spec: str(spec.spec) ?? 'unknown spec',
    group: str(spec.groupId),
    state: specState(spec),
    tests: num(stats.tests ?? stats.overall),
    passes: num(stats.passes),
    failures: num(stats.failures) + num(stats.skipped),
    flaky: num(stats.flaky),
    durationMs: numOrNull(stats.wallClockDuration ?? stats.duration),
  }
}

const errorLine = (error: Json): string | null => {
  const message = str(error.message)
  if (message === null) return null
  // Strip terminal colors and keep the first lines, which carry the assertion.
  const clean = message.replace(/\u001b\[[0-9;]*m/g, '').trim()
  return clean.split('\n').filter(line => line.trim() !== '').slice(0, 3).join('\n')
}

const locationOf = (error: Json): string | null => {
  const location = obj(error.location)
  const file = str(location.file)
  if (file === null) return null
  const line = numOrNull(location.line)
  return line === null ? file : `${file}:${line}`
}

/** `currents-get-context` at run level: the deduplicated failed (and flaky) tests. */
export const toFailedTests = (raw: unknown): { failed: FailedTest[]; failedTotal: number; flakyTotal: number } => {
  const data = obj(obj(raw).data ?? raw)
  const failed = arr(data.list).map((item, index): FailedTest => {
    const test = obj(item)
    const error = obj(test.error)
    const testId = str(test.testId) ?? `test-${index}`
    return {
      key: `${testId}:${str(test.instanceId) ?? index}`,
      testId,
      instanceId: str(test.instanceId),
      spec: str(test.spec) ?? '',
      title: arr(test.title).filter((part): part is string => typeof part === 'string'),
      isFlaky: test.status === 'flaky',
      error: errorLine(error),
      location: locationOf(error),
      durationMs: numOrNull(test.duration),
    }
  })
  return { failed, failedTotal: num(data.total), flakyTotal: num(data.totalFlakyTests) }
}

/** A run's drawer detail from `currents-get-run-details` and, when it has failures, its context. */
export const toDetail = (runRaw: unknown, contextRaw: unknown): RunDetail => {
  const body = obj(runRaw)
  const run = obj(body.data ?? body)
  const specs = arr(run.specs).map(toSpecRow)
  specs.sort((a, b) => SPEC_ORDER[a.state] - SPEC_ORDER[b.state] || (b.durationMs ?? 0) - (a.durationMs ?? 0))
  const groups = [...new Set(arr(run.groups).map(group => str(obj(group).groupId)).filter((g): g is string => g !== null))]
  const context = contextRaw === null ? { failed: [], failedTotal: 0, flakyTotal: 0 } : toFailedTests(contextRaw)
  return {
    runId: str(run.runId) ?? '',
    isFinal: completion(run.completionState) !== 'IN_PROGRESS',
    specs,
    groups,
    ...context,
    error: null,
  }
}

/** One test's row from `currents-get-tests-performance`: the Test Explorer's rows, for the branch. */
export const toTestStats = (raw: unknown): TestStat[] =>
  arr(obj(obj(raw).data ?? raw).list).map((item): TestStat => {
    const test = obj(item)
    const metrics = obj(test.metrics)
    return {
      title: str(test.title) ?? 'untitled test',
      spec: str(test.spec) ?? '',
      executions: num(metrics.executions),
      failures: num(metrics.failures),
      flaky: num(metrics.flaky),
      flakinessRate: num(metrics.flakinessRate),
      avgDurationMs: numOrNull(metrics.avgDurationMs),
      lastSeen: str(test.lastSeen),
    }
  })

/** The list a paginated endpoint answers (`{ status, has_more, data }`), or the array itself. */
export const listOf = (body: unknown): unknown[] => (Array.isArray(body) ? body : arr(obj(body).data))

// ---- Status and words ----

export const verdictOf = (run: Pick<Run, 'status' | 'completionState'>): Verdict => {
  if (run.completionState === 'CANCELED') return 'cancelled'
  if (run.completionState === 'TIMEOUT') return 'timedout'
  if (run.completionState === 'IN_PROGRESS') return run.status === 'FAILING' ? 'failing' : 'running'
  return run.status === 'FAILED' ? 'failed' : 'passed'
}

export const isActive = (run: Pick<Run, 'completionState'>) => run.completionState === 'IN_PROGRESS'

export const VERDICT: Record<Verdict, { label: string; glyph: string; color: string; hex: string }> = {
  passed: { label: 'Passed', glyph: '✓', color: 'success', hex: '#5dca7a' },
  failed: { label: 'Failed', glyph: '✗', color: 'error', hex: '#ff5671' },
  running: { label: 'Running', glyph: '●', color: 'suggestion', hex: '#59a5fa' },
  failing: { label: 'Failing', glyph: '●', color: 'error', hex: '#ff5671' },
  cancelled: { label: 'Cancelled', glyph: '⊘', color: 'inactive', hex: '#9aa0a6' },
  timedout: { label: 'Timed out', glyph: '◷', color: 'warning', hex: '#f9a800' },
}

/** The dashboard's counter colors. */
export const COUNTER = {
  passed: { label: 'Passed', glyph: '✓', color: 'success', hex: '#5dca7a' },
  failed: { label: 'Failed', glyph: '✗', color: 'error', hex: '#ff5671' },
  interrupted: { label: 'Interrupted', glyph: '!', color: 'warning', hex: '#f9a800' },
  ignored: { label: 'Ignored', glyph: '○', color: 'inactive', hex: '#9aa0a6' },
  flaky: { label: 'Flaky', glyph: '≈', color: '#d770ff', hex: '#d770ff' },
  running: { label: 'Running', glyph: '●', color: 'suggestion', hex: '#59a5fa' },
} as const

/** Failures as the PR comment counts them: failed plus interrupted. */
export const failedCount = (tests: TestCounts) => tests.failures + tests.skipped

/** Passed ÷ (passed + failed + interrupted), as the dashboard's pass rate. */
export const passRate = (tests: TestCounts): number | null => {
  const reported = tests.passes + tests.failures + tests.skipped
  return reported === 0 ? null : tests.passes / reported
}

/** What the PR comment's headline says after its icon. */
export const outcomeSummary = (run: Run): string => {
  const verdict = verdictOf(run)
  const flaky = run.tests.flaky > 0 ? `${run.tests.flaky} flaky` : null
  const failed = failedCount(run.tests)
  switch (verdict) {
    case 'running':
      return 'Running'
    case 'failing':
      return `Failing · ${failed} failed`
    case 'cancelled':
      return 'Cancelled'
    case 'timedout':
      return 'Timed out'
    case 'failed':
      return [`${failed} failed`, flaky].filter(Boolean).join(', ')
    case 'passed':
      return flaky ? `Passed, ${flaky}` : 'Passed'
  }
}

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** `6m 40s`, `1h 2m`, `12s`. */
export const duration = (ms: number | null): string => {
  if (ms === null || ms < 0) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** `just now`, `4m ago`, `2h ago`, `3d ago`. */
export const ago = (iso: string | number, now: number): string => {
  const at = typeof iso === 'number' ? iso : Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** A finished run's own duration; a running one's time since it was created. */
export const elapsed = (run: Run, now: number): number | null =>
  isActive(run) ? Math.max(0, now - Date.parse(run.createdAt)) : run.durationMs

export const shortSha = (sha: string | null) => (sha === null ? null : sha.slice(0, 7))

export const progressOf = (run: Run): number | null => {
  if (run.specs.total > 0) return run.specs.complete / run.specs.total
  if (run.tests.total > 0) return run.tests.recorded / run.tests.total
  return null
}

/** Trims `text` to `width` columns with an ellipsis. */
export const clip = (text: string, width: number): string =>
  width <= 0 ? '' : text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`

/** A test's identity across runs: its spec and title path. Test ids change between runs of a project; titles do not. */
export const testKeyOf = (test: Pick<FailedTest, 'spec' | 'title'>): string => `${test.spec}|${test.title.join(' › ')}`

/** The failing tests of a run that its baseline run (the default branch's) does not fail too; null until the baseline is known. */
export const newFailures = (detail: RunDetail, baseline: RunDetail | undefined): FailedTest[] | null => {
  if (baseline === undefined || baseline.error !== null) return null
  const onBaseline = new Set(baseline.failed.map(testKeyOf))
  return detail.failed.filter(test => !test.isFlaky && !onBaseline.has(testKeyOf(test)))
}

// ---- Links ----

export const runUrl = (runId: string, tab?: 'errors' | 'specs' | 'progress') =>
  `${DASHBOARD}/run/${encodeURIComponent(runId)}${tab ? `/${tab}` : ''}`

export const failedTestsUrl = (runId: string) =>
  `${DASHBOARD}/run/${encodeURIComponent(runId)}?outcome=failed&lifecycle_off=queued_running`

export const testUrl = (runId: string, test: Pick<FailedTest, 'testId' | 'instanceId'>) =>
  test.instanceId === null
    ? runUrl(runId)
    : `${DASHBOARD}/run/${encodeURIComponent(runId)}?testId=${encodeURIComponent(test.testId)}&instanceId=${encodeURIComponent(test.instanceId)}`

export const branchRunsUrl = (projectId: string, branch: string) =>
  `${DASHBOARD}/projects/${encodeURIComponent(projectId)}/runs?branch=${encodeURIComponent(branch)}`

// ---- The prompts "Fix with Claude" and the Tests tab draft ----

const DETAIL_ITEMS = 8

/** One failing or flaky test as the prompt lists it: its path, where, and the first lines of its error. */
const testLines = (test: FailedTest, index: number): string[] => {
  const lines = [`${index + 1}. ${[test.spec, ...test.title].filter(Boolean).join(' › ')}`]
  if (test.location) lines.push(`   at ${test.location}`)
  if (test.error) lines.push(...test.error.split('\n').map(line => `   ${line}`))
  return lines
}

/**
 * The prompt the run's Fix with Claude button drafts. `fresh` is the failures
 * this branch alone has (null when the default branch's run is not known) and
 * `baseline` the default branch's name.
 */
export const fixPrompt = (
  run: Run,
  detail: RunDetail | undefined,
  fresh: FailedTest[] | null,
  baseline: string | null,
): string => {
  const failed = failedCount(run.tests)
  const flaky = run.tests.flaky
  const failing = detail?.failed.filter(test => !test.isFlaky) ?? []
  const flakyTests = detail?.failed.filter(test => test.isFlaky) ?? []
  const lines = [
    `The Currents run for ${run.branch ? `branch \`${run.branch}\`` : 'this branch'} ${
      isActive(run) ? 'is failing' : run.status === 'PASSED' ? 'passed' : 'failed'
    }: ${failed > 0 ? plural(failed, 'failed test') : 'no failed tests'}${flaky > 0 ? `, ${flaky} flaky` : ''} (${run.title}).`,
    `Run: ${runUrl(run.runId)} (run_id \`${run.runId}\`)`,
  ]
  if (fresh && baseline && failing.length > 0) {
    lines.push(
      fresh.length === 0
        ? `Every failing test also fails on ${baseline}.`
        : fresh.length === failing.length
          ? `None of the failing tests fail on ${baseline}: all are new on this branch.`
          : `${fresh.length} of the ${failing.length} failing tests are new on this branch; the others also fail on ${baseline}.`,
    )
  }
  if (failing.length > 0) {
    lines.push('', 'Failed tests:')
    failing.slice(0, DETAIL_ITEMS).forEach((test, index) => lines.push(...testLines(test, index)))
    if (detail && detail.failedTotal > Math.min(failing.length, DETAIL_ITEMS)) {
      lines.push(`…and ${detail.failedTotal - Math.min(failing.length, DETAIL_ITEMS)} more.`)
    }
  }
  if (flakyTests.length > 0) {
    lines.push('', 'Flaky tests (they passed on a retry):')
    flakyTests.slice(0, DETAIL_ITEMS).forEach((test, index) => lines.push(...testLines(test, index)))
  }
  lines.push(
    '',
    'Get the full errors, steps and traces with the Currents MCP tools (currents-get-context with this run_id), find the root cause in this repository, and fix it. Flaky tests usually need a wait, a shared state or an ordering fix. Tell me if a failure looks unrelated to this branch.',
  )
  return lines.join('\n')
}

/** The prompt the Tests tab drafts for the branch's flaky or slow tests. */
export const testsPrompt = (branch: string, tests: TestStat[], sort: 'flakiness' | 'duration', days: number): string => {
  const lines = [
    sort === 'flakiness'
      ? `These tests on branch \`${branch}\` were flaky in the last ${days} days:`
      : `These are the slowest tests on branch \`${branch}\` over the last ${days} days:`,
    '',
  ]
  tests.slice(0, DETAIL_ITEMS).forEach((test, index) => {
    const stat =
      sort === 'flakiness'
        ? `${(test.flakinessRate * 100).toFixed(1)}% flaky over ${plural(test.executions, 'execution')}`
        : `avg ${duration(test.avgDurationMs)} over ${plural(test.executions, 'execution')}`
    lines.push(`${index + 1}. ${[test.spec, test.title].filter(Boolean).join(' › ')} (${stat})`)
  })
  lines.push(
    '',
    `Find out why each one ${sort === 'flakiness' ? 'flakes' : 'is slow'} in this repository, and fix it. The Currents MCP tools have each test's history (currents-get-test-results).`,
  )
  return lines.join('\n')
}
