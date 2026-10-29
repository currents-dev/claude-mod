// What the band above the prompt and the drawer draw, from a snapshot. No `$` here: the hooks pass the actions in.

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { FailedTest, Project, PullRequest, Run, RunDetail, Snapshot, SpecRow, Tab, View } from '../types'
import { isAwaitingRun, shownRun } from './controller'
import {
  COUNTER,
  VERDICT,
  ago,
  branchRunsUrl,
  clip,
  duration,
  elapsed,
  failedCount,
  failedTestsUrl,
  isActive,
  outcomeSummary,
  passRate,
  plural,
  pullRequestsUrl,
  runUrl,
  shortSha,
  testUrl,
  verdictOf,
} from './model'
import { historyBars, outcomeSegments, progressSegments, runDots, stackedBar, textBar, type Segment } from './svg'

export type Ui = Elements[RenderSurface]

export type Actions = {
  open: () => void
  signIn: (surface: RenderSurface) => void
  retry: () => void
  refresh: () => void
  toggleBand: () => void
  fix: (run: Run) => void
  select: (runId: string | null) => void
  tab: (tab: Tab) => void
  pick: (project: Project) => void
  picking: (isPicking: boolean) => void
}

export const CLAUDE_DIRECTORY = 'https://claude.ai/directory/currents'

/** CSS pixels per cell on a surface that draws SVG, for sizing a chart to the pane. */
const CELL_PX = 7.5

type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean; drop?: number }

/** Drops the least important segments (highest `drop`) until the text fits. */
export const fit = (segs: Seg[], budget: number): Seg[] => {
  const list = [...segs]
  const size = () => list.reduce((n, seg) => n + seg.text.length, 0)
  while (size() > budget) {
    let worst = -1
    list.forEach((seg, index) => {
      if ((seg.drop ?? 0) > 0 && (worst < 0 || (seg.drop ?? 0) >= (list[worst]?.drop ?? 0))) worst = index
    })
    if (worst < 0) break
    list.splice(worst, 1)
  }
  return list
}

const style = (seg: Seg) => ({
  ...(seg.color ? { color: seg.color } : {}),
  ...(seg.bold ? { bold: true } : {}),
  ...(seg.dim ? { dimColor: true } : {}),
})

const spans = (ui: Ui, segs: Seg[]) =>
  segs.map(seg => (seg.color || seg.bold || seg.dim ? <ui.Text {...style(seg)}>{seg.text}</ui.Text> : seg.text))

/** Columns a row of buttons takes on the terminal: `[ label ]`, a space between. */
const buttonCells = (labels: string[]) => labels.reduce((n, label) => n + label.length + 5, 0)

const verdictSeg = (run: Pick<Run, 'status' | 'completionState'>): Seg => {
  const meta = VERDICT[verdictOf(run)]
  return { text: `${meta.glyph} `, color: meta.color }
}

/** `✓2 ✗1 ●1` over pull requests' latest runs. */
const tally = (prs: PullRequest[]): Seg[] => {
  const counts = { passed: 0, failed: 0, active: 0, other: 0 }
  for (const pr of prs) {
    const verdict = verdictOf(pr.latest)
    if (verdict === 'passed') counts.passed += 1
    else if (verdict === 'failed' || verdict === 'timedout') counts.failed += 1
    else if (verdict === 'running' || verdict === 'failing') counts.active += 1
    else counts.other += 1
  }
  const segs: Seg[] = []
  if (counts.passed > 0) segs.push({ text: ` ✓${counts.passed}`, color: 'success', drop: 5 })
  if (counts.failed > 0) segs.push({ text: ` ✗${counts.failed}`, color: 'error', drop: 5 })
  if (counts.active > 0) segs.push({ text: ` ●${counts.active}`, color: 'suggestion', drop: 5 })
  if (counts.other > 0) segs.push({ text: ` ⊘${counts.other}`, color: 'inactive', drop: 5 })
  return segs
}

const otherPrs = (s: Snapshot) => {
  const branch = s.repo?.branch ?? null
  return s.prs.filter(pr => pr.source !== branch && pr.latest.branch !== branch)
}

// ---- The band ----

