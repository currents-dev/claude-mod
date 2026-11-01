// Keeping the snapshot current: polling, choosing the project, and saying when a run ends.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderSurface, Timer } from 'claude-code'

import type { BranchPr, Connection, Project, Repo, Run, RunDetail, Snapshot, TestSort, Verdict, View } from '../types'
import {
  CurrentsError,
  TEST_WINDOW_DAYS,
  allowRules,
  createShareLink,
  discover,
  fetchDetail,
  fetchLatestRun,
  fetchProjects,
  fetchRuns,
  fetchTestStats,
  forget,
} from './currents'
import {
  VERDICT,
  duration,
  failedCount,
  fixPrompt,
  isActive,
  newFailures,
  outcomeSummary,
  plural,
  testsPrompt,
  verdictOf,
} from './model'
import { gitUserName, mostRecent, prOfBranch, projectIdsInRepo, readRepo } from './repo'
import { EMPTY, FIRST_VIEW, NO_DETAILS, PANE, normalize } from './state'

const snapshot = atom({ plugin: 'currents-ci', key: 'snapshot' } as const, EMPTY)
const details = atom({ plugin: 'currents-ci', key: 'details' } as const, NO_DETAILS)
const view = atom({ plugin: 'currents-ci', key: 'view' } as const, FIRST_VIEW)

type Engine = EngineInterface

export type Options = { notifications: boolean }

const SECOND = 1000
const MINUTE = 60 * SECOND

// Module state: a reload starts it over, and the next refresh rebuilds it.
let timer: Timer | null = null
let ticker: Timer | null = null
let inFlight: Promise<void> | null = null
let failures = 0
let isFirstRefresh = true
let projectsCache: { server: string; at: number; list: Project[] } | null = null
let prCache: { root: string; branch: string; at: number; pr: BranchPr | null } | null = null
const resolved = new Map<string, { project: Project; source: Snapshot['projectSource'] }>()
const seen = new Map<string, Verdict>()
const detailFetchedAt = new Map<string, number>()
const detailInFlight = new Set<string>()

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The run the drawer shows: the one picked, else the current branch's newest, else the default branch's. */
export const shownRun = (s: Snapshot, v: View): Run | null => {
  if (v.runId !== null) {
    const picked = s.branchRuns.find(run => run.runId === v.runId) ?? (s.baseRun?.runId === v.runId ? s.baseRun : null)
    if (picked !== null) return picked
  }
  return s.branchRuns[0] ?? s.baseRun ?? null
}

/**
 * The run a branch's failures are compared with: the default branch's newest,
 * with its details once read. Null for the default branch's own runs, which
 * have nothing to compare with.
 */
export const baselineOf = (
  s: Snapshot,
  run: Run,
  all: Record<string, RunDetail>,
): { name: string; detail: RunDetail | undefined } | null => {
  const base = s.baseRun
  if (base === null || base.runId === run.runId) return null
  return { name: base.branch ?? 'the default branch', detail: all[base.runId] }
}

/** Whether the current branch was pushed after its newest run started. */
export const isAwaitingRun = (s: Snapshot, now: number) =>
  s.pushedAt !== null &&
  now - s.pushedAt < 20 * MINUTE &&
  (s.branchRuns[0] === undefined || Date.parse(s.branchRuns[0].createdAt) < s.pushedAt - 30 * SECOND)

const activeRuns = (s: Snapshot) => [s.branchRuns[0]].filter((run): run is Run => run !== undefined && isActive(run))

const hasFailures = (run: Run) => failedCount(run.tests) > 0 || run.tests.flaky > 0 || run.status === 'FAILED'

let isLooping = false

/**
 * Starts the refresh loop once per load of the module, from session.start (a
 * reload runs it again) or, should another hook come first, from that one.
 * Never from a render hook: a drawing reads, and asks for nothing.
 */
export function ensureLoop($: Engine, options: Options) {
  if (isLooping) return
  isLooping = true
  void refresh($, options)
    .finally(() => schedule($, options).catch(() => undefined))
    .catch(() => undefined)
}

/** How long a refresh may take before the band stops saying "loading…" and says why. */
const REFRESH_LIMIT = 60 * SECOND
const STALLED = 'Currents did not answer within a minute.'

