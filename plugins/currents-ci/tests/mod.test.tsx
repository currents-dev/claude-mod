import type { On } from 'claude-code'
import { expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'

import {
  NOW,
  PR_VIEW,
  PR_VIEW_DRAFT,
  branchRuns,
  context,
  failedRun,
  flakiestTests,
  mainFailedRun,
  mainRun,
  ok,
  projects,
  runDetails,
  runningRun,
  shareLink,
  slowestTests,
} from './fixtures'

const PLUGIN = 'currents-ci'
/** The Currents connector as the Desktop app hands it to a session: by its id. */
const CONNECTOR = 'c0ffee00-1111-2222-3333-444455556666'
/** The plugin's own server, as tool names spell it. */
const OWN = 'plugin_currents-ci_currents'
const CURRENTS_TOOLS = [
  'currents-get-projects',
  'currents-get-runs',
  'currents-get-run-details',
  'currents-get-context',
  'currents-get-tests-performance',
  'currents-create-share-link',
]
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const SCROLL = { offset: 0, bodyRows: 40 }

const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 160, scroll: SCROLL, view: {} },
}

const PANE = {
  plugin: PLUGIN,
  component: 'Pane' as const,
  requestId: 'currents',
  props: { title: 'Currents', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: SCROLL, view: {} },
}

type World = {
  /** The Currents connector is on for the session. */
  connector: boolean
  /** The plugin's own server is signed in. */
  ownSignedIn: boolean
  /** The plugin's own server can be signed in to (false: turned off). */
  ownListed: boolean
  inRepo: boolean
  branchHasRuns: boolean
  /** The branch's newest run, which `currents-get-runs` lists first. */
  latest: unknown
  /** The default branch's newest run; null when it has none. */
  main: unknown
  /** The branch's commit, as `git rev-parse HEAD` reads it. */
  head: string
  /** The branch's pull request, as `gh pr view` prints it; null when the branch has none. */
  pr: string | null
  /** Reads of the default branch fail, as a refresh that cannot reach it does. */
  baselineFails?: boolean
  calls: string[]
  servers: string[]
  runFilters: Record<string, unknown>[]
  contextReads: Record<string, unknown>[]
  testReads: Record<string, unknown>[]
  shareCalls: Record<string, unknown>[]
  filled: string[]
  /** The projects the sign-in sees; the fixtures' two when absent. */
  projects?: unknown
  /** The session's permission check refuses every Currents call. */
  denied?: boolean
  /** The engine throws the permission check's refusal instead, as under auto mode: its reason. */
  refuses?: string
  /** Currents calls hang, as one held for an approval nobody is shown, until released. */
  stalls?: boolean
  held: (() => void)[]
  /** Tools whose replies run over the engine's MCP output limit: it saves them to a file and answers with a note. */
  oversize?: string[]
  /** The files the engine saved those replies to, by path. */
  saved: Record<string, string>
  /** Currents answers with text that is not JSON, as a proxy's error page. */
  garbles?: boolean
  toasts: string[]
  /** The plugin's `$.store`. */
  stored: Record<string, unknown>
  clock?: MockClock
}

const text = (body: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } })
const toolsOf = (server: string) =>
  CURRENTS_TOOLS.map(tool => ({ name: `mcp__${server}__${tool}`, description: tool, mcp: true }))