export const drawBand = (ui: Ui, s: Snapshot, now: number, width: number, actions: Actions): RenderElement | null => {
  const { Box, Button } = ui
  const Svg = 'Svg' in ui ? ui.Svg : null
  const hide = <Button key="hide" plain dimColor role="dismiss" label="×" onPress={actions.toggleBand} />
  const brand: Seg = { text: 'Currents', color: 'claude', bold: true }

  const row = (segs: Seg[], buttons: { labels: string[]; nodes: RenderElement[] }, chart: RenderElement | null = null) => {
    const budget = Math.max(12, width - buttonCells(buttons.labels) - 2 - (chart === null ? 0 : 12))
    return (
      <Box flexDirection="row" columnGap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <ui.Text wrap="truncate-end">{spans(ui, fit(segs, budget))}</ui.Text>
        </Box>
        {chart}
        <Box flexShrink={0} columnGap={1}>
          {buttons.nodes}
          {hide}
        </Box>
      </Box>
    )
  }

  const c = s.connection
  switch (c.state) {
    case 'checking':
      return null
    case 'missing': {
      // The first part stays, cut short if it must; the hint goes first when there is no room.
      const text: Seg[] =
        c.message !== null
          ? [{ text: ` · ${c.message}`, color: 'warning' }]
          : c.server !== null
            ? [
                { text: ' · Sign in to see your test runs', dim: true },
                { text: ' · signed in already? Reconnect currents in /mcp', dim: true, drop: 1 },
              ]
            : [{ text: ' · Connect Currents to see your test runs', dim: true }]
      // The plugin's own server signs in inside this session; without one, the connector is the way in.
      return c.server !== null
        ? row([brand, ...text], {
            labels: ['Sign in', 'Setup'],
            nodes: [
              <Button key="sign-in" variant="primary" label="Sign in" onPress={press => actions.signIn(press.surface)} />,
              <Button key="setup" label="Setup" onPress={actions.open} />,
            ],
          })
        : row([brand, ...text], {
            labels: ['Add to Claude ↗', 'Setup'],
            nodes: [
              <ui.Link href={CLAUDE_DIRECTORY} label="Add to Claude ↗" />,
              <Button key="setup" label="Setup" onPress={actions.open} />,
            ],
          })
    }
    case 'connected':
      break
  }

  if (s.project === null) {
    if (s.updatedAt === null) return row([brand, { text: ' · loading…', dim: true }], { labels: [], nodes: [] })
    if (s.unseen.length > 0) {
      // Signed in to another organization than the one the repository records to.
      return row(
        [
          brand,
          { text: ` · your sign-in can't see ${s.unseen.slice(0, 2).join(', ')}`, color: 'warning' },
          { text: ', which this repository records to · sign in again and pick its organization', dim: true, drop: 1 },
        ],
        {
          labels: ['Sign in again', 'Choose'],
          nodes: [
            <Button key="sign-in" variant="primary" label="Sign in again" onPress={press => actions.signIn(press.surface)} />,
            <Button
              key="choose"
              label="Choose"
              onPress={() => {
                actions.picking(true)
                actions.open()
              }}
            />,
          ],
        },
      )
    }
    const ask = s.repo === null ? ' · Choose your Currents project' : ' · Choose the Currents project this repository records to'
    return row([brand, { text: ask, dim: true }], {
      labels: ['Choose'],
      nodes: [
        <Button
          key="choose"
          label="Choose"
          onPress={() => {
            actions.picking(true)
            actions.open()
          }}
        />,
      ],
    })
  }

  if (s.error !== null && s.updatedAt === null) {
    return row([brand, { text: ` · ${s.error}`, color: 'warning' }], {
      labels: ['Retry'],
      nodes: [<Button key="retry" label="Retry" onPress={actions.retry} />],
    })
  }

  const branch = s.repo?.branch ?? null
  const latest = s.branchRuns[0]
  const segs: Seg[] = []
  let chart: RenderElement | null = null
  // Outside a repository the run is the person's latest, which says where it ran.
  const lead: Seg =
    s.scope === 'mine'
      ? { text: `Currents · ${s.project.name} · your last run · `, color: 'claude', drop: 6 }
      : { text: 'Currents · ', color: 'claude', drop: 6 }

  if (branch !== null && isAwaitingRun(s, now)) {
    segs.push({ text: '◌ ', color: 'suggestion' }, lead, { text: clip(branch, 40), bold: true })
    segs.push({ text: ` · pushed ${ago(s.pushedAt ?? now, now)}, waiting for its run to start`, dim: true, drop: 1 })
    if (latest !== undefined) {
      segs.push({ text: ` · last run ${VERDICT[verdictOf(latest)].glyph} ${outcomeSummary(latest)}`, dim: true, drop: 3 })
    }
  } else if (latest !== undefined) {
    const meta = VERDICT[verdictOf(latest)]
    segs.push(verdictSeg(latest), lead, { text: clip(branch ?? latest.branch ?? latest.title, 40), bold: true })
    segs.push({ text: ' · ' }, { text: outcomeSummary(latest), color: meta.color, bold: true })
    if (isActive(latest)) {
      if (latest.specs.total > 0) {
        segs.push({ text: ` · ${latest.specs.complete}/${latest.specs.total} spec files`, dim: true, drop: 2 })
      }
      segs.push({ text: ` · ${duration(elapsed(latest, now))}`, dim: true, drop: 3 })
      if (Svg !== null && latest.specs.total > 0) {
        chart = <Svg source={stackedBar(progressSegments(latest), latest.specs.total, 72, 6)} alt="Spec file progress" width={72} height={6} />
      }
    } else {
      if (latest.tests.total > 0) segs.push({ text: ` · ${plural(latest.tests.total, 'test')}`, dim: true, drop: 4 })
      segs.push({ text: ` · ${duration(latest.durationMs)}`, dim: true, drop: 3 })
      segs.push({ text: ` · ${ago(latest.createdAt, now)}`, dim: true, drop: 2 })
    }
  } else if (s.scope === 'mine') {
    segs.push({ text: '○ ', color: 'inactive' }, { text: 'Currents', color: 'claude', bold: true })
    segs.push({ text: ` · no runs of yours in ${s.project.name} yet`, dim: true, drop: 1 })
  } else {
    segs.push({ text: '○ ', color: 'inactive' }, lead, { text: clip(branch ?? 'detached HEAD', 40), bold: true })
    segs.push({ text: ' · no runs yet', dim: true, drop: 1 })
    if (s.baseRun !== null) {
      const base = s.baseRun
      const meta = VERDICT[verdictOf(base)]
      segs.push(
        { text: ` · ${base.branch ?? 'default branch'} `, dim: true, drop: 2 },
        { text: `${meta.glyph} ${outcomeSummary(base)}`, color: meta.color, drop: 2 },
        { text: ` ${ago(base.createdAt, now)}`, dim: true, drop: 3 },
      )
    }
  }

  const others = otherPrs(s)
  if (others.length > 0) {
    segs.push({ text: `   ${plural(others.length, 'other PR')}`, dim: true, drop: 5 }, ...tally(others))
  }

  const labels: string[] = []
  const nodes: RenderElement[] = []
  if (latest !== undefined && failedCount(latest.tests) > 0 && !isAwaitingRun(s, now)) {
    labels.push('Fix with Claude')
    nodes.push(<Button key="fix" label="Fix with Claude" onPress={() => actions.fix(latest)} />)
  }
  labels.push('Open')
  nodes.push(<Button key="open" label="Open" onPress={actions.open} />)
  return row(segs, { labels, nodes }, chart)
}