/** The server the refresh under way reads through, once found. */
let reading: string | null = null

export function refresh($: Engine, options: Options): Promise<void> {
  if (inFlight === null) {
    // A call that never settles (held for an approval nobody is shown) ends the wait, not the band.
    let guard: Timer | null = null
    const limit = new Promise<void>(resolve => {
      guard = $.clock.after(REFRESH_LIMIT, () => {
        failures += 1
        const server = reading
        void update($, snapshot, (s): Snapshot => ({
          ...s,
          isLoading: false,
          error: STALLED,
          allow: server !== null ? allowRules(server) : [],
        }))
          .catch(() => undefined)
          .finally(resolve)
      })
    })
    inFlight = Promise.race([load($, options), limit]).finally(() => {
      guard?.cancel()
      inFlight = null
    })
  }
  return inFlight
}

async function load($: Engine, options: Options) {
  await update($, snapshot, (s): Snapshot => ({ ...s, isLoading: true }))
  // The server found, so a failure past it is told as one rather than as "loading…".
  let found: Connection | null = null
  try {
    const now = await $.clock.now()
    const repo = await readRepo($, await $.session.cwd())
    const before = await read($, snapshot)
    found = before.connection.state === 'connected' ? before.connection : await discover($)
    if (found.state !== 'connected') {
      const message = before.connection.state === 'missing' ? before.connection.message : null
      const connection = found.state === 'missing' ? { ...found, message } : found
      await update($, snapshot, (s): Snapshot => ({ ...s, connection, repo, isLoading: false, error: null, allow: [] }))
      return
    }
    const connection = found
    reading = connection.server
    // Outside a repository the person's own runs stand in for a branch's.
    const author = repo === null || repo.branch === null ? await gitUserName($, repo?.root ?? (await $.session.cwd())) : null

    const projects = await projectsOf($, connection.server, now)
    const choice = await resolveProject($, connection.server, repo, projects, author)
    if (choice.project === null) {
      const { unseen } = choice
      await update($, snapshot, (s): Snapshot => ({
        ...s,
        connection,
        repo,
        projects,
        project: null,
        unseen,
        projectSource: null,
        branchRuns: [],
        baseRun: null,
        pullRequest: null,
        isLoading: false,
        error: null,
        allow: [],
        updatedAt: now,
      }))
      return
    }

    const { projectId, defaultBranch } = choice.project
    const branch = repo?.branch ?? null
    const scope = branch !== null ? 'branch' : 'mine'
    const runsFilter = branch !== null ? { branches: [branch] } : author ? { authors: [author] } : null
    const isSameList = before.project?.projectId === projectId && before.repo?.branch === branch && before.scope === scope
    // The default branch's newest run is the baseline the branch's failures are compared with.
    const baseBranch = branch !== null && defaultBranch !== null && defaultBranch !== branch ? defaultBranch : null
    const [branchRuns, pullRequest, baseRun] = await Promise.all([
      runsFilter === null
        ? Promise.resolve([])
        : runsOf($, connection.server, projectId, runsFilter, isSameList ? before.branchRuns : []),
      pullRequestOf($, repo, now),
      baseBranch === null
        ? Promise.resolve(null)
        : fetchLatestRun($, connection.server, projectId, { branches: [baseBranch] }).catch(() => null),
    ])
    const next = await update($, snapshot, (s): Snapshot => ({
      ...s,
      connection,
      repo,
      projects,
      project: choice.project,
      unseen: [],
      projectSource: choice.source,
      branchRuns,
      scope,
      baseRun,
      pullRequest,
      pushedAt: s.repo?.branch === repo?.branch ? s.pushedAt : null,
      updatedAt: now,
      isLoading: false,
      error: null,
      allow: [],
    }))
    failures = 0
    announce($, next, options)
    tick($, next)
    void ensureFailures($, next).catch(() => undefined)
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await ensureDetail($, shownRun(next, await read($, view)))
    }
  } catch (error) {
    failures += 1
    const failure = error instanceof CurrentsError ? error : new CurrentsError(messageOf(error), 'api')
    const isLost = failure.kind === 'auth' || failure.kind === 'disconnected'
    const reached = found
    if (isLost) {
      projectsCache = null
      if (reached?.state === 'connected') forget(reached.server)
    }
    await update($, snapshot, (s): Snapshot => ({
      ...s,
      isLoading: false,
      error: failure.message,
      allow: failure.kind === 'permission' && reached?.state === 'connected' ? allowRules(reached.server) : [],
      connection: isLost
        ? {
            state: 'missing',
            server: null,
            message:
              failure.kind === 'auth'
                ? 'The Currents connection needs signing in again: reconnect Currents in Connectors (or /mcp).'
                : 'The Currents connection dropped: reconnect Currents in Connectors (or /mcp).',
          }
        : reached?.state === 'connected'
          ? reached
          : s.connection,
    }))
  }
}