/** The engine beneath the mod: a repository on `fix-login`, GitHub, and Currents behind a connector or the plugin's server. */
const world = (on: On, init: Partial<World> = {}): World => {
  const w: World = {
    connector: true,
    ownSignedIn: false,
    ownListed: true,
    inRepo: true,
    branchHasRuns: true,
    latest: failedRun,
    main: mainRun,
    head: failedRun.meta.commit.sha,
    pr: PR_VIEW,
    calls: [],
    servers: [],
    runFilters: [],
    contextReads: [],
    testReads: [],
    shareCalls: [],
    filled: [],
    held: [],
    toasts: [],
    stored: {},
    saved: {},
    ...init,
  }
  w.clock = mock.clock(on, { now: NOW })
  on('store.get', ($, e) => ({ value: w.stored[e.key] }))
  on('store.set', ($, e) => {
    w.stored[e.key] = e.value
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/work/web' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('command.register', () => ({ value: { command: 'currents' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('tool.describe', ($, e) => ({ description: e.description }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('tool.list', () => ({
    value: [
      { name: 'Bash', description: 'Runs a command', mcp: false },
      { name: 'mcp__28b61e91-4cd7-4049-8598-a1c3f8be3df6__fetch_lead', description: 'Close', mcp: true },
      ...(w.ownSignedIn ? toolsOf(OWN) : []),
      ...(w.connector ? toolsOf(CONNECTOR) : []),
    ],
  }))
  on('mcp.connect', () =>
    w.ownSignedIn
      ? { value: { isConnected: true, server: 'plugin:currents-ci:currents' } }
      : w.ownListed
        ? {
            value: {
              isConnected: false,
              reason: 'auth',
              message: 'The MCP server "plugin:currents-ci:currents" needs you to sign in; run /mcp to authenticate.',
            },
          }
        : { value: { isConnected: false, reason: 'disabled', message: 'The MCP server is turned off.' } },
  )
  // The engine's own band beneath the mods: empty.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))
  on('mcp.call', async ($, e) => {
    w.calls.push(e.tool)
    w.servers.push(e.server)
    if (w.denied) {
      const refusal = `Claude requested permissions to use mcp__${e.server}__${e.tool}, but you haven't granted it yet.`
      return { value: { content: [{ type: 'text', text: refusal }], isError: true } }
    }
    if (w.refuses !== undefined) return { deny: `currents-ci: $.mcp.call(${e.server}, ${e.tool}) refused: ${w.refuses}` }
    if (w.stalls) await new Promise<void>(resolve => w.held.push(resolve))
    if (w.garbles) return { value: { content: [{ type: 'text', text: '<html><title>502 Bad Gateway</title></html>' }], isError: false } }
    const reply = (body: unknown) => {
      if (!w.oversize?.includes(e.tool)) return text(body)
      const json = JSON.stringify(body, null, 2)
      const path = `C:\\Users\\ada\\.claude\\projects\\C--work-web\\5e55-1on\\tool-results\\mcp-${e.server}-${e.tool}-${Object.keys(w.saved).length}.txt`
      w.saved[path] = json
      const note = `Error: result (${json.length} characters across ${json.split('\n').length} lines) exceeds maximum allowed tokens. Output has been saved to ${path}.\nFormat: JSON with schema: {status: string, data: [...]}\nUse offset and limit parameters to read specific portions of the file.`
      return { value: { content: [{ type: 'text', text: note }], isError: false } }
    }
    switch (e.tool) {
      case 'currents-get-projects':
        return reply(w.projects ?? projects)
      case 'currents-get-runs': {
        w.runFilters.push(e.args)
        const branches = (e.args.branches as string[] | undefined) ?? []
        if (branches.includes('main')) {
          if (w.baselineFails) return { value: { content: [{ type: 'text', text: 'HTTP 503 the default branch could not be read' }], isError: true } }
          return reply(ok(w.main === null ? [] : [w.main]))
        }
        if (branches.length > 0 && !w.branchHasRuns) return reply(ok([]))
        const runs = branchRuns(w.latest)
        return reply({ ...runs, data: (runs.data as unknown[]).slice(0, Number(e.args.limit ?? 10)) })
      }
      case 'currents-get-run-details':
        return reply(runDetails)
      case 'currents-get-context':
        w.contextReads.push(e.args)
        return reply(context)
      case 'currents-get-tests-performance':
        w.testReads.push(e.args)
        return reply(e.args.order === 'duration' ? slowestTests : flakiestTests)
      case 'currents-create-share-link':
        w.shareCalls.push(e.args)
        return reply(shareLink)
      default:
        return { value: { content: [{ type: 'text', text: `unknown tool ${e.tool}` }], isError: true } }
    }
  })
  on('fs.read', ($, e) => (e.path in w.saved ? { value: w.saved[e.path] ?? '' } : { deny: `ENOENT: no such file, open '${e.path}'` }))
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (argv.startsWith('git config user.name')) return out('Ada Lovelace\n')
    if (!w.inRepo && argv.startsWith('git')) return out('', 128)
    if (argv.startsWith('git rev-parse')) return out(`/work/web\n${w.head}\n`)
    if (argv.startsWith('git branch --show-current')) return out('fix-login\n')
    if (argv.startsWith('git remote get-url')) return out('git@github.com:acme/web.git\n')
    if (argv.startsWith('git grep')) return out("  projectId: 'AbC123',\n")
    if (argv.startsWith('gh pr view')) return w.pr === null ? out('', 1) : out(w.pr)
    return out('', 1)
  })
  on('prompt.fill', ($, e) => {
    w.filled.push(e.text)
    return { isFilled: true }
  })
  return w
}

