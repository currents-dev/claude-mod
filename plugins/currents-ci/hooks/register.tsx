import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'
import type { Tab, View } from '../types'

import {
  ensureDetail,
  ensureLoop,
  fixWithClaude,
  openSignIn,
  markPushed,
  pickProject,
  refresh,
  retry,
  schedule,
  shownRun,
  type Options,
} from './controller'
import { lastScan, noteTool } from './currents'
import { duration, outcomeSummary, VERDICT, verdictOf } from './model'
import { EMPTY, FIRST_VIEW, NO_DETAILS, PANE, normalize } from './state'
import { CLAUDE_DIRECTORY, drawBand, drawPane, type Actions } from './views'

const snapshot = atom({ plugin: 'currents-ci', key: 'snapshot' } as const, EMPTY)
const details = atom({ plugin: 'currents-ci', key: 'details' } as const, NO_DETAILS)
const view = atom({ plugin: 'currents-ci', key: 'view' } as const, FIRST_VIEW)
const bandHidden = atom({ plugin: 'currents-ci', key: 'bandHidden' } as const, false)

type Engine = EngineInterface

/** Work a press or a hook starts and does not wait on: its failure is the next refresh's to report. */
const quietly = (work: Promise<unknown>) => work.catch(() => undefined)

/** A command that publishes the branch, after which CI starts a run. */
const PUSH = /\bgit\s+(?:-\S+\s+)*push\b|\bgh\s+pr\s+(?:create|ready)\b/

async function openPane($: Engine) {
  const opened = await $.ui.open({ id: PANE, title: 'Currents', columns: 76, rows: 24 })
  void quietly(ensureDetail($, shownRun(normalize(await read($, snapshot)), await read($, view))))
  return opened
}

async function toggleBand($: Engine) {
  const hidden = await update($, bandHidden, isHidden => !isHidden)
  await $.store.set('bandHidden', hidden)
  return hidden
}

async function selectRun($: Engine, runId: string | null) {
  const v = await update($, view, (current): View => ({
    ...current,
    runId,
    tab: current.tab === 'prs' ? 'summary' : current.tab,
  }))
  await ensureDetail($, shownRun(normalize(await read($, snapshot)), v))
}

async function selectTab($: Engine, tab: Tab) {
  const v = await update($, view, (current): View => ({ ...current, tab }))
  await ensureDetail($, shownRun(normalize(await read($, snapshot)), v))
}

/** One line for a command's reply. */
async function statusLine($: Engine) {
  const s = normalize(await read($, snapshot))
  const run = s.branchRuns[0]
  if (s.error !== null && s.updatedAt === null) {
    const rules = s.allow.length > 0 ? ` Allow the band's reads under "permissions" → "allow": ${s.allow.join(', ')}` : ''
    return `Currents: ${s.error}${rules}`
  }
  if (s.connection.state === 'checking') return 'Currents is still loading.'
  if (s.connection.state !== 'connected') {
    return `Currents is not connected. Add the Currents connector (${CLAUDE_DIRECTORY}) and turn it on for this session.`
  }
  if (s.project === null && s.unseen.length > 0) {
    return `Your Currents sign-in can't see ${s.unseen.join(', ')}, which this repository records to: sign in again in /mcp and pick its organization, or choose a project with /currents project.`
  }
  if (s.project === null) return 'Choose the project with /currents project.'
  if (run === undefined) return `No Currents runs on ${s.repo?.branch ?? 'this branch'} in ${s.project.name} yet.`
  return `${VERDICT[verdictOf(run)].glyph} ${run.branch ?? run.title}: ${outcomeSummary(run)} · ${duration(run.durationMs)}`
}

/** What the band's and the drawer's controls do. */
function actionsFor($: Engine, settings: Options): Actions {
  return {
    open: () => void quietly(openPane($)),
    signIn: surface => void quietly(openSignIn($, surface)),
    retry: () => void quietly(retry($, settings)),
    refresh: () => void quietly(refresh($, settings).then(() => schedule($, settings))),
    toggleBand: () => void quietly(toggleBand($)),
    fix: run => void quietly(fixWithClaude($, run)),
    select: runId => void quietly(selectRun($, runId)),
    tab: tab => void quietly(selectTab($, tab)),
    pick: project => void quietly(pickProject($, settings, project)),
    picking: isPicking => void quietly(update($, view, (v): View => ({ ...v, isPicking }))),
    copy: (text, surface) => void quietly(copyRules($, text, surface)),
  }
}

