import { describe, expect, test } from 'claude-code/testing'

import { allowRules, classify, savedReply } from '../hooks/currents'
import {
  ago,
  duration,
  failedCount,
  fixPrompt,
  listOf,
  newFailures,
  outcomeSummary,
  passRate,
  progressOf,
  testKeyOf,
  testsPrompt,
  toDetail,
  toRun,
  toTestStats,
  verdictOf,
} from '../hooks/model'
import { mostRecent, slugOf } from '../hooks/repo'
import { fit } from '../hooks/views'
import type { FailedTest, RunDetail } from '../types'
import {
  NOW,
  context,
  failedRun,
  flakiestTests,
  flakyContext,
  iso,
  rerunRun,
  runDetails,
  runningRun,
  slowestTests,
} from './fixtures'

/** A failing test of the branch's login spec, as the run's details list it. */
const failedTest = (title: string[]): FailedTest => ({
  key: `${title.join('-')}:i-1`,
  testId: title.join('-'),
  instanceId: 'i-1',
  spec: 'tests/login.spec.ts',
  title,
  isFlaky: false,
  error: 'Error: expect(page).toHaveURL(expected)',
  location: null,
  durationMs: null,
})

describe('runs', () => {
  test('sums the groups and titles the run as the dashboard does', async () => {
    const run = toRun(failedRun)
    expect(run.title).toBe('Fix the login redirect loop')
    expect(run.tests).toEqual({ total: 420, recorded: 420, passes: 414, failures: 3, skipped: 0, pending: 3, flaky: 2 })
    expect(run.specs).toEqual({ total: 52, complete: 52, claimed: 52 })
    expect(run.prNumber).toBe('42')
    expect(run.framework).toBe('playwright 1.55.0')
    expect(verdictOf(run)).toBe('failed')
    expect(failedCount(run.tests)).toBe(3)
    expect(outcomeSummary(run)).toBe('3 failed, 2 flaky')
    expect((passRate(run.tests) ?? 0).toFixed(4)).toBe((414 / 417).toFixed(4))
  })

  test('falls back to the commit message, then the CI build, for a title', async () => {
    const noPr = toRun({ ...failedRun, meta: { ...failedRun.meta, pr: null } })
    expect(noPr.title).toBe('fix: keep the redirect after sign in')
    const bare = toRun({ ...failedRun, meta: { ciBuildId: 'b-7' } })
    expect(bare.title).toBe('Run #b-7')
  })

  test('reads a run in progress', async () => {
    const run = toRun(runningRun)
    expect(verdictOf(run)).toBe('running')
    expect((progressOf(run) ?? 0).toFixed(4)).toBe((14 / 26).toFixed(4))
    expect(outcomeSummary(run)).toBe('Running')
    expect(verdictOf({ status: 'FAILING', completionState: 'IN_PROGRESS' })).toBe('failing')
    expect(verdictOf({ status: 'PASSED', completionState: 'CANCELED' })).toBe('cancelled')
    expect(verdictOf({ status: 'FAILED', completionState: 'TIMEOUT' })).toBe('timedout')
  })

  test('survives a body with missing fields', async () => {
    const run = toRun({ runId: 'r', groups: [{}], meta: null })
    expect(run.tests.total).toBe(0)
    expect(run.title).toBe('Run #r')
    expect(listOf({ status: 'OK' })).toEqual([])
    expect(listOf([1, 2])).toEqual([1, 2])
  })
})