const start = async ($: Engine) => {
  await $.session.start({ cwd: '/work/web', surface: 'terminal', isInteractive: true })
  await refresh($)
}

const currents = ($: Engine, args: string) =>
  $.command.run({
    command: 'currents',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

const refresh = ($: Engine) => currents($, 'refresh')

/** The `limit`s of the reads of one branch's runs, in the order the refreshes made them. */
const limitsOn = (w: World, branch: string) =>
  w.runFilters.filter(filter => JSON.stringify(filter.branches) === JSON.stringify([branch])).map(filter => filter.limit)

test('the band names the first failure and how many are new, on every surface', async ($, on) => {
  const w = world(on)
  await start($)
  await w.clock?.settle()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const line = await ui.find({ type: 'Text', text: /fix-login/ })
    expect(line?.text).toContain('3 failed, 2 flaky')
    expect(line?.text).toContain('Login › redirects to the dashboard after sign in +4')
    expect(line?.text).toContain('1 new')
    expect(line?.text).toContain('420 tests')
    expect(line?.text).toContain('6m 40s')
    expect(await ui.find({ key: 'fix' })).toBeDefined()
    expect(await ui.find({ key: 'open' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band names the first failure at once, and counts the new ones once main is read', async ($, on) => {
  const w = world(on, { baselineFails: true })
  await start($)
  // The run's failures are read in the background after the refresh: let them land.
  await w.clock?.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const before = await band.find({ type: 'Text', text: /fix-login/ })
  expect(before?.text).toContain('Login › redirects to the dashboard after sign in +4')
  expect(before?.text).not.toContain('1 new')

  w.baselineFails = false
  await refresh($)
  expect((await band.find({ type: 'Text', text: /fix-login/ }))?.text).toContain('1 new')
})

test('a branch whose failures all fail on main too says so', async ($, on) => {
  const w = world(on, { main: mainFailedRun })
  await start($)
  await w.clock?.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const line = await band.find({ type: 'Text', text: /fix-login/ })
  expect(line?.text).toContain('failing on main too')
  expect(line?.text).not.toContain(' new')

  // Each failing row says so too.
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'tab-errors' })
  expect(await pane.find({ type: 'Text', text: /^on main too$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^new$/ })).toBeUndefined()
})

test('a green main makes every failure new, and the drawer tags it', async ($, on) => {
  const w = world(on)
  await start($)
  // The default branch's newest run is read alone, once per refresh.
  expect(limitsOn(w, 'main')).toEqual([1])
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'tab-errors' })
  expect(await pane.find({ type: 'Text', text: /^new$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /1 failure new on fix-login, not failing on main/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /on main too/ })).toBeUndefined()
})

test('the band says which commit a run is for only when HEAD is another commit', async ($, on) => {
  const w = world(on)
  await start($)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = async () => (await band.find({ type: 'Text', text: /fix-login/ }))?.text ?? ''
  expect(await line()).toContain('fix-login')
  expect(await line()).not.toContain('run for')

  // Compared by the first seven characters: this HEAD is the same commit.
  w.head = '4f2c1d9ffffffff'
  await refresh($)
  expect(await line()).toContain('fix-login')
  expect(await line()).not.toContain('run for')

  w.head = '0a1b2c3d4e5f6a7b'
  await refresh($)
  expect(await line()).toContain('run for 4f2c1d9')
})

test("the band names the branch's pull request, as a draft while it is one", async ($, on) => {
  world(on, { pr: PR_VIEW_DRAFT })
  await start($)
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 220 }, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /fix-login/ }))?.text).toContain(' · PR #42 draft')
})