// ---- The drawer ----

export type PaneInput = {
  s: Snapshot
  v: View
  detail: RunDetail | undefined
  now: number
  width: number
  surface: RenderSurface
  isBandHidden: boolean
  actions: Actions
}

export const drawPane = (ui: Ui, input: PaneInput): RenderElement => {
  const { Box, Text, Button } = ui
  const { s, v, actions } = input
  const c = s.connection

  const header = (
    <Box flexDirection="row" justifyContent="space-between">
      <Text>
        <Text color="claude" bold>
          ◆ Currents
        </Text>
        {s.project !== null && <Text dimColor>{` · ${s.project.name}`}</Text>}
      </Text>
      {c.state === 'connected' && (
        <Box columnGap={1}>
          <Button key="refresh" plain dimColor label={s.isLoading ? 'Refreshing…' : '↻ Refresh'} onPress={actions.refresh} />
          {s.projects.length > 1 && (
            <Button key="change-project" plain dimColor label="Change project" onPress={() => actions.picking(!v.isPicking)} />
          )}
        </Box>
      )}
    </Box>
  )

  let body: RenderElement
  if (c.state !== 'connected') body = drawConnect(ui, s, input.surface, actions)
  else if (v.isPicking || s.project === null) body = drawPicker(ui, s, actions)
  else body = drawRunView(ui, input)

  return (
    <Box flexDirection="column" rowGap={1}>
      {header}
      {body}
      {drawFooter(ui, input)}
    </Box>
  )
}

const ADD_SERVER = 'claude mcp add --transport http --scope user currents https://mcp.currents.dev/mcp'