async function copyRules($: Engine, text: string, surface: RenderSurface) {
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(
    copied.isCopied
      ? 'Copied the rules: paste them under "permissions" → "allow" in ~/.claude/settings.json.'
      : 'Could not copy: the rules are in the Currents drawer.',
  )
}

export const register: Register = (on, options) => {
  const settings: Options = {
    notifications: options.notifications !== false,
    pullRequests: options.pullRequests === 'all' ? 'all' : 'mine',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'currents',
      description: 'Currents test runs for this branch and your PRs',
      argumentHint: '[refresh | connect | project | band | status]',
      immediate: true,
    })
    const hidden = await $.store.get('bandHidden')
    if (typeof hidden === 'boolean') await update($, bandHidden, () => hidden)
    ensureLoop($, settings)
    return next(e)
  })

  on('command.run', { command: 'currents' }, async ($, e) => {
    ensureLoop($, settings)
    const arg = e.args.trim().toLowerCase()
    if (arg === 'refresh') {
      await refresh($, settings)
      await schedule($, settings)
      return { text: await statusLine($) }
    }
    if (arg === 'connect' || arg === 'login') {
      await retry($, settings)
      const { connection } = await read($, snapshot)
      if (connection.state === 'connected') return { text: `Currents is connected (${connection.server}).` }
      await openPane($)
      return {
        text: `Add Currents to Claude at ${CLAUDE_DIRECTORY} (Connect to Claude), then turn it on for this session. The band picks it up within 20 seconds.`,
      }
    }
    if (arg === 'status') {
      const s = await read($, snapshot)
      const lines = [
        await statusLine($),
        `Connection: ${s.connection.state === 'connected' ? `via ${s.connection.server}` : s.connection.state}`,
        `MCP tools seen: ${lastScan.mcpTools} from ${lastScan.servers.length} servers${lastScan.servers.length > 0 ? ` (${lastScan.servers.join(', ')})` : ''}`,
        `Project: ${s.project ? `${s.project.name} (${s.project.projectId}), ${s.projectSource}` : 'none'}`,
        `Repository: ${s.repo ? `${s.repo.slug ?? s.repo.root} on ${s.repo.branch ?? 'detached HEAD'}` : 'none'}`,
        s.error ? `Last error: ${s.error}` : null,
      ]
      return { text: lines.filter(Boolean).join('\n') }
    }
    if (arg === 'project') {
      await update($, view, (v): View => ({ ...v, isPicking: true }))
      await openPane($)
      return { text: 'Choose the project in the Currents drawer.' }
    }
    if (arg === 'band') {
      const hidden = await toggleBand($)
      return { text: hidden ? 'Currents band hidden. /currents band shows it again.' : 'Currents band shown.' }
    }
    const opened = await openPane($)
    return {
      text: opened.isPlaced ? await statusLine($) : `The Currents drawer is open but not drawn: ${opened.reason}`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = normalize(await read($, snapshot))
    const v = await read($, view)
    const all = await read($, details)
    const run = shownRun(s, v)
    return drawPane($.ui.resolve(e), {
      s,
      v,
      detail: run === null ? undefined : all[run.runId],
      now: await $.clock.now(),
      width: e.props.bodyColumns,
      surface: e.surface,
      isBandHidden: await read($, bandHidden),
      actions: actionsFor($, settings),
    })
  })

  // A drawing only reads. The loop starts from session.start, which a reload
  // runs again, or from the next prompt or command.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, bandHidden))) return next(e)
    const s = normalize(await read($, snapshot))
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    let tree
    try {
      tree = drawBand($.ui.resolve(e), s, now, e.props.bodyColumns, actionsFor($, settings))
    } catch (error) {
      // A band that fails to draw says so rather than vanishing.
      tree = <Text color="warning">{`Currents: the band could not draw (${error instanceof Error ? error.message : String(error)})`}</Text>
    }
    if (tree === null) return next(e)
    return (
      <Box flexDirection="column">
        {tree}
        {await next(e)}
      </Box>
    )
  })

  // The engine describes each tool it lists, deferred MCP tools included: the
  // Currents connector shows up here the turn after it is turned on.
  // Any prompt also starts the loop, should nothing have yet.
  on('prompt.submit', async ($, e, next) => {
    ensureLoop($, settings)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.describe', async ($, e, next) => {
    ensureLoop($, settings)
    if (noteTool(e.tool) && (await read($, snapshot)).connection.state !== 'connected') {
      void quietly(retry($, settings))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Watches, never judges: a push makes the band wait for the run it starts.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    const command = typeof e.command === 'string' ? e.command : ''
    if (PUSH.test(command) && !('deny' in result)) void quietly(markPushed($, settings))
    return result
  }).catch(($, e, next) => next(e))
}
