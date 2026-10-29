// API bodies shaped as the Currents REST API returns them through the MCP tools.

export const NOW = Date.parse('2026-10-29T15:00:00.000Z')

export const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

const group = (
  groupId: string,
  tests: { total: number; passes: number; failures: number; flaky?: number; skipped?: number; pending?: number },
  instances: { overall: number; complete: number; claimed?: number },
) => ({
  groupId,
  platform: { browserName: groupId },
  durationMs: 300_000,
  specCount: instances.overall,
  instances: { overall: instances.overall, claimed: instances.claimed ?? instances.complete, complete: instances.complete, passes: 0, failures: 0 },
  tests: {
    total: tests.total,
    recorded: tests.passes + tests.failures + (tests.skipped ?? 0) + (tests.pending ?? 0),
    passes: tests.passes,
    failures: tests.failures,
    pending: tests.pending ?? 0,
    skipped: tests.skipped ?? 0,
    flaky: tests.flaky ?? 0,
    retries: 0,
  },
})

export const failedRun = {
  runId: 'run-failed-1',
  projectId: 'AbC123',
  createdAt: iso(12),
  durationMs: 400_000,
  tags: ['e2e'],
  completionState: 'COMPLETE',
  status: 'FAILED',
  meta: {
    ciBuildId: 'gha-991-1',
    commit: {
      sha: '4f2c1d9e8a7b6c5d',
      branch: 'fix-login',
      authorName: 'Ada Lovelace',
      message: 'fix: keep the redirect after sign in\n\nlonger body',
    },
    pr: { id: 'github:github.com/acme/web#42', link: 'https://github.com/acme/web/pull/42', title: 'Fix the login redirect loop', source: 'fix-login', destination: 'main' },
    framework: { name: 'playwright', version: '1.55.0' },
  },
  groups: [
    group('chromium', { total: 210, passes: 206, failures: 2, flaky: 1, pending: 2 }, { overall: 26, complete: 26 }),
    group('firefox', { total: 210, passes: 208, failures: 1, flaky: 1, pending: 1 }, { overall: 26, complete: 26 }),
  ],
}

export const runningRun = {
  ...failedRun,
  runId: 'run-running-2',
  createdAt: iso(3),
  durationMs: null,
  completionState: 'IN_PROGRESS',
  status: 'RUNNING',
  meta: { ...failedRun.meta, commit: { ...failedRun.meta.commit, sha: '9a8b7c6d5e4f3a2b' } },
  groups: [group('chromium', { total: 210, passes: 120, failures: 0 }, { overall: 26, complete: 14, claimed: 18 })],
}

export const passedPrRun = {
  ...failedRun,
  runId: 'run-pr-77',
  createdAt: iso(90),
  status: 'PASSED',
  meta: {
    ...failedRun.meta,
    commit: { ...failedRun.meta.commit, branch: 'csv-export', sha: '1111111aaaaaaa' },
    pr: { id: 'github:github.com/acme/web#77', link: 'https://github.com/acme/web/pull/77', title: 'Add CSV export', source: 'csv-export', destination: 'main' },
  },
  groups: [group('chromium', { total: 180, passes: 180, failures: 0 }, { overall: 20, complete: 20 })],
}

export const ok = (data: unknown, more: Record<string, unknown> = {}) => ({ status: 'OK', ...more, data })

export const projects = ok([
  { projectId: 'AbC123', name: 'Web E2E', createdAt: iso(100_000), defaultBranchName: 'main' },
  { projectId: 'Zzz999', name: 'Mobile', createdAt: iso(100_000) },
])

export const branchRuns = (latest: unknown) => ok([latest, failedRun], { has_more: false })