const drawConnect = (ui: Ui, s: Snapshot, surface: RenderSurface, actions: Actions): RenderElement => {
  const { Box, Text, Button, Link, Code } = ui
  const c = s.connection
  if (c.state === 'checking') return <Text dimColor>Looking for a Currents connection…</Text>
  const server = c.state === 'missing' ? c.server : null
  const how =
    surface === 'terminal'
      ? 'Sign in opens the /mcp dialog.'
      : "Sign in drafts /mcp in the prompt box: press Enter to open this session's MCP servers (also under Connectors in the session sidebar)."
  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold>Connect Currents to see every run of your branch and pull requests here.</Text>
      {c.state === 'missing' && c.message !== null && <Text color="warning">{c.message}</Text>}
      {server !== null && (
        <Box flexDirection="column">
          <Text>
            <Text bold>Sign in here. </Text>
            {`${how} Choose ${server}, sign in with your Currents account, and pick the organization. This drawer fills in within 20 seconds. Already signed in, and ${server} shows Reconnect there? Press it.`}
          </Text>
          <Box marginTop={1}>
            <Button key="sign-in" variant="primary" autoFocus label="Sign in" onPress={press => actions.signIn(press.surface)} />
          </Box>
        </Box>
      )}
      <Box flexDirection="column">
        <Text>
          <Text bold>{server !== null ? 'Or use the Currents connector. ' : 'Add the Currents connector. '}</Text>
          Connect it once in the Claude directory and every new session has it, with the Currents tools in your
          conversations too. A session gets its connectors when it starts.
        </Text>
        <Box marginTop={1} columnGap={2}>
          <Link href={CLAUDE_DIRECTORY} label="Currents in the Claude directory ↗" />
          <Button key="retry" plain dimColor label="Check again" onPress={actions.retry} />
        </Box>
      </Box>
      <Text dimColor>{'Using an API key instead? Add the server with --header "Authorization: Bearer <key>":'}</Text>
      <Code source={ADD_SERVER} language="bash" />
    </Box>
  )
}

const drawPicker = (ui: Ui, s: Snapshot, actions: Actions): RenderElement => {
  const { Box, Text, Button } = ui
  const where = s.repo?.slug ?? s.repo?.root ?? 'this folder'
  if (s.projects.length === 0) {
    return <Text dimColor>{s.updatedAt === null ? 'Loading your projects…' : 'Your Currents sign-in sees no projects.'}</Text>
  }
  const options = s.projects.map(project => ({ value: project.projectId, label: `${project.name} (${project.projectId})` }))
  const choose = (projectId: string) => {
    const project = s.projects.find(p => p.projectId === projectId)
    if (project !== undefined) actions.pick(project)
  }
  return (
    <Box flexDirection="column" rowGap={1}>
      {s.unseen.length > 0 && (
        <Box flexDirection="column">
          <Text color="warning">
            {`${where} records to ${s.unseen.join(', ')}, which your Currents sign-in can't see: it is for another organization.`}
          </Text>
          <Text dimColor>
            Sign in again and pick the organization that owns it: in /mcp, choose the Currents server and re-authenticate.
          </Text>
          <Box marginTop={1}>
            <Button key="sign-in-again" variant="primary" label="Sign in again" onPress={press => actions.signIn(press.surface)} />
          </Box>
        </Box>
      )}
      <Text>
        {s.unseen.length > 0 ? 'Or pick one of the projects you can see:' : `Which Currents project does ${where} record its runs to?`}
      </Text>
      {'Select' in ui ? (
        <ui.Select
          key="project"
          label="Project"
          options={options}
          {...(s.project ? { value: s.project.projectId } : {})}
          autoFocus
          onSelect={choose}
        />
      ) : (
        <Box flexDirection="column">
          {s.projects.map(project => (
            <Button key={`project-${project.projectId}`} plain label={`${project.name} (${project.projectId})`} onPress={() => choose(project.projectId)} />
          ))}
        </Box>
      )}
      <Text dimColor>The choice is kept for this repository. The mod found {s.projects.length} projects you can read.</Text>
      {s.project !== null && (
        <Box>
          <Button key="cancel-pick" label="Cancel" onPress={() => actions.picking(false)} />
        </Box>
      )}
    </Box>
  )
}

const pill = (ui: Ui, run: Pick<Run, 'status' | 'completionState'>) => {
  const meta = VERDICT[verdictOf(run)]
  return (
    <ui.Text color={meta.color} inverse bold>
      {` ${meta.label} `}
    </ui.Text>
  )
}