describe('details and prompts', () => {
  test('orders spec files failures first and keeps the first lines of each error', async () => {
    const detail = toDetail(runDetails, context)
    expect(detail.specs.map(spec => spec.state)).toEqual(['failed', 'flaky', 'passed'])
    expect(detail.groups).toEqual(['chromium', 'firefox'])
    expect(detail.failedTotal).toBe(3)
    expect(detail.flakyTotal).toBe(2)
    expect(detail.failed[0]?.error).toBe('Error: expect(page).toHaveURL(expected)\nExpected: /dashboard/\nReceived: /login')
    expect(detail.failed[0]?.location).toBe('tests/login.spec.ts:41')
    expect(detail.failed[1]?.isFlaky).toBe(true)
    expect(detail.isFinal).toBe(true)
  })

  test('reads the tests the Tests tab lists, with their flakiness and duration', async () => {
    const [flaky] = toTestStats(flakiestTests)
    expect(flaky).toEqual({
      title: 'saves the avatar',
      spec: 'tests/profile.spec.ts',
      executions: 8,
      failures: 1,
      flaky: 1,
      flakinessRate: 0.125,
      avgDurationMs: 1_800,
      lastSeen: iso(11),
    })
    expect(toTestStats({ status: 'OK' })).toEqual([])
  })

  test('drafts a fix prompt that names the run and its failures', async () => {
    const run = toRun(failedRun)
    const detail = toDetail(runDetails, context)
    const prompt = fixPrompt(run, detail, newFailures(detail, toDetail(runDetails, null)), 'main')
    expect(prompt).toContain('branch `fix-login` failed: 3 failed tests, 2 flaky')
    expect(prompt).toContain('https://app.currents.dev/run/run-failed-1')
    expect(prompt).toContain('tests/login.spec.ts › Login › redirects to the dashboard after sign in')
    expect(prompt).toContain('at tests/login.spec.ts:41')
    expect(prompt).toContain('None of the failing tests fail on main: all are new on this branch.')
    // The flaky test is named in its own section, not among the failures.
    expect(prompt).toContain('Flaky tests (they passed on a retry):\n1. tests/profile.spec.ts › Profile › saves the avatar')
    expect(prompt.split('Flaky tests')[0]).not.toContain('saves the avatar')
  })

  test('a fix prompt says how many of the failing tests are new on the branch', async () => {
    const run = toRun(failedRun)
    const login = failedTest(['Login', 'redirects to the dashboard after sign in'])
    const logout = failedTest(['Login', 'logs out'])
    const branch: RunDetail = { ...toDetail(runDetails, null), failed: [login, logout], failedTotal: 2 }
    const onMain = (failed: FailedTest[]): RunDetail => ({ ...toDetail(runDetails, null), failed, failedTotal: failed.length })
    const draft = (main: RunDetail) => fixPrompt(run, branch, newFailures(branch, main), 'main')
    expect(draft(onMain([]))).toContain('None of the failing tests fail on main: all are new on this branch.')
    expect(draft(onMain([login, logout]))).toContain('Every failing test also fails on main.')
    expect(draft(onMain([login]))).toContain('1 of the 2 failing tests are new on this branch; the others also fail on main.')
  })

  test('a fix prompt for a run whose only problems are flaky tests still names them', async () => {
    const prompt = fixPrompt(toRun(rerunRun), toDetail(runDetails, flakyContext), null, null)
    expect(prompt).toContain('2 flaky')
    expect(prompt).toContain('Flaky tests (they passed on a retry):\n1. tests/profile.spec.ts › Profile › saves the avatar')
    expect(prompt).not.toContain('Failed tests:')
  })

  test('a passed run with only flaky tests is drafted as passed, not failed', async () => {
    const prompt = fixPrompt(toRun(rerunRun), toDetail(runDetails, flakyContext), null, null)
    expect(prompt).toContain('branch `fix-login` passed: no failed tests, 2 flaky')
    expect(prompt).not.toContain('failed: no failed tests')
  })

  test('the tests prompt lists each test with its flakiness, or its duration for the slowest', async () => {
    const flaky = testsPrompt('fix-login', toTestStats(flakiestTests), 'flakiness', 30)
    expect(flaky).toContain('These tests on branch `fix-login` were flaky in the last 30 days:')
    expect(flaky).toContain('1. tests/profile.spec.ts › saves the avatar (12.5% flaky over 8 executions)')
    const slow = testsPrompt('fix-login', toTestStats(slowestTests), 'duration', 30)
    expect(slow).toContain('1. tests/checkout.spec.ts › exports every order as CSV (avg 1m 35s over 6 executions)')
  })
})

describe('new failures', () => {
  test('a failure is new unless the default branch fails the same spec and title, whatever the id', async () => {
    const detail = toDetail(runDetails, context)
    const onMain = { ...toDetail(runDetails, null), failed: detail.failed.map(test => ({ ...test, testId: 't-90' })) }
    expect(newFailures(detail, toDetail(runDetails, null))?.map(test => test.title)).toEqual([
      ['Login', 'redirects to the dashboard after sign in'],
    ])
    expect(newFailures(detail, onMain)).toEqual([])
  })

  test("a failure counts as new only once the default branch's run is read", async () => {
    const detail = toDetail(runDetails, context)
    expect(newFailures(detail, undefined)).toBeNull()
    expect(newFailures(detail, { ...toDetail(runDetails, null), error: 'Currents did not answer within a minute.' })).toBeNull()
  })

  test('a test is known across runs by its spec and title', async () => {
    expect(testKeyOf({ spec: 'tests/login.spec.ts', title: ['Login', 'redirects to the dashboard after sign in'] })).toBe(
      'tests/login.spec.ts|Login › redirects to the dashboard after sign in',
    )
    expect(testKeyOf({ spec: 'tests/login.spec.ts', title: ['Login', 'logs out'] })).toBe('tests/login.spec.ts|Login › logs out')
  })
})

