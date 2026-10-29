import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import {
  NOW,
  OPEN_PRS,
  branchRuns,
  context,
  failedRun,
  ok,
  passedPrRun,
  projects,
  pullRequests,
  runDetails,
  runningRun,
} from './fixtures'

const PLUGIN = 'currents-ci'
/** The Currents connector as the Desktop app hands it to a session: by its id. */
const CONNECTOR = 'c0ffee00-1111-2222-3333-444455556666'
/** The plugin's own server, as tool names spell it. */
const OWN = 'plugin_currents-ci_currents'
const CURRENTS_TOOLS = ['currents-get-projects', 'currents-get-runs', 'currents-get-run-details', 'currents-get-context']
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
  latest: unknown
  calls: string[]
  servers: string[]
  runFilters: Record<string, unknown>[]
  filled: string[]
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
    calls: [],
    servers: [],
    runFilters: [],
    filled: [],
    ...init,
  }
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.cwd', () => ({ value: '/work/web' }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('command.register', () => ({ value: { command: 'currents' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('tool.describe', ($, e) => ({ description: e.description }))
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
  on('mcp.call', ($, e) => {
    w.calls.push(e.tool)
    w.servers.push(e.server)
    switch (e.tool) {
      case 'currents-get-projects':
        return text(projects)
      case 'currents-get-runs': {
        w.runFilters.push(e.args)
        const branches = (e.args.branches as string[] | undefined) ?? []
        if (branches.includes('main')) return text(ok([passedPrRun_onMain]))
        if (branches.length > 0 && !w.branchHasRuns) return text(ok([]))
        return text(branchRuns(w.latest))
      }
      case 'currents-list-pull-requests':
        return text(pullRequests)
      case 'currents-get-run-details':
        return text(runDetails)
      case 'currents-get-context':
        return text(context)
      default:
        return { value: { content: [{ type: 'text', text: `unknown tool ${e.tool}` }], isError: true } }
    }
  })
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    const out = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (argv.startsWith('git config user.name')) return out('Ada Lovelace\n')
    if (!w.inRepo && argv.startsWith('git')) return out('', 128)
    if (argv.startsWith('git rev-parse')) return out('/work/web\n4f2c1d9e8a7b6c5d\n')
    if (argv.startsWith('git branch --show-current')) return out('fix-login\n')
    if (argv.startsWith('git remote get-url')) return out('git@github.com:acme/web.git\n')
    if (argv.startsWith('git grep')) return out("  projectId: 'AbC123',\n")
    if (argv.startsWith('gh pr list')) return out(OPEN_PRS)
    return out('', 1)
  })
  on('prompt.fill', ($, e) => {
    w.filled.push(e.text)
    return { isFilled: true }
  })
  return w
}

/** The default branch's newest run. */
const passedPrRun_onMain = {
  ...passedPrRun,
  runId: 'run-main-9',
  meta: { ...passedPrRun.meta, pr: null, commit: { ...passedPrRun.meta.commit, branch: 'main', message: 'chore: release' } },
}

const start = async ($: Engine) => {
  await $.session.start({ cwd: '/work/web', surface: 'terminal', isInteractive: true })
  await refresh($)
}

const refresh = ($: Engine) =>
  $.command.run({
    command: 'currents',
    args: 'refresh',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

test('the band sums up the branch and the other PRs on every surface', async ($, on) => {
  world(on)
  await start($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const line = await ui.find({ type: 'Text', text: /fix-login/ })
    expect(line?.text).toContain('3 failed, 2 flaky')
    expect(line?.text).toContain('420 tests')
    expect(line?.text).toContain('6m 40s')
    expect(line?.text).toContain('1 other PR')
    expect(await ui.find({ key: 'fix' })).toBeDefined()
    expect(await ui.find({ key: 'open' })).toBeDefined()
    await ui.unmount()
  }
})

test('the drawer shows the run like the dashboard, with its errors, spec files and PRs', async ($, on) => {
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
    expect(await ui.find({ key: 'pr-github:github.com/acme/web#77' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#80 Tweak the docs · no Currents runs yet · draft/ })).toBeDefined()

    await ui.press({ key: 'tab-summary' })
    await ui.unmount()
  }
  expect(w.calls).toContain('currents-get-context')
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