const drawRunView = (ui: Ui, input: PaneInput): RenderElement => {
  const { Box, Text, Button, Link } = ui
  const { s, v, detail, now, actions } = input
  const run = shownRun(s, v)
  const branch = s.repo?.branch ?? null

  if (run === null) {
    return (
      <Box flexDirection="column" rowGap={1}>
        <Text>
          No Currents runs on <Text bold>{branch ?? 'this branch'}</Text> yet.
        </Text>
        <Text dimColor>Runs show up here once CI records the branch to {s.project?.name ?? 'Currents'}.</Text>
        {s.project !== null && branch !== null && <Link href={branchRunsUrl(s.project.projectId, branch)} label="This branch in Currents" />}
        {s.prs.length + s.quietPrs.length > 0 && drawPullRequests(ui, input)}
      </Box>
    )
  }

  const errors = detail !== undefined && detail.error === null ? detail.failedTotal + detail.flakyTotal : failedCount(run.tests) + run.tests.flaky
  const specCount = detail?.specs.length ?? run.specs.total
  const tabs: { id: Tab; label: string }[] = [
    { id: 'summary', label: 'Summary' },
    { id: 'errors', label: `Errors${errors > 0 ? ` (${errors})` : ''}` },
    { id: 'specs', label: `Spec Files${specCount > 0 ? ` (${specCount})` : ''}` },
    { id: 'prs', label: `Pull requests${s.prs.length > 0 ? ` (${s.prs.length})` : ''}` },
  ]

  return (
    <Box flexDirection="column" rowGap={1}>
      {run === s.baseRun && (
        <Text dimColor>{`No runs on ${branch ?? 'this branch'} yet. This is ${run.branch ?? 'the default branch'}'s latest.`}</Text>
      )}
      {s.scope === 'mine' && <Text dimColor>Not in a git repository: your latest runs in this project.</Text>}
      {drawRunCard(ui, input, run)}
      <Box columnGap={1} flexWrap="wrap">
        {tabs.map((tab, index) => (
          <Button
            key={`tab-${tab.id}`}
            hotkey={String(index + 1)}
            {...(v.tab === tab.id ? { variant: 'primary' as const } : { dimColor: true })}
            label={tab.label}
            onPress={() => actions.tab(tab.id)}
          />
        ))}
      </Box>
      {v.tab === 'summary' && drawSummary(ui, input, run)}
      {v.tab === 'errors' && drawErrors(ui, input, run)}
      {v.tab === 'specs' && drawSpecs(ui, input, run)}
      {v.tab === 'prs' && drawPullRequests(ui, input)}
      {v.runId !== null && v.runId !== s.branchRuns[0]?.runId && (
        <Box>
          <Button key="back" plain dimColor label={`← Back to ${branch ?? 'this branch'}`} onPress={() => actions.select(null)} />
        </Box>
      )}
      {detail?.error && <Text color="warning">Could not load the run's details: {detail.error}</Text>}
    </Box>
  )
}

const drawRunCard = (ui: Ui, input: PaneInput, run: Run): RenderElement => {
  const { Box, Text, Button, Link } = ui
  const Svg = 'Svg' in ui ? ui.Svg : null
  const { now, width, actions } = input
  const verdict = verdictOf(run)
  const meta = VERDICT[verdict]
  const failed = failedCount(run.tests)
  const rate = passRate(run.tests)

  const facts = [
    run.framework ? `🎭 ${run.framework}` : null,
    ago(run.createdAt, now),
    duration(elapsed(run, now)),
    run.specs.total > 0 ? `${run.specs.complete}/${run.specs.total} spec files` : null,
    run.prNumber ? `PR #${run.prNumber}` : null,
    run.branch,
    shortSha(run.sha),
    run.author,
    run.ciBuildId ? `CI ${clip(run.ciBuildId, 28)}` : null,
  ].filter((fact): fact is string => fact !== null && fact !== '')

  const counter = (count: number, info: { label: string; glyph: string; color: string }) => (
    <Text {...(count === 0 ? { dimColor: true } : { color: info.color })}>
      {`${info.glyph} ${count} ${info.label}`}
    </Text>
  )

  const segments: Segment[] = outcomeSegments(run)
  const barWidth = Math.max(120, Math.min(720, Math.round((width - 4) * CELL_PX)))
  const bar =
    Svg !== null ? (
      <Svg source={stackedBar(segments, run.tests.total, barWidth, 8)} alt={`${run.tests.passes} passed, ${failed} failed of ${run.tests.total}`} width={barWidth} height={8} />
    ) : (
      <Text>
        {textBar(segments, ['success', COUNTER.flaky.color, 'error', 'warning', 'inactive'], run.tests.total, Math.max(10, Math.min(60, width - 6))).map(part => (
          <Text color={part.color}>{part.text}</Text>
        ))}
      </Text>
    )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={meta.color} paddingX={1} rowGap={0}>
      <Box columnGap={1}>
        {pill(ui, run)}
        {run.completionState === 'CANCELED' && verdict !== 'cancelled' && <Text dimColor>Cancelled</Text>}
        <Text bold wrap="truncate-end">
          {run.title}
        </Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        {facts.join(' · ')}
      </Text>
      <Box marginTop={1} columnGap={2} flexWrap="wrap">
        <Text>
          <Text dimColor>Overall </Text>
          <Text bold>{run.tests.total}</Text>
        </Text>
        {rate !== null && (
          <Text>
            <Text dimColor>Pass rate </Text>
            <Text bold>{`${(rate * 100).toFixed(rate === 1 ? 0 : 1)}%`}</Text>
          </Text>
        )}
        {counter(run.tests.passes, COUNTER.passed)}
        {counter(run.tests.failures, COUNTER.failed)}
        {counter(run.tests.skipped, COUNTER.interrupted)}
        {counter(run.tests.pending, COUNTER.ignored)}
        {run.tests.flaky > 0 && <Text color={COUNTER.flaky.color}>{`${COUNTER.flaky.glyph} ${run.tests.flaky} flaky`}</Text>}
      </Box>
      <Box marginTop={1}>{bar}</Box>
      <Box marginTop={1} columnGap={2} flexWrap="wrap" alignItems="center">
        {(failed > 0 || run.tests.flaky > 0) && (
          <Button key="fix" variant="primary" label={failed > 0 ? `Fix ${plural(failed, 'failure')} with Claude` : 'Fix flaky tests with Claude'} onPress={() => actions.fix(run)} />
        )}
        <Link href={runUrl(run.runId)} label="Open in Currents" />
        {failed > 0 && <Link href={failedTestsUrl(run.runId)} label="Failed tests" />}
        {run.prLink !== null && run.prNumber !== null && <Link href={run.prLink} label={`PR #${run.prNumber}`} />}
      </Box>
    </Box>
  )
}

