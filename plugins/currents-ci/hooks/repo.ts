// The working copy: its branch, the branch's pull request, and which Currents project it records to.

import type { EngineInterface } from 'claude-code'

import type { BranchPr, Project, Repo, Run } from '../types'

type Engine = EngineInterface

async function run($: Engine, argv: string[], cwd: string, timeoutMs = 10_000) {
  try {
    const result = await $.process.run(argv, { cwd, timeoutMs })
    return result.exitCode === 0 ? result.stdout.trim() : null
  } catch {
    return null
  }
}

/** `git@github.com:org/repo.git`, `https://github.com/org/repo` → `org/repo`. */
export const slugOf = (remote: string | null): string | null => {
  if (remote === null) return null
  const found = /[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote.trim())
  return found?.[1]?.toLowerCase() ?? null
}

export async function readRepo($: Engine, cwd: string): Promise<Repo | null> {
  const top = await run($, ['git', 'rev-parse', '--show-toplevel', 'HEAD'], cwd)
  if (top === null) return null
  const [root, sha] = top.split('\n').map(line => line.trim())
  if (!root) return null
  const [branch, remote] = await Promise.all([
    run($, ['git', 'branch', '--show-current'], root),
    run($, ['git', 'remote', 'get-url', 'origin'], root),
  ])
  return { root, branch: branch || null, sha: sha || null, slug: slugOf(remote) }
}

/**
 * The pull request of the checked-out branch, from the GitHub CLI: null when the
 * branch has none, or there is no GitHub CLI.
 */
export async function prOfBranch($: Engine, root: string): Promise<BranchPr | null> {
  const out = await run($, ['gh', 'pr', 'view', '--json', 'number,title,url,isDraft,reviewDecision,baseRefName'], root, 20_000)
  if (out === null) return null
  try {
    const pr = JSON.parse(out) as {
      number: number
      title: string
      url: string
      isDraft: boolean
      reviewDecision: string | null
      baseRefName: string | null
    }
    return {
      number: String(pr.number),
      title: pr.title,
      url: pr.url,
      isDraft: pr.isDraft,
      review: pr.reviewDecision || null,
      base: pr.baseRefName || null,
    }
  } catch {
    return null
  }
}

export async function gitUserName($: Engine, root: string) {
  return run($, ['git', 'config', 'user.name'], root)
}

const PROJECT_ID = /^[A-Za-z0-9]{6}$/

export type NamedProject = { projectId: string; count: number }

/**
 * Project ids the repository names: `projectId` in a `currents.config.*`, and
 * `CURRENTS_PROJECT_ID` in a CI workflow, each with how often. Most-used first.
 */
export async function projectIdsInRepo($: Engine, root: string): Promise<NamedProject[]> {
  const out = await run(
    $,
    [
      'git',
      'grep',
      '-h',
      '-I',
      '-E',
      '--no-color',
      `(projectId|CURRENTS_PROJECT_ID)["']?[[:space:]]*[:=][[:space:]]*["']?[A-Za-z0-9]{6}["']?`,
      '--',
      '*currents.config.*',
      '.github/workflows/*',
      '.gitlab-ci.yml',
      '.circleci/*',
      'package.json',
    ],
    root,
  )
  if (out === null) return []
  const counts = new Map<string, number>()
  for (const line of out.split('\n')) {
    const id = /(?:projectId|CURRENTS_PROJECT_ID)["']?\s*[:=]\s*["']?([A-Za-z0-9]{6})\b/.exec(line)?.[1]
    if (id !== undefined && PROJECT_ID.test(id)) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([projectId, count]) => ({ projectId, count }))
}

/** The candidate whose newest run is newest: the project this repository records to most actively. */
export const mostRecent = (latest: { project: Project; run: Run | null }[]): Project | null => {
  const ranked = latest
    .filter(entry => entry.run !== null)
    .sort((a, b) => Date.parse(b.run?.createdAt ?? '') - Date.parse(a.run?.createdAt ?? ''))
  return ranked[0]?.project ?? null
}