export const pullRequests = ok(
  [
    {
      pr: { id: 'github:github.com/acme/web#42', prNumber: '42', link: 'https://github.com/acme/web/pull/42', title: 'Fix the login redirect loop', source: 'fix-login', destination: 'main', repository: 'acme/web' },
      stats: { total: 2, passed: 0, failed: 1, running: 0, failing: 0, canceled: 0, timedOut: 0 },
      latestRun: failedRun,
      timelinePreview: [failedRun],
      recentRuns: [{ runId: failedRun.runId, createdAt: failedRun.createdAt, status: 'FAILED', completionState: 'COMPLETE', durationMs: 400_000, commit: { sha: '4f2c1d9', message: 'fix', authorName: 'Ada' }, failures: 3 }],
      hasMoreRuns: false,
      cursor: 'c1',
      stackedOn: null,
    },
    {
      pr: { id: 'github:github.com/acme/web#77', prNumber: '77', link: 'https://github.com/acme/web/pull/77', title: 'Add CSV export', source: 'csv-export', destination: 'main', repository: 'acme/web' },
      stats: { total: 3, passed: 2, failed: 1, running: 0, failing: 0, canceled: 0, timedOut: 0 },
      latestRun: passedPrRun,
      timelinePreview: [passedPrRun],
      recentRuns: [
        { runId: 'run-pr-77', createdAt: iso(90), status: 'PASSED', completionState: 'COMPLETE', durationMs: 300_000, commit: { sha: '1111111', message: 'csv', authorName: 'Ada' }, failures: 0 },
        { runId: 'run-pr-76', createdAt: iso(200), status: 'FAILED', completionState: 'COMPLETE', durationMs: 310_000, commit: { sha: '2222222', message: 'csv', authorName: 'Ada' }, failures: 4 },
      ],
      hasMoreRuns: false,
      cursor: 'c2',
      stackedOn: null,
    },
  ],
  { has_more: false },
)

export const runDetails = ok({
  ...failedRun,
  attachmentCounts: {},
  specs: [
    { spec: 'tests/checkout.spec.ts', groupId: 'chromium', instanceId: 'i-2', claimedAt: iso(11), completedAt: iso(9), results: { stats: { tests: 30, passes: 30, failures: 0, pending: 0, skipped: 0, flaky: 0, wallClockDuration: 61_000 } } },
    { spec: 'tests/login.spec.ts', groupId: 'chromium', instanceId: 'i-1', claimedAt: iso(11), completedAt: iso(8), results: { stats: { tests: 12, passes: 10, failures: 2, pending: 0, skipped: 0, flaky: 0, wallClockDuration: 95_000 } } },
    { spec: 'tests/profile.spec.ts', groupId: 'firefox', instanceId: 'i-3', claimedAt: iso(11), completedAt: iso(8), results: { stats: { tests: 8, passes: 8, failures: 0, pending: 0, skipped: 0, flaky: 1, wallClockDuration: 40_000 } } },
  ],
})

export const context = ok({
  level: 'run',
  runId: failedRun.runId,
  runStatus: 'FAILED',
  instances: [],
  list: [
    {
      testId: 't-1',
      instanceId: 'i-1',
      spec: 'tests/login.spec.ts',
      title: ['Login', 'redirects to the dashboard after sign in'],
      status: 'failed',
      attempt: 2,
      duration: 4_200,
      error: { message: "\u001b[31mError: expect(page).toHaveURL(expected)\u001b[39m\n\nExpected: /dashboard/\nReceived: /login\n    at stack", location: { file: 'tests/login.spec.ts', line: 41, column: 5 } },
    },
    {
      testId: 't-2',
      instanceId: 'i-3',
      spec: 'tests/profile.spec.ts',
      title: ['Profile', 'saves the avatar'],
      status: 'flaky',
      attempt: 1,
      duration: 1_800,
      error: { message: 'TimeoutError: locator.click: Timeout 5000ms exceeded.' },
    },
  ],
  count: 2,
  total: 3,
  totalFlakyTests: 2,
  nextPage: false,
})

export const OPEN_PRS = JSON.stringify([
  { number: 42, headRefName: 'fix-login', title: 'Fix the login redirect loop', isDraft: false },
  { number: 77, headRefName: 'csv-export', title: 'Add CSV export', isDraft: false },
  { number: 80, headRefName: 'docs-tweak', title: 'Tweak the docs', isDraft: true },
])