const drawSummary = (ui: Ui, input: PaneInput, run: Run): RenderElement => {
  const { Box, Text, Button } = ui
  const Svg = 'Svg' in ui ? ui.Svg : null
  const { s, detail, now, width, actions } = input
  const history = s.scope === 'mine' || (run.branch !== null && run.branch === s.repo?.branch) ? s.branchRuns : []

  return (
    <Box flexDirection="column" rowGap={1}>
      {isActive(run) && (
        <Box flexDirection="column">
          <Text bold>Progress</Text>
          <Text>
            {run.specs.total > 0 ? `${run.specs.complete}/${run.specs.total} spec files` : 'Starting'}
            <Text dimColor>{` · ${run.tests.recorded}/${run.tests.total} tests reported · ${run.specs.claimed - run.specs.complete} running now`}</Text>
          </Text>
        </Box>
      )}
      {detail !== undefined && detail.groups.length > 1 && (
        <Text dimColor wrap="truncate-end">{`Groups: ${detail.groups.join(', ')}`}</Text>
      )}
      {detail !== undefined && detail.failed.length > 0 && (
        <Box flexDirection="column">
          <Text bold>{`Failures${detail.failedTotal + detail.flakyTotal > 3 ? ` (top 3 of ${detail.failedTotal + detail.flakyTotal})` : ''}`}</Text>
          {detail.failed.slice(0, 3).map(test => drawFailedTest(ui, input, run, test, true))}
          <Box>
            <Button key="all-errors" plain dimColor label="See all errors →" onPress={() => actions.tab('errors')} />
          </Box>
        </Box>
      )}
      {history.length > 1 && (
        <Box flexDirection="column">
          <Text bold>
            {s.scope === 'mine' ? 'Your recent runs' : 'Run history '}
            {s.scope === 'mine' ? null : <Text dimColor>{`· ${run.branch}`}</Text>}
          </Text>
          {Svg !== null ? (
            <Svg
              source={historyBars(history, Math.max(160, Math.min(560, Math.round((width - 4) * CELL_PX))), 32)}
              alt={`Last ${history.length} runs on ${run.branch}`}
              isInteractive
            />
          ) : (
            <Text>
              {history
                .slice(0, 20)
                .reverse()
                .map(item => (
                  <Text color={VERDICT[verdictOf(item)].color}>{VERDICT[verdictOf(item)].glyph}</Text>
                ))}
            </Text>
          )}
          {history.slice(0, 5).map(item => {
            const meta = VERDICT[verdictOf(item)]
            const isShown = item.runId === run.runId
            return (
              <Button key={`history-${item.runId}`} plain dimColor={!isShown} onPress={() => actions.select(item.runId)}>
                <Text color={meta.color}>{`${isShown ? '›' : ' '} ${meta.glyph} `}</Text>
                {`${shortSha(item.sha) ?? item.runId.slice(0, 7)} · ${outcomeSummary(item)} · ${duration(elapsed(item, now))} · ${ago(item.createdAt, now)}`}
              </Button>
            )
          })}
        </Box>
      )}
      {detail === undefined && !isActive(run) && failedCount(run.tests) > 0 && <Text dimColor>Loading failures…</Text>}
    </Box>
  )
}