test('the drawer shows the run like the dashboard, with its errors, spec files and pull request', async ($, on) => {
  const w = world(on)
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: ' Failed ' }))?.props.inverse).toBe(true)
    expect(await ui.find({ type: 'Text', text: 'Fix the login redirect loop' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /52\/52 spec files · PR #42 · fix-login · 4f2c1d9 · Ada Lovelace/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '✗ 3 Failed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '≈ 2 flaky' })).toBeDefined()
    expect((await ui.find({ key: 'tab-errors' }))?.props.label).toBe('Errors (5)')

    await ui.press({ key: 'tab-errors' })
    expect(await ui.find({ type: 'Text', text: /Login › redirects to the dashboard after sign in/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Received: \/login/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'tests/login.spec.ts:41' })).toBeDefined()

    await ui.press({ key: 'tab-specs' })
    expect(await ui.find({ type: 'Text', text: 'Showing 3 out of 3 spec files in 2 groups' })).toBeDefined()

    await ui.press({ key: 'tab-prs' })
    expect((await ui.find({ key: 'tab-prs' }))?.props.label).toBe('Pull request #42')
    expect(await ui.find({ type: 'Text', text: /#42 Fix the login redirect loop/ })).toBeDefined()

    await ui.press({ key: 'tab-summary' })
    await ui.unmount()
  }
  expect(w.contextReads.at(-1)).toMatchObject({ run_id: 'run-failed-1', limit: 50, include_flaky: true })
  expect(w.servers.every(server => server === CONNECTOR)).toBe(true)
})

test('Fix with Claude drafts a prompt with the failures', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'fix' })
  expect(w.filled).toHaveLength(1)
  expect(w.filled[0]).toContain('run_id `run-failed-1`')
  expect(w.filled[0]).toContain('Login › redirects to the dashboard after sign in')
  expect(w.filled[0]).toContain('None of the failing tests fail on main: all are new on this branch.')
})

test("the run's Share link makes a report link for the run, and copies it", async ($, on) => {
  const w = world(on)
  const copied: string[] = []
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  await start($)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'share' })
  expect(w.shareCalls).toEqual([{ purpose: 'report', run_id: 'run-failed-1' }])
  expect(copied).toEqual([shareLink.pageUrl])
  expect(w.toasts.at(-1)).toContain('Copied a link to this run')
})

test("a failing test's Share link makes a report link for that test", async ($, on) => {
  const w = world(on)
  const copied: string[] = []
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  await start($)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'tab-errors' })
  await pane.press({ key: 'share-t-1:i-1' })
  expect(w.shareCalls).toEqual([{ purpose: 'report', instance_id: 'i-1', test_id: 't-1' }])
  expect(copied).toEqual([shareLink.pageUrl])
})

test("a Share link the session's permissions refuse says so in a toast", async ($, on) => {
  const w = world(on)
  await start($)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  w.denied = true
  await pane.press({ key: 'share' })
  expect(w.toasts.at(-1)).toContain("Could not make a link to this run: this session's permissions stopped it")
  expect(w.shareCalls).toEqual([])
})

test("the Tests tab reads the branch's tests, flakiest first, and the slowest on request", async ($, on) => {
  const w = world(on)
  await start($)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'tab-tests' })
  expect(w.testReads.at(-1)).toMatchObject({
    projectId: 'AbC123',
    branches: ['fix-login'],
    order: 'flakiness',
    dir: 'desc',
    min_executions: 2,
    limit: 15,
    date_start: '2026-09-29',
    date_end: '2026-10-29',
  })
  expect(await pane.find({ type: 'Text', text: /saves the avatar/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /12\.5% flaky/ })).toBeDefined()

  await pane.press({ key: 'sort-duration' })
  expect(w.testReads.at(-1)).toMatchObject({ branches: ['fix-login'], order: 'duration' })
  expect(await pane.find({ type: 'Text', text: /exports every order as CSV/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /avg 1m 35s/ })).toBeDefined()
})

test('Fix flaky tests with Claude, on the Tests tab, drafts the list it shows', async ($, on) => {
  const w = world(on)
  await start($)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'tab-tests' })
  await pane.press({ key: 'fix-tests' })
  expect(w.filled).toHaveLength(1)
  expect(w.filled[0]).toContain('These tests on branch `fix-login` were flaky in the last 30 days:')
  expect(w.filled[0]).toContain('saves the avatar (12.5% flaky over 8 executions)')
})