/** How many of a branch's runs the drawer's history lists. */
const HISTORY = 12

/**
 * The branch's runs, newest first. A refresh reads the newest alone, as a run
 * of a project with many groups is large; the history again only once a new
 * run starts, or while an older one is still in progress.
 */
async function runsOf(
  $: Engine,
  server: string,
  projectId: string,
  filter: { branches?: string[]; authors?: string[] },
  known: Run[],
): Promise<Run[]> {
  const [first, ...rest] = known
  if (first !== undefined && !rest.some(isActive)) {
    const [newest] = await fetchRuns($, server, projectId, filter, 1)
    if (newest === undefined) return []
    if (newest.runId === first.runId) return [newest, ...rest]
  }
  return fetchRuns($, server, projectId, filter, HISTORY)
}

/** Polls quickly while a run is in progress or a push awaits its run, slowly otherwise, and backs off on errors. */
export const delayFor = (s: Snapshot, now: number, failed: number): number => {
  // Looking for the connector reads the session's own tool list, so it can be often.
  if (s.connection.state === 'missing') return 20 * SECOND
  if (failed > 0) return Math.min(5 * MINUTE, 15 * SECOND * 2 ** failed)
  if (activeRuns(s).length > 0 || isAwaitingRun(s, now)) return 15 * SECOND
  return MINUTE
}

export async function schedule($: Engine, options: Options, ms?: number) {
  timer?.cancel()
  const wait = ms ?? delayFor(await read($, snapshot), await $.clock.now(), failures)
  timer = $.clock.after(wait, () => {
    void refresh($, options)
      .finally(() => schedule($, options).catch(() => undefined))
      .catch(() => undefined)
  })
}

/** While a run is in progress, redraw every few seconds so its elapsed time moves. */
function tick($: Engine, s: Snapshot) {
  if (activeRuns(s).length > 0) {
    ticker ??= $.clock.every(5 * SECOND, () => $.ui.invalidate('ui.render'))
  } else {
    ticker?.cancel()
    ticker = null
  }
}

// ---- Projects ----

async function projectsOf($: Engine, server: string, now: number) {
  if (projectsCache === null || projectsCache.server !== server || now - projectsCache.at > 10 * MINUTE) {
    projectsCache = { server, at: now, list: await fetchProjects($, server) }
  }
  return projectsCache.list
}

const storeKey = (repo: Repo | null) => `project:${repo?.root ?? '-'}`

type ProjectChoice =
  | { project: Project; source: Snapshot['projectSource'] }
  /** Nobody chose yet; `unseen`: projects the repository names that the sign-in cannot see. */
  | { project: null; unseen: string[] }

/**
 * The person's pick for this repository, else the project its Currents config
 * or CI names, else the only project they can see, else one whose runs name the
 * repository. A repository that names projects the sign-in cannot see says so,
 * rather than falling back to another organization's project.
 */