const drawFailedTest = (ui: Ui, input: PaneInput, run: Run, test: FailedTest, isCompact: boolean): RenderElement => {
  const { Box, Text, Link } = ui
  const info = test.isFlaky ? COUNTER.flaky : COUNTER.failed
  const path = [test.spec, ...test.title].filter(Boolean).join(' › ')
  const width = Math.max(20, input.width - 6)
  const lines = (test.error ?? '').split('\n').filter(Boolean).slice(0, isCompact ? 1 : 3)
  return (
    <Box key={`failed-${test.key}`} flexDirection="column" marginTop={isCompact ? 0 : 1}>
      <Box columnGap={1}>
        <Text color={info.color}>{info.glyph}</Text>
        {test.isFlaky && (
          <Text color={COUNTER.flaky.color} inverse>
            {' Flaky '}
          </Text>
        )}
        <Text wrap="truncate-middle">{clip(path, width)}</Text>
      </Box>
      {lines.map(line => (
        <Text color={test.isFlaky ? 'subtle' : 'error'} wrap="truncate-end">{`  ${clip(line, width)}`}</Text>
      ))}
      {!isCompact && (
        <Box columnGap={2} marginLeft={2}>
          {test.location !== null && <Text dimColor>{test.location}</Text>}
          {test.durationMs !== null && <Text dimColor>{duration(test.durationMs)}</Text>}
          <Link href={testUrl(run.runId, test)} label="Open test" />
        </Box>
      )}
    </Box>
  )
}

const drawErrors = (ui: Ui, input: PaneInput, run: Run): RenderElement => {
  const { Box, Text, Link, Button } = ui
  const { detail, actions } = input
  if (detail === undefined) {
    return <Text dimColor>{failedCount(run.tests) + run.tests.flaky > 0 ? 'Loading failures…' : 'No failed or flaky tests.'}</Text>
  }
  if (detail.failed.length === 0) {
    return (
      <Text dimColor>
        {isActive(run) ? 'No failures reported so far.' : 'No failed or flaky tests in this run.'}
      </Text>
    )
  }
  const shown = detail.failed.length
  const total = detail.failedTotal + detail.flakyTotal
  return (
    <Box flexDirection="column">
      <Text>
        {`${plural(detail.failedTotal, 'failed test')}`}
        {detail.flakyTotal > 0 && <Text color={COUNTER.flaky.color}>{` · ${detail.flakyTotal} flaky`}</Text>}
        <Text dimColor>{shown < total ? ` · showing ${shown}` : ''}</Text>
      </Text>
      {detail.failed.map(test => drawFailedTest(ui, input, run, test, false))}
      <Box marginTop={1} columnGap={2}>
        {detail.failedTotal > 0 && (
          <Button key="fix-errors" variant="primary" label="Fix with Claude" onPress={() => actions.fix(run)} />
        )}
        <Link href={runUrl(run.runId, 'errors')} label="All errors in Currents" />
      </Box>
    </Box>
  )
}

const SPEC_STATE: Record<SpecRow['state'], { glyph: string; color: string; label: string }> = {
  failed: { glyph: '✗', color: 'error', label: 'Failed' },
  running: { glyph: '●', color: 'suggestion', label: 'Running' },
  flaky: { glyph: '≈', color: COUNTER.flaky.color, label: 'Flaky' },
  queued: { glyph: '○', color: 'inactive', label: 'Pending' },
  passed: { glyph: '✓', color: 'success', label: 'Passed' },
}

const drawSpecs = (ui: Ui, input: PaneInput, run: Run): RenderElement => {
  const { Box, Text, Link } = ui
  const { detail, width } = input
  if (detail === undefined) return <Text dimColor>Loading spec files…</Text>
  const rows = detail.specs.slice(0, 30)
  const nameWidth = Math.max(16, width - 30)
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {`Showing ${rows.length} out of ${detail.specs.length} spec files${detail.groups.length > 0 ? ` in ${plural(detail.groups.length, 'group')}` : ''}`}
      </Text>
      {rows.map(spec => {
        const state = SPEC_STATE[spec.state]
        const counts = [
          `${plural(spec.tests, 'test')}`,
          spec.failures > 0 ? `${spec.failures} failed` : null,
          spec.flaky > 0 ? `${spec.flaky} flaky` : null,
        ].filter(Boolean)
        return (
          <Box key={`spec-${spec.instanceId}`} columnGap={1}>
            <Text color={state.color}>{state.glyph}</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-start">{clip(spec.spec, nameWidth)}</Text>
            </Box>
            <Text dimColor>{counts.join(' · ')}</Text>
            <Text dimColor>{duration(spec.durationMs)}</Text>
          </Box>
        )
      })}
      <Box marginTop={1}>
        <Link href={runUrl(run.runId, 'specs')} label="All spec files in Currents" />
      </Box>
    </Box>
  )
}

