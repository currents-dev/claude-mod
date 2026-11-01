// The values currents-ci keeps in `$.state`, and the shapes they hold.

/** A run's `status`, as the Currents API reports it. */
export type RunStatus = 'PASSED' | 'FAILED' | 'RUNNING' | 'FAILING'

/** A run's `completionState`, as the Currents API reports it. */
export type CompletionState = 'COMPLETE' | 'IN_PROGRESS' | 'CANCELED' | 'TIMEOUT'

/** One mark per run, in the dashboard's words: the pill a run gets. */
export type Verdict = 'passed' | 'failed' | 'running' | 'failing' | 'cancelled' | 'timedout'

/** Test outcomes summed over a run's groups, with the API's keys. */
export type TestCounts = {
  /** Tests scheduled, including those not reported yet. */
  total: number
  /** Tests with an outcome so far. */
  recorded: number
  passes: number
  failures: number
  /** Shown as Interrupted. */
  skipped: number
  /** Shown as Ignored. */
  pending: number
  /** A subset of `passes`. */
  flaky: number
}

export type Run = {
  runId: string
  projectId: string
  createdAt: string
  durationMs: number | null
  status: RunStatus
  completionState: CompletionState
  title: string
  branch: string | null
  sha: string | null
  author: string | null
  ciBuildId: string | null
  prNumber: string | null
  prLink: string | null
  /** The branch the run's pull request merges into. */
  prBase: string | null
  framework: string | null
  tags: string[]
  groups: number
  tests: TestCounts
  /** Spec files: `complete` of `total` finished, `claimed` started. */
  specs: { total: number; complete: number; claimed: number }
}

export type FailedTest = {
  key: string
  testId: string
  instanceId: string | null
  spec: string
  title: string[]
  isFlaky: boolean
  error: string | null
  location: string | null
  durationMs: number | null
}

export type SpecState = 'passed' | 'failed' | 'flaky' | 'running' | 'queued'

export type SpecRow = {
  instanceId: string
  spec: string
  group: string | null
  state: SpecState
  tests: number
  passes: number
  failures: number
  flaky: number
  durationMs: number | null
}

/** What the drawer shows below a run's header, fetched when it opens. */
export type RunDetail = {
  runId: string
  /** Fetched once the run had finished, so it never changes. */
  isFinal: boolean
  specs: SpecRow[]
  groups: string[]
  failed: FailedTest[]
  failedTotal: number
  flakyTotal: number
  error: string | null
}

/** A test's numbers over the branch's recent runs, from `currents-get-tests-performance`: a row of the Tests tab. */
export type TestStat = {
  title: string
  spec: string
  executions: number
  failures: number
  flaky: number
  /** A fraction: 0.12 is 12% of executions flaky. */
  flakinessRate: number
  avgDurationMs: number | null
  lastSeen: string | null
}

/** The current branch's pull request, as the GitHub CLI reports it. */
export type BranchPr = {
  number: string
  title: string
  url: string
  isDraft: boolean
  /** `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null without a review decision. */
  review: string | null
  /** The branch the PR merges into. */
  base: string | null
}

/**
 * Whether the session has a Currents MCP server to read from: the Currents
 * connector from the Claude directory, a server in the person's MCP config, or
 * the one this plugin ships.
 */
export type Connection =
  | { state: 'checking' }
  | { state: 'connected'; server: string }
  /**
   * None answers yet. `server` is the plugin's own when it waits for a sign-in
   * (null when the session has none to sign in to); `message` says why one
   * that worked stopped.
   */
  | { state: 'missing'; server: string | null; message: string | null }

export type Project = { projectId: string; name: string; defaultBranch: string | null }

export type Repo = {
  root: string
  branch: string | null
  sha: string | null
  /** `owner/name` from the origin remote. */
  slug: string | null
}

/** The current branch's test numbers, as the Tests tab lists them: flakiest or slowest first. */
export type BranchTests = {
  branch: string
  sort: TestSort
  /** When the list was read. */
  at: number
  list: TestStat[]
  error: string | null
}

export type TestSort = 'flakiness' | 'duration'

export type Snapshot = {
  connection: Connection
  repo: Repo | null
  project: Project | null
  /** Projects the repository names that the sign-in cannot see: another organization's. */
  unseen: string[]
  /** Every project the credential sees, for the picker. */
  projects: Project[]
  projectSource: 'picked' | 'repo' | 'remote' | 'only' | 'mine' | null
  /**
   * Newest first: the current branch's runs, or outside a repository
   * (`scope` `mine`) the runs whose commits carry the person's git name.
   */
  branchRuns: Run[]
  scope: 'branch' | 'mine'
  /** The default branch's newest run: the baseline the branch's failures are compared with. */
  baseRun: Run | null
  /** The current branch's pull request, when the GitHub CLI finds one. */
  pullRequest: BranchPr | null
  /** The Tests tab's list, for the branch, once the tab has been opened. */
  branchTests: BranchTests | null
  /** When this session last pushed the current branch. */
  pushedAt: number | null
  updatedAt: number | null
  isLoading: boolean
  error: string | null
  /**
   * The permission rules the band's reads wait on: set when the session refused
   * a read, or a refresh hung as on an approval nobody is shown; else empty.
   */
  allow: string[]
}

export type Tab = 'summary' | 'errors' | 'specs' | 'tests' | 'prs'

export type View = {
  /** The run the drawer shows; null follows the current branch's latest. */
  runId: string | null
  tab: Tab
  isPicking: boolean
  /** The Tests tab's order; an older view lacks it, and reads as flakiest. */
  testSort?: TestSort
}

declare module 'claude-code' {
  interface PluginState {
    'currents-ci': {
      snapshot: Snapshot
      details: Record<string, RunDetail>
      view: View
      bandHidden: boolean
    }
  }
}