async function resolveProject(
  $: Engine,
  server: string,
  repo: Repo | null,
  projects: Project[],
  author: string | null,
): Promise<ProjectChoice> {
  const byId = new Map(projects.map(project => [project.projectId, project]))
  const key = storeKey(repo)
  const picked = (await $.store.get(key)) as Project | undefined
  if (picked?.projectId !== undefined && (byId.has(picked.projectId) || projects.length === 0)) {
    return { project: byId.get(picked.projectId) ?? picked, source: 'picked' }
  }
  const known = resolved.get(key)
  if (known !== undefined) return known

  let choice: { project: Project; source: Snapshot['projectSource'] } | null = null
  const named = repo === null ? [] : await projectIdsInRepo($, repo.root)
  const visible = named.filter(entry => byId.has(entry.projectId))
  if (named.length > 0 && visible.length === 0) {
    // The repository records to projects of an organization this sign-in is not in.
    return { project: null, unseen: named.map(entry => entry.projectId) }
  }
  if (repo !== null && visible.length > 0) {
    const top = visible[0]?.count ?? 0
    // The most-named project wins outright; a tie goes to the one with the newest run.
    const tied = visible
      .filter(entry => entry.count === top)
      .map(entry => byId.get(entry.projectId))
      .filter((p): p is Project => p !== undefined)
    if (tied.length === 1 && tied[0] !== undefined) {
      choice = { project: tied[0], source: 'repo' }
    } else if (tied.length > 1) {
      const latest = await Promise.all(
        tied.slice(0, 4).map(async project => ({
          project,
          run: await fetchLatestRun($, server, project.projectId, repo.branch ? { branches: [repo.branch] } : {}).catch(
            () => null,
          ),
        })),
      )
      const best = mostRecent(latest) ?? tied[0]
      if (best !== undefined) choice = { project: best, source: 'repo' }
    }
  }
  if (choice === null && projects.length === 1 && projects[0] !== undefined) {
    choice = { project: projects[0], source: 'only' }
  }
  if (choice === null && repo !== null && repo.slug !== null && projects.length <= 8) {
    const slug = repo.slug
    const latest = await Promise.all(
      projects.map(async project => ({
        project,
        run: await fetchLatestRun($, server, project.projectId, { search: slug }).catch(() => null),
      })),
    )
    const best = mostRecent(latest)
    if (best !== null) choice = { project: best, source: 'remote' }
  }
  if (choice === null && repo === null && author !== null && projects.length <= 8) {
    const latest = await Promise.all(
      projects.map(async project => ({
        project,
        run: await fetchLatestRun($, server, project.projectId, { authors: [author] }).catch(() => null),
      })),
    )
    const best = mostRecent(latest)
    if (best !== null) choice = { project: best, source: 'mine' }
  }
  if (choice === null) return { project: null, unseen: [] }
  resolved.set(key, choice)
  return choice
}

export async function pickProject($: Engine, options: Options, project: Project) {
  const s = await read($, snapshot)
  const key = storeKey(s.repo)
  await $.store.set(key, project)
  resolved.delete(key)
  await update($, view, (v): View => ({ ...v, runId: null, isPicking: false }))
  await update($, snapshot, (x): Snapshot => ({
    ...x,
    project,
    unseen: [],
    projectSource: 'picked',
    branchRuns: [],
    pullRequest: null,
    branchTests: null,
    updatedAt: null,
  }))
  await refresh($, options)
  await schedule($, options)
}

// ---- The branch's pull request ----

/** The checked-out branch's pull request, from the GitHub CLI, read again every two minutes. */
async function pullRequestOf($: Engine, repo: Repo | null, now: number): Promise<BranchPr | null> {
  if (repo === null || repo.branch === null) return null
  if (prCache === null || prCache.root !== repo.root || prCache.branch !== repo.branch || now - prCache.at > 2 * MINUTE) {
    prCache = { root: repo.root, branch: repo.branch, at: now, pr: await prOfBranch($, repo.root) }
  }
  return prCache.pr
}

// ---- Run detail ----

const MAX_DETAILS = 12

/** Fetches what the drawer shows below a run's header: once for a finished run, every poll for a running one. */
export async function ensureDetail($: Engine, run: Run | null, force = false) {
  if (run === null || detailInFlight.has(run.runId)) return
  const s = await read($, snapshot)
  if (s.connection.state !== 'connected') return
  const now = await $.clock.now()
  const have = (await read($, details))[run.runId]
  const fresh = now - (detailFetchedAt.get(run.runId) ?? 0) < 12 * SECOND
  if (!force && have !== undefined && have.error === null && (have.isFinal || fresh)) return

  detailInFlight.add(run.runId)
  try {
    const detail = await fetchDetail($, s.connection.server, run)
    detailFetchedAt.set(run.runId, now)
    await update($, details, all => keepNewest({ ...all, [run.runId]: detail }, run.runId))
  } catch (error) {
    const failed: RunDetail = {
      runId: run.runId,
      isFinal: false,
      specs: have?.specs ?? [],
      groups: have?.groups ?? [],
      failed: have?.failed ?? [],
      failedTotal: have?.failedTotal ?? 0,
      flakyTotal: have?.flakyTotal ?? 0,
      error: messageOf(error),
    }
    await update($, details, all => keepNewest({ ...all, [run.runId]: failed }, run.runId))
  } finally {
    detailInFlight.delete(run.runId)
  }
}

