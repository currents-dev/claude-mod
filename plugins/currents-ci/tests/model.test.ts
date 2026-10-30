import { describe, expect, test } from 'claude-code/testing'

import { allowRules, classify } from '../hooks/currents'
import {
  ago,
  duration,
  failedCount,
  fixPrompt,
  listOf,
  outcomeSummary,
  passRate,
  progressOf,
  toDetail,
  toPullRequest,
  toRun,
  verdictOf,
} from '../hooks/model'
import { mostRecent, slugOf } from '../hooks/repo'
import { fit } from '../hooks/views'
import { NOW, context, failedRun, iso, pullRequests, runDetails, runningRun } from './fixtures'

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

describe('pull requests and details', () => {
  test('reads a pull request card', async () => {
    const [card] = listOf(pullRequests).map(toPullRequest)
    expect(card?.number).toBe('42')
    expect(card?.source).toBe('fix-login')
    expect(card?.latest.runId).toBe('run-failed-1')
    expect(card?.recent[0]?.failures).toBe(3)
  })

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

  test('drafts a fix prompt that names the run and its failures', async () => {
    const run = toRun(failedRun)
    const prompt = fixPrompt(run, toDetail(runDetails, context))
    expect(prompt).toContain('branch `fix-login` failed: 3 failed tests, 2 flaky')
    expect(prompt).toContain('https://app.currents.dev/run/run-failed-1')
    expect(prompt).toContain('tests/login.spec.ts › Login › redirects to the dashboard after sign in')
    expect(prompt).toContain('at tests/login.spec.ts:41')
    expect(prompt).not.toContain('saves the avatar')
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
  })
})

describe("the band's reads", () => {
  test('names the rules for its five read-only tools, as tool names spell the server', async () => {
    expect(allowRules('plugin:currents-ci:currents')).toEqual([
      'mcp__plugin_currents-ci_currents__currents-get-projects',
      'mcp__plugin_currents-ci_currents__currents-get-runs',
      'mcp__plugin_currents-ci_currents__currents-list-pull-requests',
      'mcp__plugin_currents-ci_currents__currents-get-run-details',
      'mcp__plugin_currents-ci_currents__currents-get-context',
    ])
    expect(allowRules('plugin_currents-ci_currents')[0]).toBe('mcp__plugin_currents-ci_currents__currents-get-projects')
    expect(allowRules('claude.ai Currents')[1]).toBe('mcp__claude_ai_Currents__currents-get-runs')
    expect(allowRules('3fb6525c-f3dd-4d77-ba6b-ffa7031a8a00')[4]).toBe(
      'mcp__3fb6525c-f3dd-4d77-ba6b-ffa7031a8a00__currents-get-context',
    )
  })
})