test('the pull request tab shows the PR, its review, and its builds grouped by commit', async ($, on) => {
  const w = world(on)
  await start($)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'tab-prs' })
  expect(await pane.find({ type: 'Text', text: /#42 Fix the login redirect loop/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Open · fix-login → main · Approved/ })).toBeDefined()
  expect((await pane.find({ type: 'Link', text: 'Open the pull request ↗' }))?.props.href).toBe('https://github.com/acme/web/pull/42')

  // One header per commit, the newest commit first; each commit's builds follow it.
  const commits = await pane.findAll({ type: 'Text', text: /^[0-9a-f]{7} · / })
  expect(commits.map(commit => commit.text)).toEqual(['4f2c1d9 · Ada Lovelace · 12m ago', '7e6d5c4 · Grace Hopper · 5h ago'])
  expect(await pane.find({ type: 'Button', text: /Failed · 3 failed · 2 flaky · 6m 40s · CI gha-991-1/ })).toBeDefined()
  expect(w.calls).not.toContain('currents-list-pull-requests')
})

test('a branch with neither a pull request nor runs says so, and offers to open one on GitHub', async ($, on) => {
  world(on, { branchHasRuns: false, pr: null })
  await start($)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'tab-prs' })
  expect(await pane.find({ type: 'Text', text: /No pull request for fix-login yet, and no runs on it/ })).toBeDefined()
  expect((await pane.find({ type: 'Link', text: 'Open a pull request on GitHub ↗' }))?.props.href).toBe(
    'https://github.com/acme/web/compare/fix-login?expand=1',
  )
})

test('a branch with no runs of its own or on main, and no pull request, offers the compare link', async ($, on) => {
  world(on, { branchHasRuns: false, main: null, pr: null })
  await start($)
  // With no run to show there are no tabs: the pull request section is drawn in the body.
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /No Currents runs on fix-login yet/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /No pull request for fix-login yet, and no runs on it/ })).toBeDefined()
  expect((await pane.find({ type: 'Link', text: 'Open a pull request on GitHub ↗' }))?.props.href).toBe(
    'https://github.com/acme/web/compare/fix-login?expand=1',
  )
})

test("with no pull request from GitHub, the branch's run names its pull request", async ($, on) => {
  world(on, { pr: null })
  await start($)
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 220 }, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /fix-login/ }))?.text).toContain(' · PR #42')
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'tab-prs' })
  expect((await pane.find({ key: 'tab-prs' }))?.props.label).toBe('Pull request #42')
  expect(await pane.find({ type: 'Text', text: /#42 Fix the login redirect loop/ })).toBeDefined()
  expect((await pane.find({ type: 'Link', text: 'Open the pull request ↗' }))?.props.href).toBe('https://github.com/acme/web/pull/42')
})

test("signed out, Sign in opens this session's MCP servers, and the band fills in once signed in", async ($, on) => {
  const w = world(on, { connector: false })
  await start($)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /Sign in to see your test runs/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /Reconnect currents in \/mcp/ })).toBeDefined()
  await band.press({ key: 'sign-in' })
  expect(w.filled).toEqual(['/mcp'])

  // A narrow band keeps what to do and lets the hint go.
  const narrow = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns: 64 } })
  expect(await narrow.find({ type: 'Text', text: /Sign in to see your test runs/ })).toBeDefined()
  expect(await narrow.find({ type: 'Text', text: /Reconnect currents/ })).toBeUndefined()
  await narrow.unmount()

  w.ownSignedIn = true
  await band.press({ key: 'setup' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'retry' })
  expect(await band.find({ type: 'Text', text: /3 failed, 2 flaky/ })).toBeDefined()
  expect(w.servers.at(-1)).toBe(OWN)
})

test('the connector is found from the tool descriptions, and wins over the plugin\'s own server', async ($, on) => {
  const w = world(on, { connector: false })
  await start($)
  w.connector = true
  w.ownSignedIn = true
  await $.tool.describe({
    tool: `mcp__${CONNECTOR}__currents-get-runs`,
    description: 'Retrieves a list of runs',
    isDeferred: true,
    provider: { plugin: `mcp:${CONNECTOR}`, tier: 'user' },
  })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /3 failed, 2 flaky/ })).toBeDefined()
  expect(w.servers.at(-1)).toBe(CONNECTOR)
})

