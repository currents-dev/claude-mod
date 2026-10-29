// Keeping the snapshot current: polling, choosing the project, and saying when a run ends.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderSurface, Timer } from 'claude-code'

import type { Project, PullRequest, Repo, Run, RunDetail, Snapshot, Verdict, View } from '../types'
import {
  CurrentsError,
  discover,
  fetchDetail,
  fetchLatestRun,
  fetchProjects,
  fetchPullRequests,
  fetchRuns,
  forget,
} from './currents'
import {
  VERDICT,
  duration,
  failedCount,
  fixPrompt,
  isActive,
  outcomeSummary,
  plural,
  verdictOf,
} from './model'
import { gitUserName, mostRecent, myOpenPrs, projectIdsInRepo, readRepo, type OpenPr } from './repo'
import { EMPTY, FIRST_VIEW, NO_DETAILS, PANE, normalize } from './state'

const snapshot = atom({ plugin: 'currents-ci', key: 'snapshot' } as const, EMPTY)
const details = atom({ plugin: 'currents-ci', key: 'details' } as const, NO_DETAILS)
const view = atom({ plugin: 'currents-ci', key: 'view' } as const, FIRST_VIEW)

type Engine = EngineInterface

export type Options = { notifications: boolean; pullRequests: 'mine' | 'all' }

const SECOND = 1000
const MINUTE = 60 * SECOND

// Module state: a reload starts it over, and the next refresh rebuilds it.
let timer: Timer | null = null
let ticker: Timer | null = null
let inFlight: Promise<void> | null = null
let failures = 0
let isFirstRefresh = true
let projectsCache: { server: string; at: number; list: Project[] } | null = null
let openPrsCache: { root: string; at: number; list: OpenPr[] | null } | null = null
const resolved = new Map<string, { project: Project; source: Snapshot['projectSource'] }>()
const seen = new Map<string, Verdict>()
const detailFetchedAt = new Map<string, number>()
const detailInFlight = new Set<string>()

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The run the drawer shows: the one picked, else the current branch's newest. */
export const shownRun = (s: Snapshot, v: View): Run | null => {
  if (v.runId !== null) {
    const picked =
      s.branchRuns.find(run => run.runId === v.runId) ?? s.prs.find(pr => pr.latest.runId === v.runId)?.latest
    if (picked !== undefined) return picked
  }
  return s.branchRuns[0] ?? s.baseRun ?? null
}

/** Whether the current branch was pushed after its newest run started. */
export const isAwaitingRun = (s: Snapshot, now: number) =>
  s.pushedAt !== null &&
  now - s.pushedAt < 20 * MINUTE &&
  (s.branchRuns[0] === undefined || Date.parse(s.branchRuns[0].createdAt) < s.pushedAt - 30 * SECOND)

const activeRuns = (s: Snapshot) => [s.branchRuns[0], ...s.prs.map(pr => pr.latest)].filter(
  (run): run is Run => run !== undefined && isActive(run),
)

let isLooping = false

/**
 * Starts the refresh loop once per load of the module, from whichever hook runs
 * first: a plugin loaded by `/reload-plugins` mid-session sees no session.start.
 */
export function ensureLoop($: Engine, options: Options) {
  if (isLooping) return
  isLooping = true
  void refresh($, options)
    .finally(() => schedule($, options).catch(() => undefined))
    .catch(() => undefined)
}

/**
 * The same from a render hook, which must not write: it asks for a timer to
 * start the loop. The engine may refuse a timer asked while drawing, so nothing
 * counts as started until the loop runs, and the next hook tries again.
 */
export function ensureLoopSoon($: Engine, options: Options) {
  if (isLooping) return
  try {
    $.clock.after(0, () => ensureLoop($, options))
  } catch {
    // left to the next hook
  }
}

