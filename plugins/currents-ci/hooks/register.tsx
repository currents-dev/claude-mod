import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'
import type { FailedTest, Tab, TestSort, View } from '../types'

import {
  ensureBranchTests,
  ensureDetail,
  ensureLoop,
  fixTestsWithClaude,
  fixWithClaude,
  markPushed,
  openSignIn,
  pickProject,
  refresh,
  retry,
  schedule,
  shareReport,
  shownRun,
  type Options,
} from './controller'
import { lastScan, noteTool } from './currents'
import { duration, outcomeSummary, VERDICT, verdictOf } from './model'
import { EMPTY, FIRST_VIEW, NO_DETAILS, PANE, normalize } from './state'
import { CLAUDE_DIRECTORY, drawBand, drawPane, pullRequestOf, type Actions } from './views'

const snapshot = atom({ plugin: 'currents-ci', key: 'snapshot' } as const, EMPTY)
const details = atom({ plugin: 'currents-ci', key: 'details' } as const, NO_DETAILS)
const view = atom({ plugin: 'currents-ci', key: 'view' } as const, FIRST_VIEW)
const bandHidden = atom({ plugin: 'currents-ci', key: 'bandHidden' } as const, false)

type Engine = EngineInterface

/** Work a press or a hook starts and does not wait on: its failure is the next refresh's to report. */
const quietly = (work: Promise<unknown>) => work.catch(() => undefined)

/** A command that publishes the branch, after which CI starts a run. */
const PUSH = /\bgit\s+(?:-\S+\s+)*push\b|\bgh\s+pr\s+(?:create|ready)\b/

/** Opens the drawer: at the project picker with `isPicking`, else at the run, even where the picker was left open. */
async function openPane($: Engine, isPicking = false) {
  await update($, view, (v): View => ({ ...v, isPicking }))
  const opened = await $.ui.open({ id: PANE, title: 'Currents', columns: 76, rows: 24 })
  void quietly(ensureDetail($, shownRun(normalize(await read($, snapshot)), await read($, view))))
  return opened
}

/** Hides or shows the band; `everywhere` keeps the choice for later sessions. */
async function setBandHidden($: Engine, hidden: boolean, everywhere: boolean) {
  await update($, bandHidden, () => hidden)
  if (everywhere) await $.store.set('bandHidden', hidden)
}

// A desktop draws the × as its native close control: closing reads as "not
// now", so it lasts the session, and says how to undo it.
async function dismissBand($: Engine) {
  await setBandHidden($, true, false)
  $.ui.toast('Currents band hidden for this session. /currents band brings it back.')
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
  if (tab === 'tests') await ensureBranchTests($, v.testSort ?? 'flakiness')
}

async function selectSort($: Engine, testSort: TestSort) {
  await update($, view, (current): View => ({ ...current, testSort }))
  await ensureBranchTests($, testSort)
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
    choose: () => void quietly(openPane($, true)),
    signIn: surface => void quietly(openSignIn($, surface)),
    retry: () => void quietly(retry($, settings)),
    refresh: () => void quietly(refresh($, settings).then(() => schedule($, settings))),
    hideBand: () => void quietly(dismissBand($)),
    showBand: () => void quietly(setBandHidden($, false, true)),
    fix: run => void quietly(fixWithClaude($, run)),
    fixTests: () => void quietly(fixTestsWithClaude($)),
    share: run => void quietly(shareReport($, { run_id: run.runId }, 'this run')),
    shareTest: (test: FailedTest) => {
      if (test.instanceId === null) return
      const what = `the failing test ${[test.spec, ...test.title].filter(Boolean).join(' › ')}`
      void quietly(shareReport($, { instance_id: test.instanceId, test_id: test.testId }, what))
    },
    select: runId => void quietly(selectRun($, runId)),
    tab: tab => void quietly(selectTab($, tab)),
    testSort: sort => void quietly(selectSort($, sort)),
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
  const settings: Options = { notifications: options.notifications !== false }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'currents',
      description: "Currents test runs for this branch and its pull request",
      argumentHint: '[refresh | connect | project | band | share | status]',
      immediate: true,
    })
    const hidden = await $.store.get('bandHidden')
    if (typeof hidden === 'boolean') await update($, bandHidden, () => hidden)
    ensureLoop($, settings)
    const started = await next(e)
    // A reload runs this again before the new code has drawn anything, so the
    // refresh's writes have no drawing to redraw until a surface next asks.
    $.ui.invalidate('ui.render')
    return started
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
      const s = normalize(await read($, snapshot))
      const pr = pullRequestOf(s)
      const lines = [
        await statusLine($),
        `Connection: ${s.connection.state === 'connected' ? `via ${s.connection.server}` : s.connection.state}`,
        `MCP tools seen: ${lastScan.mcpTools} from ${lastScan.servers.length} servers${lastScan.servers.length > 0 ? ` (${lastScan.servers.join(', ')})` : ''}`,
        `Project: ${s.project ? `${s.project.name} (${s.project.projectId}), ${s.projectSource}` : 'none'}`,
        `Repository: ${s.repo ? `${s.repo.slug ?? s.repo.root} on ${s.repo.branch ?? 'detached HEAD'}` : 'none'}`,
        `Pull request: ${pr ? `#${pr.number} ${pr.title ?? ''}${pr.isDraft ? ' (draft)' : ''}` : 'none found (the GitHub CLI reads the branch\'s pull request)'}`,
        s.error ? `Last error: ${s.error}` : null,
      ]
      return { text: lines.filter(Boolean).join('\n') }
    }
    if (arg === 'share') {
      const s = normalize(await read($, snapshot))
      const run = s.branchRuns[0] ?? s.baseRun
      if (run === null) return { text: 'No Currents run to share yet.' }
      const link = await shareReport($, { run_id: run.runId }, 'this run')
      return {
        text: link === null ? 'The link could not be made: see the message above.' : `Link to this run (anyone with it can open it until it expires): ${link}`,
      }
    }
    if (arg === 'project') {
      await openPane($, true)
      return { text: 'Choose the project in the Currents drawer.' }
    }
    if (arg === 'band') {
      const hidden = !(await read($, bandHidden))
      await setBandHidden($, hidden, true)
      return {
        text: hidden ? 'Currents band hidden in every session. /currents band shows it again.' : 'Currents band shown.',
      }
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
      all,
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
    const all = await read($, details)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    let tree
    try {
      tree = drawBand($.ui.resolve(e), s, all, now, e.props.bodyColumns, actionsFor($, settings))
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