/**
 * What the band names: the failing tests of the branch's newest run, and of the
 * default branch's run they are compared with. A branch whose newest run is
 * green needs neither.
 */
async function ensureFailures($: Engine, s: Snapshot) {
  const latest = s.branchRuns[0]
  if (latest === undefined || !hasFailures(latest)) return
  await ensureDetail($, latest)
  if (s.baseRun !== null && s.baseRun.runId !== latest.runId) await ensureDetail($, s.baseRun)
}

const keepNewest = (all: Record<string, RunDetail>, keep: string) => {
  const ids = Object.keys(all)
  if (ids.length <= MAX_DETAILS) return all
  const trimmed: Record<string, RunDetail> = {}
  for (const id of ids.slice(-MAX_DETAILS)) {
    const detail = all[id]
    if (detail !== undefined) trimmed[id] = detail
  }
  const kept = all[keep]
  if (kept !== undefined) trimmed[keep] = kept
  return trimmed
}

// ---- The Tests tab ----

/** The branch's flakiest or slowest tests for the Tests tab: read when the tab or its order is chosen, again after five minutes. */
export async function ensureBranchTests($: Engine, sort: TestSort) {
  const s = await read($, snapshot)
  const branch = s.repo?.branch ?? null
  if (branch === null || s.project === null || s.connection.state !== 'connected') return
  const now = await $.clock.now()
  const have = s.branchTests
  if (have !== null && have.branch === branch && have.sort === sort && have.error === null && now - have.at < 5 * MINUTE) {
    return
  }
  try {
    const list = await fetchTestStats($, s.connection.server, s.project.projectId, branch, sort, now)
    await update($, snapshot, (x): Snapshot => ({ ...x, branchTests: { branch, sort, at: now, list, error: null } }))
  } catch (error) {
    await update($, snapshot, (x): Snapshot => ({
      ...x,
      branchTests: { branch, sort, at: now, list: [], error: messageOf(error) },
    }))
  }
}

// ---- Connecting ----

/**
 * Opens this session's MCP servers, where the plugin's Currents server signs in:
 * the terminal's /mcp dialog, or on another surface /mcp drafted in the box.
 */
export async function openSignIn($: Engine, surface: RenderSurface) {
  const s = normalize(await read($, snapshot))
  const server =
    s.connection.state === 'missing' && s.connection.server !== null
      ? s.connection.server
      : s.connection.state === 'connected'
        ? s.connection.server.replace(/^plugin_([^_]+)_/, 'plugin:$1:')
        : 'Currents'
  // Signed in to the wrong organization: the same dialog re-authenticates.
  const what = s.unseen.length > 0 ? `re-authenticate ${server} and pick the organization that owns ${s.unseen[0]}` : `sign in to ${server}`
  if (surface === 'terminal') {
    try {
      await $.command.run({ command: 'mcp' })
      return
    } catch {
      // fall through to the drafted command
    }
  }
  const filled = await $.prompt.fill({ text: '/mcp' }).catch(() => ({ isFilled: false }))
  $.ui.toast(
    filled.isFilled
      ? `Press Enter to open this session's MCP servers, then ${what}.`
      : `Open Connectors in the session sidebar, or type /mcp, and ${what}.`,
    { timeoutMs: 12_000 },
  )
}

/** Looks again for the Currents connector, as after the person turned it on. */
export async function retry($: Engine, options: Options) {
  failures = 0
  await update($, snapshot, (s): Snapshot => (s.connection.state === 'connected' ? s : { ...s, connection: { state: 'checking' } }))
  await refresh($, options)
  await schedule($, options)
}

// ---- Pushes and notifications ----