describe('words and helpers', () => {
  test('formats durations and ages', async () => {
    expect(duration(400_000)).toBe('6m 40s')
    expect(duration(12_400)).toBe('12s')
    expect(duration(3_720_000)).toBe('1h 2m')
    expect(duration(null)).toBe('—')
    expect(ago(iso(12), NOW)).toBe('12m ago')
    expect(ago(iso(0.2), NOW)).toBe('just now')
    expect(ago(iso(60 * 30), NOW)).toBe('30h ago')
  })

  test('reads the repository slug from a remote', async () => {
    expect(slugOf('git@github.com:Acme/Web.git')).toBe('acme/web')
    expect(slugOf('https://github.com/currents-dev/currents.git')).toBe('currents-dev/currents')
    expect(slugOf(null)).toBe(null)
  })

  test('picks the project whose newest run is newest', async () => {
    const a = { projectId: 'a', name: 'A', defaultBranch: null }
    const b = { projectId: 'b', name: 'B', defaultBranch: null }
    const older = toRun({ ...failedRun, createdAt: iso(60) })
    const newer = toRun({ ...failedRun, createdAt: iso(5) })
    expect(mostRecent([{ project: a, run: older }, { project: b, run: newer }])).toEqual(b)
    expect(mostRecent([{ project: a, run: null }])).toBe(null)
  })

  test('drops the least important parts of a line first', async () => {
    const line = [
      { text: 'fix-login' },
      { text: ' · 3 failed' },
      { text: ' · 420 tests', drop: 4 },
      { text: ' · 12m ago', drop: 2 },
    ]
    expect(fit(line, 100).map(seg => seg.text).join('')).toBe('fix-login · 3 failed · 420 tests · 12m ago')
    expect(fit(line, 32).map(seg => seg.text).join('')).toBe('fix-login · 3 failed · 12m ago')
    expect(fit(line, 10).map(seg => seg.text).join('')).toBe('fix-login · 3 failed')
  })

  test('tells sign-in, scope and rate limits apart', async () => {
    expect(classify('Failed to retrieve runs: GET /projects/x/runs: HTTP 401 {}').kind).toBe('auth')
    expect(classify('Failed to retrieve runs: GET /projects/x/runs: HTTP 403 insufficient_scope').kind).toBe('scope')
    expect(classify('Failed: HTTP 429 slow down').kind).toBe('rate')
    expect(classify('MCP server "plugin:currents-ci:currents" is not connected').kind).toBe('disconnected')
    expect(classify('fetch failed: ENOTFOUND api.currents.dev').kind).toBe('network')
    expect(
      classify("Claude requested permissions to use mcp__plugin_currents-ci_currents__currents-get-projects, but you haven't granted it yet.").kind,
    ).toBe('permission')
    expect(classify('Permission to use mcp__x__currents-get-runs has been denied.').kind).toBe('permission')
    // What the engine throws when the permission check denies the call, here auto mode.
    const refused = classify(
      'currents-ci: $.mcp.call(3fb6525c-f3dd-4d77-ba6b-ffa7031a8a00, currents-get-projects) refused: The server-side auto mode classifier gave no verdict for mcp__3fb6525c-f3dd-4d77-ba6b-ffa7031a8a00__currents-get-projects',
    )
    expect(refused.kind).toBe('permission')
    expect(refused.message).toBe("This session's permissions stopped the band reading Currents.")
    expect(
      classify('currents-ci: $.mcp.call: no connected MCP tool "currents-get-runs" on a server named "claude_ai_Currents"').kind,
    ).toBe('disconnected')
  })

  test("finds the file the engine saved a reply over its MCP output limit to, and no other", async () => {
    const path =
      'C:\\Users\\Ada Lovelace\\.claude\\projects\\C--Users-ada\\74e20eb3\\tool-results\\mcp-3fb6525c-f3dd-4d77-ba6b-ffa7031a8a00-currents-get-context-1793498356709.txt'
    // The engine's note, as Claude Code 2.1.314 words it.
    const note = (at: string) =>
      `Error: result (108,408 characters across 3,736 lines) exceeds maximum allowed tokens. Output has been saved to ${at}.\nFormat: Plain text\n- For targeted searches (find a line, locate a string): use grep on the file directly.`
    expect(savedReply(note(path), 'currents-get-context')).toBe(path)
    expect(savedReply(note(path).replace('.\n', ' and can be read in parts.\n'), 'currents-get-context')).toBe(path)
    expect(savedReply(note(path), 'currents-get-runs')).toBeNull()
    expect(savedReply(note('C:\\Users\\ada\\secrets\\currents-get-context.txt'), 'currents-get-context')).toBeNull()
    expect(savedReply(`Output has been saved to ${path}.`, 'currents-get-context')).toBeNull()
  })
})

describe("the band's reads", () => {
  test('names the rules for its five read-only tools, as tool names spell the server', async () => {
    expect(allowRules('plugin:currents-ci:currents')).toEqual([
      'mcp__plugin_currents-ci_currents__currents-get-projects',
      'mcp__plugin_currents-ci_currents__currents-get-runs',
      'mcp__plugin_currents-ci_currents__currents-get-run-details',
      'mcp__plugin_currents-ci_currents__currents-get-context',
      'mcp__plugin_currents-ci_currents__currents-get-tests-performance',
    ])
    expect(allowRules('plugin_currents-ci_currents')[0]).toBe('mcp__plugin_currents-ci_currents__currents-get-projects')
    expect(allowRules('claude.ai Currents')[1]).toBe('mcp__claude_ai_Currents__currents-get-runs')
    expect(allowRules('3fb6525c-f3dd-4d77-ba6b-ffa7031a8a00')[4]).toBe(
      'mcp__3fb6525c-f3dd-4d77-ba6b-ffa7031a8a00__currents-get-tests-performance',
    )
  })
})