export function refresh($: Engine, options: Options): Promise<void> {
  inFlight ??= load($, options).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function load($: Engine, options: Options) {
  await update($, snapshot, (s): Snapshot => ({ ...s, isLoading: true }))
  try {
    const now = await $.clock.now()
    const repo = await readRepo($, await $.session.cwd())
    const before = await read($, snapshot)
    const found = before.connection.state === 'connected' ? before.connection : await discover($)
    if (found.state !== 'connected') {
      const message = before.connection.state === 'missing' ? before.connection.message : null
      const connection = found.state === 'missing' ? { ...found, message } : found
      await update($, snapshot, (s): Snapshot => ({ ...s, connection, repo, isLoading: false, error: null }))
      return
    }
    const connection = found
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
        prs: [],
        quietPrs: [],
        isLoading: false,
        error: null,
        updatedAt: now,
      }))
      return
    }

    const { projectId, defaultBranch } = choice.project
    const branch = repo?.branch ?? null
    const runsFilter = branch !== null ? { branches: [branch] } : author ? { authors: [author] } : null
    const [branchRuns, prs] = await Promise.all([
      runsFilter === null ? Promise.resolve([]) : fetchRuns($, connection.server, projectId, runsFilter),
      pullRequestsOf($, connection.server, projectId, repo, author, options, now),
    ])
    // A branch with no run yet: show how the default branch stands instead.
    const baseRun =
      branchRuns.length === 0 && branch !== null && defaultBranch !== null && defaultBranch !== branch
        ? await fetchLatestRun($, connection.server, projectId, { branches: [defaultBranch] }).catch(() => null)
        : null
    const next = await update($, snapshot, (s): Snapshot => ({
      ...s,
      connection,
      repo,
      projects,
      project: choice.project,
      unseen: [],
      projectSource: choice.source,
      branchRuns,
      scope: branch !== null ? 'branch' : 'mine',
      baseRun,
      prs: prs.cards,
      quietPrs: prs.quiet,
      pushedAt: s.repo?.branch === repo?.branch ? s.pushedAt : null,
      updatedAt: now,
      isLoading: false,
      error: null,
    }))
    failures = 0
    announce($, next, options)
    tick($, next)
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await ensureDetail($, shownRun(next, await read($, view)))
    }
  } catch (error) {
    failures += 1
    const failure = error instanceof CurrentsError ? error : new CurrentsError(messageOf(error), 'api')
    const isLost = failure.kind === 'auth' || failure.kind === 'disconnected'
    if (isLost) {
      projectsCache = null
      const { connection } = await read($, snapshot)
      if (connection.state === 'connected') forget(connection.server)
    }
    await update($, snapshot, (s): Snapshot => ({
      ...s,
      isLoading: false,
      error: failure.message,
      connection: isLost
        ? {
            state: 'missing',
            server: null,
            message:
              failure.kind === 'auth'
                ? 'The Currents connection needs signing in again: reconnect Currents in Connectors (or /mcp).'
                : 'The Currents connection dropped: reconnect Currents in Connectors (or /mcp).',
          }
        : s.connection,
    }))
  }
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
    prs: [],
    quietPrs: [],
    updatedAt: null,
  }))
  await refresh($, options)
  await schedule($, options)
}

// ---- Pull requests ----

async function pullRequestsOf(
  $: Engine,
  server: string,
  projectId: string,
  repo: Repo | null,
  author: string | null,
  options: Options,
  now: number,
): Promise<{ cards: PullRequest[]; quiet: Snapshot['quietPrs'] }> {
  const newestFirst = (a: PullRequest, b: PullRequest) =>
    Date.parse(b.latest.createdAt) - Date.parse(a.latest.createdAt)
  if (options.pullRequests === 'all' || repo === null) {
    const filter = options.pullRequests === 'mine' && author !== null ? { authors: [author] } : {}
    return { cards: (await fetchPullRequests($, server, projectId, filter)).sort(newestFirst), quiet: [] }
  }
  if (openPrsCache === null || openPrsCache.root !== repo.root || now - openPrsCache.at > 2 * MINUTE) {
    openPrsCache = { root: repo.root, at: now, list: await myOpenPrs($, repo.root) }
  }
  const mine = openPrsCache.list
  if (mine === null) {
    // No GitHub CLI: the person's runs by their git author name instead.
    const name = await gitUserName($, repo.root)
    const cards = await fetchPullRequests($, server, projectId, name ? { authors: [name] } : {})
    return { cards: cards.sort(newestFirst), quiet: [] }
  }
  const branches = [...new Set(mine.map(pr => pr.branch))]
  if (branches.length === 0) return { cards: [], quiet: [] }
  const cards = (await fetchPullRequests($, server, projectId, { branches })).filter(
    card => card.source === null || branches.includes(card.source),
  )
  const covered = new Set(cards.map(card => card.source).concat(cards.map(card => card.latest.branch)))
  const quiet = mine
    .filter(pr => !covered.has(pr.branch))
    .map(pr => ({ number: pr.number, title: pr.title, branch: pr.branch, isDraft: pr.isDraft }))
  return { cards: cards.sort(newestFirst), quiet }
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

function announce($: Engine, s: Snapshot, options: Options) {
  // Everyone's pull requests would be noise: with `all`, only the current branch speaks up.
  const prRuns = options.pullRequests === 'all' ? [] : s.prs.map(pr => pr.latest)
  const watched = [s.branchRuns[0], ...prRuns].filter((run): run is Run => run !== undefined)
  const quiet = isFirstRefresh
  isFirstRefresh = false
  for (const run of watched) {
    const verdict = verdictOf(run)
    const before = seen.get(run.runId)
    seen.set(run.runId, verdict)
    if (quiet) continue
    const where = run.branch ?? run.title
    if (before === undefined) {
      if (isActive(run) && run.branch !== null && run.branch === s.repo?.branch) {
        $.ui.toast(`● Tests started on ${where}: ${plural(run.specs.total, 'spec file')}`)
      }
      continue
    }
    if (before === 'running' && verdict === 'failing') {
      $.ui.toast(`● ${where} is failing: ${plural(failedCount(run.tests), 'test')} failed so far`, { timeoutMs: 8000 })
      continue
    }
    if ((before === 'running' || before === 'failing') && !isActive(run)) {
      const text = `${VERDICT[verdict].glyph} ${where} · ${outcomeSummary(run)} · ${plural(run.tests.total, 'test')} · ${duration(run.durationMs)}`
      $.ui.toast(text, { timeoutMs: 10_000 })
      if (options.notifications) void $.ui.notify(text, { title: 'Currents' }).catch(() => undefined)
    }
  }
}

// ---- Fix with Claude ----

/** Drafts the prompt in the person's box; where there is none, sends it; failing both, copies it. */
export async function fixWithClaude($: Engine, run: Run) {
  await ensureDetail($, run)
  const detail = (await read($, details))[run.runId]
  const text = fixPrompt(run, detail)
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
