// Currents over MCP: finding the session's Currents server, and the calls the mod makes.

/** The plugin's own server: its key in plugin.json. */
export const SERVER_KEY = 'currents'

import type { EngineInterface } from 'claude-code'

import type { Connection, Project, PullRequest, Run, RunDetail } from '../types'
import { failedCount, listOf, toDetail, toPullRequest, toRun } from './model'

type Engine = EngineInterface

/** A tool every Currents MCP server has with `results:read`, which identifies one. */
const SIGNATURE = '__currents-get-runs'

export type FailureKind = 'auth' | 'scope' | 'rate' | 'network' | 'disconnected' | 'api'

export class CurrentsError extends Error {
  kind: FailureKind
  status: number | null

  constructor(message: string, kind: FailureKind, status: number | null = null) {
    super(message)
    this.name = 'CurrentsError'
    this.kind = kind
    this.status = status
  }
}

const tidy = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}

/** Reads what went wrong out of an MCP error result or a rejected call. */
export const classify = (text: string): CurrentsError => {
  const status = Number(/\bHTTP (\d{3})\b/.exec(text)?.[1] ?? Number.NaN)
  const code = Number.isFinite(status) ? status : null
  if (code === 401 || /needs you to sign in|needs auth|unauthori[sz]ed|re-?authenticate/i.test(text)) {
    return new CurrentsError('Currents needs you to sign in again.', 'auth', code)
  }
  if (code === 403 || /insufficient_scope|forbidden/i.test(text)) {
    return new CurrentsError('Your Currents role or sign-in does not allow reading these results.', 'scope', code)
  }
  if (code === 429) return new CurrentsError('Currents is rate limiting requests; slowing down.', 'rate', code)
  if (/not connected|disconnected|no (mcp )?server|unknown server|closed/i.test(text)) {
    return new CurrentsError('The Currents MCP server disconnected.', 'disconnected', code)
  }
  if (/fetch failed|ENOTFOUND|ECONNRE|ETIMEDOUT|timed? ?out|network/i.test(text)) {
    return new CurrentsError('Could not reach Currents.', 'network', code)
  }
  return new CurrentsError(tidy(text) || 'Currents returned an error.', 'api', code)
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    // A tool may lead with a sentence (a truncation note) before its JSON.
    const at = text.search(/[[{]/)
    if (at > 0) {
      try {
        return JSON.parse(text.slice(at))
      } catch {
        // fall through
      }
    }
    throw new CurrentsError('Currents sent a reply the mod could not read.', 'api')
  }
}

export async function callTool(
  $: Engine,
  server: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let result
  try {
    result = await $.mcp.call(server, tool, args)
  } catch (error) {
    throw classify(error instanceof Error ? error.message : String(error))
  }
  const text = result.content.map(block => (block.type === 'text' ? (block.text ?? '') : '')).join('\n')
  if (result.isError) throw classify(text)
  return parse(text)
}

/** MCP servers whose Currents tools the engine described this session (ToolSearch can keep them out of a list). */
const described = new Set<string>()

/** Notes a tool the engine described; true when it is a Currents server's. */
export const noteTool = (name: string): boolean => {
  if (!name.startsWith('mcp__') || !name.endsWith(SIGNATURE)) return false
  described.add(name.slice('mcp__'.length, -SIGNATURE.length))
  return true
}

export type Scan = { mcpTools: number; servers: string[]; found: string | null }

/** What the last look for a Currents server saw, for `/currents status`. */
export let lastScan: Scan = { mcpTools: 0, servers: [], found: null }

/**
 * A Currents MCP server the session has: the Currents connector from the Claude
 * directory, a server in the person's MCP config, or this plugin's own. Their
 * tools carry the names every Currents server gives them, whatever the server
 * is called. Else connects the plugin's own, which may wait for a sign-in.
 */
export async function discover($: Engine): Promise<Connection> {
  const tools = await $.tool.list().catch(() => [])
  const mcp = tools.filter(tool => tool.mcp).map(tool => tool.name)
  for (const name of mcp) noteTool(name)
  const servers = [...new Set(mcp.map(name => name.split('__')[1] ?? ''))].filter(Boolean)
  // The person's own connection (the connector, their config) before the plugin's.
  const mine = `plugin_${$.plugin.name}_${SERVER_KEY}`
  const found = [...described].sort((a, b) => Number(a === mine) - Number(b === mine))[0] ?? null
  lastScan = { mcpTools: mcp.length, servers, found }
  if (found !== null) return { state: 'connected', server: found }

  const own = await $.mcp.connect(SERVER_KEY).catch(error => ({
    isConnected: false as const,
    reason: 'failed' as const,
    message: error instanceof Error ? error.message : String(error),
  }))
  if (own.isConnected) {
    lastScan = { ...lastScan, found: own.server }
    return { state: 'connected', server: own.server }
  }
  const server = /"([^"]+)"/.exec(own.message)?.[1] ?? `plugin:${$.plugin.name}:${SERVER_KEY}`
  return { state: 'missing', server: own.reason === 'auth' ? server : null, message: null }
}

/** Forgets a server that stopped answering, so the next look finds another or none. */
export const forget = (server: string) => {
  described.delete(server)
}

// ---- Calls ----

export async function fetchProjects($: Engine, server: string): Promise<Project[]> {
  return listOf(await callTool($, server, 'currents-get-projects', { limit: 50 }))
    .map(item => item as { projectId?: unknown; name?: unknown; defaultBranchName?: unknown })
    .filter(item => typeof item.projectId === 'string')
    .map(item => ({
      projectId: item.projectId as string,
      name: typeof item.name === 'string' ? item.name : (item.projectId as string),
      defaultBranch: typeof item.defaultBranchName === 'string' ? item.defaultBranchName : null,
    }))
}

/** A project's newest runs among those the filter keeps: a branch's, or an author's. */
export async function fetchRuns(
  $: Engine,
  server: string,
  projectId: string,
  filter: { branches?: string[]; authors?: string[] },
): Promise<Run[]> {
  return listOf(await callTool($, server, 'currents-get-runs', { projectId, limit: 12, ...filter }))
    .map(toRun)
    .filter(run => run.runId !== '')
}

export type PrFilter = { branches?: string[]; authors?: string[] }

export async function fetchPullRequests(
  $: Engine,
  server: string,
  projectId: string,
  filter: PrFilter,
): Promise<PullRequest[]> {
  const body = await callTool($, server, 'currents-list-pull-requests', {
    projectId,
    limit: 25,
    runs_per_pr: 1,
    ...filter,
  })
  return listOf(body)
    .map(toPullRequest)
    .filter(pr => pr.id !== '' && pr.latest.runId !== '')
}

/** A project's newest run, any state, among those the filter keeps. */
export async function fetchLatestRun(
  $: Engine,
  server: string,
  projectId: string,
  filter: { branches?: string[]; authors?: string[]; search?: string },
): Promise<Run | null> {
  const runs = listOf(await callTool($, server, 'currents-get-runs', { projectId, limit: 1, ...filter }))
  return runs.length === 0 ? null : toRun(runs[0])
}

export async function fetchDetail($: Engine, server: string, run: Run): Promise<RunDetail> {
  const body = await callTool($, server, 'currents-get-run-details', { runId: run.runId })
  const hasProblems = failedCount(run.tests) > 0 || run.tests.flaky > 0 || run.status === 'FAILED'
  const context = hasProblems
    ? await callTool($, server, 'currents-get-context', {
        run_id: run.runId,
        format: 'json',
        detail: 'compact',
        limit: 15,
        include_flaky: true,
      }).catch(() => null)
    : null
  return toDetail(body, context)
}