test('with no server to sign in to, the band links the Currents connector', async ($, on) => {
  world(on, { connector: false, ownListed: false })
  await start($)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Link' }))?.props.href).toBe('https://claude.ai/directory/currents')
  expect(await band.find({ key: 'sign-in' })).toBeUndefined()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Code' }))?.props.source).toContain('claude mcp add --transport http')
})

test('outside a repository, the band shows your own latest run', async ($, on) => {
  const w = world(on, { inRepo: false })
  await start($)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const line = await band.find({ type: 'Text', text: /your last run/ })
  expect(line?.text).toContain('Web E2E')
  expect(line?.text).toContain('3 failed, 2 flaky')
  expect(w.runFilters.some(filter => JSON.stringify(filter.authors) === '["Ada Lovelace"]')).toBe(true)
})

test("a branch with no runs yet shows how the default branch stands", async ($, on) => {
  world(on, { branchHasRuns: false })
  await start($)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = await band.find({ type: 'Text', text: /no runs yet/ })
  expect(line?.text).toContain('main')
  expect(line?.text).toContain('Passed')
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /No runs on fix-login yet/ })).toBeDefined()
})

test('a run in progress shows its progress, and a push is watched', async ($, on) => {
  const w = world(on, { latest: runningRun })
  await start($)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = await band.find({ type: 'Text', text: /fix-login/ })
  expect(line?.text).toContain('Running')
  expect(line?.text).toContain('14/26 spec files')
  expect(line?.text).toContain('3m 00s')

  await $.tool.call({ tool: 'Bash', command: 'git push origin fix-login' })
  w.latest = failedRun
  expect((await band.find({ type: 'Text', text: /fix-login/ }))?.text).toContain('waiting for its run to start')
})

test('drawing the band only reads: it shows loading and asks for nothing until session.start', async ($, on) => {
  const w = world(on)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await w.clock?.advance(5_000)
  await w.clock?.settle()
  expect(await band.find({ type: 'Text', text: /loading/ })).toBeDefined()
  expect(w.calls).toEqual([])
  // A reload runs session.start again, which starts the loop.
  await $.session.start({ cwd: '/work/web', surface: 'desktop', isInteractive: true })
  expect(await band.find({ type: 'Text', text: /3 failed, 2 flaky/ })).toBeDefined()
})

test("a repository whose project the sign-in can't see says so, and falls back to no other project", async ($, on) => {
  const w = world(on, { projects: ok([{ projectId: 'Zzz999', name: 'Onboarding', createdAt: NOW, defaultBranchName: 'main' }]) })
  await start($)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /your sign-in can't see AbC123/ })).toBeDefined()
  expect(w.runFilters).toHaveLength(0)
  await band.press({ key: 'sign-in' })
  expect(w.filled).toEqual(['/mcp'])
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /records to AbC123, which your Currents sign-in can't see/ })).toBeDefined()
  expect(await pane.find({ key: 'project' })).toBeDefined()
})

test('× hides the band for this session and says how to bring it back; /currents band hides it in every session', async ($, on) => {
  const w = world(on)
  await start($)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'hide' })
  expect(await band.find({ key: 'open' })).toBeUndefined()
  expect(w.toasts.at(-1)).toContain('/currents band brings it back')
  expect('bandHidden' in w.stored).toBe(false)

  await currents($, 'band')
  expect(await band.find({ key: 'open' })).toBeDefined()
  await currents($, 'band')
  expect(await band.find({ key: 'open' })).toBeUndefined()
  expect(w.stored.bandHidden).toBe(true)

  // The drawer's Show the band undoes that too.
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'show-band' })
  expect(await band.find({ key: 'open' })).toBeDefined()
  expect(w.stored.bandHidden).toBe(false)
})

test('session.start, which a reload runs again, asks for the band to be drawn afresh', async ($, on) => {
  world(on)
  const invalidated: string[] = []
  on('ui.invalidate', ($, e) => {
    invalidated.push(e.event)
    return { value: undefined }
  })
  await start($)
  expect(invalidated).toContain('ui.render')
})

test('with no session.start, the next prompt starts the loop', async ($, on) => {
  world(on)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /loading/ })).toBeDefined()
  await $.prompt.submit({ text: 'run the tests', wait: false, origin: { kind: 'composer' } })
  expect(await band.find({ type: 'Text', text: /3 failed, 2 flaky/ })).toBeDefined()
})