/** A push from this session: watch for the run it starts. */
export async function markPushed($: Engine, options: Options) {
  const now = await $.clock.now()
  await update($, snapshot, (s): Snapshot => ({ ...s, pushedAt: now }))
  await schedule($, options, 10 * SECOND)
}

/** Toasts, and notifies when asked, as the branch's newest run starts, fails and ends. */
function announce($: Engine, s: Snapshot, options: Options) {
  const run = s.branchRuns[0]
  const quiet = isFirstRefresh
  isFirstRefresh = false
  if (run === undefined) return
  const verdict = verdictOf(run)
  const before = seen.get(run.runId)
  seen.set(run.runId, verdict)
  if (quiet) return
  const where = run.branch ?? run.title
  if (before === undefined) {
    if (isActive(run) && run.branch !== null && run.branch === s.repo?.branch) {
      $.ui.toast(`● Tests started on ${where}: ${plural(run.specs.total, 'spec file')}`)
    }
    return
  }
  if (before === 'running' && verdict === 'failing') {
    $.ui.toast(`● ${where} is failing: ${plural(failedCount(run.tests), 'test')} failed so far`, { timeoutMs: 8000 })
    return
  }
  if ((before === 'running' || before === 'failing') && !isActive(run)) {
    const text = `${VERDICT[verdict].glyph} ${where} · ${outcomeSummary(run)} · ${plural(run.tests.total, 'test')} · ${duration(run.durationMs)}`
    $.ui.toast(text, { timeoutMs: 10_000 })
    if (options.notifications) void $.ui.notify(text, { title: 'Currents' }).catch(() => undefined)
  }
}

// ---- Fix with Claude ----

/** Drafts the prompt in the person's box; where there is none, sends it; failing both, copies it. */
async function sendPrompt($: Engine, text: string) {
  const filled = await $.prompt.fill({ text }).catch(() => ({ isFilled: false }))
  if (filled.isFilled) {
    $.ui.toast('The prompt is in the box below: press Enter to send it.')
    return
  }
  try {
    await $.prompt.submit({ text })
  } catch {
    const copied = await $.ui.copy({ text }).catch(() => ({ isCopied: false }))
    $.ui.toast(copied.isCopied ? 'Copied the fix prompt: paste it to Claude.' : 'Could not hand the prompt to Claude.')
  }
}

/** Fix with Claude for a run: its failures, and which of them this branch alone has. */
export async function fixWithClaude($: Engine, run: Run) {
  await ensureDetail($, run)
  const s = await read($, snapshot)
  const all = await read($, details)
  const detail = all[run.runId]
  const baseline = baselineOf(s, run, all)
  const fresh = detail === undefined || baseline === null ? null : newFailures(detail, baseline.detail)
  await sendPrompt($, fixPrompt(run, detail, fresh, baseline?.name ?? null))
}

/** Fix with Claude for the branch's flaky or slow tests, as the Tests tab lists them. */
export async function fixTestsWithClaude($: Engine) {
  const s = await read($, snapshot)
  const tests = s.branchTests
  if (tests === null || tests.error !== null || tests.list.length === 0) return
  await sendPrompt($, testsPrompt(tests.branch, tests.list, tests.sort, TEST_WINDOW_DAYS))
}

// ---- Sharing ----

/**
 * Makes a public link to a report, copies it and says so, and returns it. Only a
 * press makes one: a link works for anyone who has it, until it expires.
 */
export async function shareReport(
  $: Engine,
  target: { run_id: string } | { instance_id: string; test_id: string },
  what: string,
): Promise<string | null> {
  const s = await read($, snapshot)
  if (s.connection.state !== 'connected') return null
  try {
    const link = await createShareLink($, s.connection.server, target)
    const copied = await $.ui.copy({ text: link }).catch(() => ({ isCopied: false }))
    $.ui.toast(
      copied.isCopied ? `Copied a link to ${what}. It works for anyone who has it until it expires.` : `Link to ${what}: ${link}`,
      { timeoutMs: 12_000 },
    )
    return link
  } catch (error) {
    // A refusal is the session's permissions saying no, not the band failing to read.
    const why =
      error instanceof CurrentsError && error.kind === 'permission' ? "this session's permissions stopped it" : messageOf(error)
    $.ui.toast(`Could not make a link to ${what}: ${why}`, { timeoutMs: 10_000 })
    return null
  }
}