const drawPullRequests = (ui: Ui, input: PaneInput): RenderElement => {
  const { Box, Text, Button, Link } = ui
  const Svg = 'Svg' in ui ? ui.Svg : null
  const { s, v, now, width, actions } = input
  if (s.prs.length === 0 && s.quietPrs.length === 0) {
    return <Text dimColor>No open pull requests of yours have Currents runs.</Text>
  }
  const shown = shownRun(s, v)?.runId ?? null
  return (
    <Box flexDirection="column" rowGap={1}>
      {s.prs.map(pr => {
        const run = pr.latest
        const meta = VERDICT[verdictOf(run)]
        const title = pr.title ?? run.title
        const tail = `${outcomeSummary(run)} · ${isActive(run) ? duration(elapsed(run, now)) : ago(run.createdAt, now)}`
        const failedRuns = pr.recent.filter(r => r.status === 'FAILED').length
        return (
          <Box key={`prbox-${pr.id}`} flexDirection="column">
            <Button key={`pr-${pr.id}`} plain dimColor={run.runId !== shown} onPress={() => actions.select(run.runId)}>
              <Text color={meta.color}>{`${meta.glyph} `}</Text>
              <Text bold>{pr.number ? `#${pr.number} ` : ''}</Text>
              {clip(title, Math.max(16, width - tail.length - 10))}
              <Text color={meta.color}>{`  ${tail}`}</Text>
            </Button>
            <Box columnGap={1} marginLeft={2}>
              <Text dimColor>{`${pr.source ?? run.branch ?? '?'} → ${pr.destination ?? '?'}`}</Text>
              {pr.recent.length > 1 &&
                (Svg !== null ? (
                  <Svg source={runDots(pr.recent, 9, 3)} alt={`Last ${pr.recent.length} runs`} isInteractive />
                ) : (
                  <Text>
                    {pr.recent
                      .slice(0, 10)
                      .reverse()
                      .map(item => (
                        <Text color={VERDICT[verdictOf(item)].color}>{VERDICT[verdictOf(item)].glyph}</Text>
                      ))}
                  </Text>
                ))}
              {pr.recent.length > 1 && (
                <Text dimColor>{`last ${pr.recent.length}: ${pr.recent.length - failedRuns} passed, ${failedRuns} failed`}</Text>
              )}
            </Box>
          </Box>
        )
      })}
      {s.quietPrs.map(pr => (
        <Text key={`quiet-${pr.number}`} dimColor>
          {`○ #${pr.number} ${clip(pr.title, Math.max(16, width - 30))} · no Currents runs yet${pr.isDraft ? ' · draft' : ''}`}
        </Text>
      ))}
      {s.project !== null && <Link href={pullRequestsUrl(s.project.projectId)} label="All pull requests in Currents" />}
    </Box>
  )
}

const drawFooter = (ui: Ui, input: PaneInput): RenderElement => {
  const { Box, Text, Button } = ui
  const { s, now, isBandHidden, actions } = input
  const c = s.connection
  const active = [s.branchRuns[0], ...s.prs.map(pr => pr.latest)].some(run => run !== undefined && isActive(run))
  const parts = [
    s.updatedAt !== null ? `Updated ${ago(s.updatedAt, now)}` : null,
    c.state === 'connected' ? (active ? 'refreshing every 15s while runs are in progress' : 'refreshing every minute') : null,
    s.projectSource === 'repo' ? 'project found in the repo config' : null,
    s.projectSource === 'remote' ? "project matched by the repo's runs" : null,
    s.projectSource === 'mine' ? 'project of your latest run' : null,
  ].filter(Boolean)
  return (
    <Box flexDirection="column">
      {s.error !== null && s.updatedAt !== null && <Text color="warning">{`Last refresh failed: ${s.error}`}</Text>}
      <Box columnGap={2} flexWrap="wrap">
        <Text dimColor>{parts.join(' · ')}</Text>
        {isBandHidden && <Button key="show-band" plain dimColor label="Show the band" onPress={actions.toggleBand} />}
      </Box>
    </Box>
  )
}