test("reads the session's permissions refuse say so and name the rules to allow, rather than loading", async ($, on) => {
  const w = world(on, { denied: true })
  const copied: string[] = []
  on('ui.copy', ($, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /permissions stopped the band reading Currents/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /loading/ })).toBeUndefined()
    expect(await band.find({ key: 'allow' })).toBeDefined()
    expect(await band.find({ key: 'retry' })).toBeDefined()
    await band.unmount()
  }

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'allow' })
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const rules = (await pane.find({ type: 'Code' }))?.props.source
  expect(rules).toContain(`"mcp__${CONNECTOR}__currents-get-runs"`)
  expect(rules).toContain(`"mcp__${CONNECTOR}__currents-get-context"`)
  await pane.press({ key: 'copy-rules' })
  expect(copied[0]?.split('\n')).toHaveLength(5)
  expect(copied[0]).toContain(`"mcp__${CONNECTOR}__currents-get-projects",`)

  // Allowed, Check again shows the runs.
  w.denied = false
  await pane.press({ key: 'retry' })
  expect(await band.find({ type: 'Text', text: /3 failed, 2 flaky/ })).toBeDefined()
})

test("auto mode's refusal, which the engine throws, offers the rules too", async ($, on) => {
  const w = world(on, { refuses: 'The server-side auto mode classifier gave no verdict for this call' })
  await start($)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: /permissions stopped the band reading Currents/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /\$\.mcp\.call/ })).toBeUndefined()
  expect(await band.find({ key: 'allow' })).toBeDefined()

  w.refuses = undefined
  await band.press({ key: 'retry' })
  expect(await band.find({ type: 'Text', text: /3 failed, 2 flaky/ })).toBeDefined()
})

test('a refresh that never hears back says so after a minute, and offers the rules', async ($, on) => {
  const w = world(on, { stalls: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const submitted = $.prompt.submit({ text: 'run the tests', wait: false, origin: { kind: 'composer' } })
  await w.clock?.advance(60_000)
  await w.clock?.settle()
  expect(await band.find({ type: 'Text', text: /did not answer within a minute/ })).toBeDefined()
  expect(await band.find({ key: 'allow' })).toBeDefined()
  expect(await band.find({ key: 'retry' })).toBeDefined()
  w.stalls = false
  for (const release of w.held) release()
  await submitted
})

test("a reply over the engine's MCP output limit is read whole from the file the engine saved it to", async ($, on) => {
  const w = world(on, { oversize: ['currents-get-runs', 'currents-get-context'] })
  await start($)
  await w.clock?.settle()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const line = await band.find({ type: 'Text', text: /fix-login/ })
  expect(line?.text).toContain('3 failed, 2 flaky')
  expect(line?.text).toContain('Login › redirects to the dashboard after sign in +4')
  expect(line?.text).toContain('1 new')
  expect(Object.keys(w.saved).length).toBeGreaterThan(1)
})

test('a reply that is not JSON is quoted, and the band says how old its news is once refreshes keep failing', async ($, on) => {
  const w = world(on)
  await start($)
  w.garbles = true
  await w.clock?.advance(3 * 60_000)
  await w.clock?.settle()
  await refresh($)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const line = await band.find({ type: 'Text', text: /fix-login/ })
  expect(line?.text).toContain('3 failed, 2 flaky')
  expect(line?.text).toContain('⚠ updated 3m ago')
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /Last refresh failed: .*could not read: "<html><title>502 Bad Gateway/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /refreshing every/ })).toBeUndefined()
})

test("each refresh reads the branch's newest run alone, and its history once a new run starts", async ($, on) => {
  const w = world(on)
  await start($)
  expect(limitsOn(w, 'fix-login')).toEqual([12])

  await refresh($)
  expect(limitsOn(w, 'fix-login')).toEqual([12, 1])

  w.latest = runningRun
  await refresh($)
  expect(limitsOn(w, 'fix-login')).toEqual([12, 1, 1, 12])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /fix-login/ }))?.text).toContain('Running')
})

test('Open shows the run, even where the project picker was left open', async ($, on) => {
  world(on)
  await start($)
  await currents($, 'project')
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ key: 'project' })).toBeDefined()
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'open' })
  expect(await pane.find({ key: 'project' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'Fix the login redirect loop' })).toBeDefined()
})
