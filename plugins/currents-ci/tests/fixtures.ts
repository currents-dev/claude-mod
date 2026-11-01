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

/** The same commit as `failedRun`, built again: its flaky test passed on the retry. */
export const rerunRun = {
  ...failedRun,
  runId: 'run-failed-0',
  createdAt: iso(30),
  durationMs: 330_000,
  status: 'PASSED',
  meta: { ...failedRun.meta, ciBuildId: 'gha-991-2' },
  groups: [group('chromium', { total: 210, passes: 210, failures: 0, flaky: 2 }, { overall: 26, complete: 26 })],
}

/** An earlier build on the branch, of an earlier commit, by someone else. */
export const olderRun = {
  ...failedRun,
  runId: 'run-fix-0',
  createdAt: iso(300),
  durationMs: 310_000,
  meta: {
    ...failedRun.meta,
    ciBuildId: 'gha-980-1',
    commit: { sha: '7e6d5c4b3a291807', branch: 'fix-login', authorName: 'Grace Hopper', message: 'wip: redirect' },
  },
  groups: [group('chromium', { total: 210, passes: 206, failures: 4 }, { overall: 26, complete: 26 })],
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

/** The default branch's newest run, green: the baseline the branch's failures are compared with. */
export const mainRun = {
  ...passedPrRun,
  runId: 'run-main-9',
  meta: { ...passedPrRun.meta, pr: null, commit: { ...passedPrRun.meta.commit, branch: 'main', message: 'chore: release' } },
}

/** The default branch's newest run when it fails the test the branch fails too. */
export const mainFailedRun = {
  ...mainRun,
  runId: 'run-main-8',
  status: 'FAILED',
  groups: [group('chromium', { total: 180, passes: 179, failures: 1, flaky: 1 }, { overall: 20, complete: 20 })],
}

export const ok = (data: unknown, more: Record<string, unknown> = {}) => ({ status: 'OK', ...more, data })

export const projects = ok([
  { projectId: 'AbC123', name: 'Web E2E', createdAt: iso(100_000), defaultBranchName: 'main' },
  { projectId: 'Zzz999', name: 'Mobile', createdAt: iso(100_000) },
])

/** The branch's runs as `currents-get-runs` lists them, newest first, with `latest` the newest. */
export const branchRuns = (latest: unknown) => {
  const newest = (latest as { runId: string }).runId
  return ok([latest, ...[failedRun, rerunRun, olderRun].filter(run => run.runId !== newest)], { has_more: false })
}

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

/** `currents-get-context` for a run whose only problem is a test that passed on a retry. */
export const flakyContext = ok({
  level: 'run',
  runId: rerunRun.runId,
  runStatus: 'PASSED',
  instances: [],
  list: [
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
  count: 1,
  total: 0,
  totalFlakyTests: 1,
  nextPage: false,
})

/** `currents-get-tests-performance` ordered by flakiness: the Tests tab's flakiest rows for the branch. */
export const flakiestTests = ok({
  list: [
    {
      title: 'saves the avatar',
      spec: 'tests/profile.spec.ts',
      metrics: { executions: 8, failures: 1, flaky: 1, flakinessRate: 0.125, avgDurationMs: 1_800 },
      lastSeen: iso(11),
    },
  ],
  count: 1,
  total: 1,
  nextPage: false,
})

/** The same endpoint ordered by duration: the branch's slowest rows. */
export const slowestTests = ok({
  list: [
    {
      title: 'exports every order as CSV',
      spec: 'tests/checkout.spec.ts',
      metrics: { executions: 6, failures: 0, flaky: 0, flakinessRate: 0, avgDurationMs: 95_000 },
      lastSeen: iso(40),
    },
  ],
  count: 1,
  total: 1,
  nextPage: false,
})

/** `gh pr view --json number,title,url,isDraft,reviewDecision,baseRefName`, for the checked-out branch. */
export const PR_VIEW = JSON.stringify({
  number: 42,
  title: 'Fix the login redirect loop',
  url: 'https://github.com/acme/web/pull/42',
  isDraft: false,
  reviewDecision: 'APPROVED',
  baseRefName: 'main',
})

export const PR_VIEW_DRAFT = JSON.stringify({
  number: 42,
  title: 'Fix the login redirect loop',
  url: 'https://github.com/acme/web/pull/42',
  isDraft: true,
  reviewDecision: '',
  baseRefName: 'main',
})

/** `currents-create-share-link`'s reply for a report. */
export const shareLink = {
  purpose: 'report',
  url: 'https://currents.dev/s/9f1c2b7e',
  pageUrl: 'https://app.currents.dev/shared/9f1c2b7e',
  expiresAt: iso(-7 * 24 * 60),
}
