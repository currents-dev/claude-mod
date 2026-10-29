// SVG for the surfaces that draw it (Desktop, VS Code, mobile); the terminal gets block characters instead.

import type { Run, RecentRun } from '../types'
import { COUNTER, VERDICT, verdictOf, failedCount } from './model'

const TRACK = '#8b8b8b33'

export type Segment = { value: number; hex: string }

const rect = (x: number, width: number, height: number, hex: string, radius: number) =>
  `<rect x="${x.toFixed(2)}" y="0" width="${Math.max(0, width).toFixed(2)}" height="${height}" rx="${radius}" fill="${hex}"/>`

/** One horizontal bar split into colored segments over a track. */
export const stackedBar = (segments: Segment[], total: number, width: number, height = 8): string => {
  const parts = [rect(0, width, height, TRACK, height / 2)]
  let x = 0
  const sum = Math.max(total, segments.reduce((acc, s) => acc + s.value, 0), 1)
  for (const segment of segments) {
    if (segment.value <= 0) continue
    const w = Math.max(2, (segment.value / sum) * width)
    parts.push(rect(x, Math.min(w, width - x), height, segment.hex, height / 2))
    x += w
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
}

/** The run's outcomes as the dashboard's counters color them. */
export const outcomeSegments = (run: Run): Segment[] => [
  { value: run.tests.passes - run.tests.flaky, hex: COUNTER.passed.hex },
  { value: run.tests.flaky, hex: COUNTER.flaky.hex },
  { value: run.tests.failures, hex: COUNTER.failed.hex },
  { value: run.tests.skipped, hex: COUNTER.interrupted.hex },
  { value: run.tests.pending, hex: COUNTER.ignored.hex },
]

/** Spec files finished out of scheduled, in the run's color. */
export const progressSegments = (run: Run): Segment[] => [
  { value: run.specs.complete, hex: VERDICT[verdictOf(run)].hex },
  { value: Math.max(0, run.specs.claimed - run.specs.complete), hex: `${VERDICT[verdictOf(run)].hex}66` },
]

/** The pull requests page's "last 10 runs" dots, oldest on the left. */
export const runDots = (runs: RecentRun[], size = 12, gap = 4): string => {
  const list = runs.slice(0, 10).reverse()
  const width = Math.max(size, list.length * (size + gap) - gap)
  const dots = list
    .map((run, index) => {
      const verdict = VERDICT[verdictOf(run)]
      const x = index * (size + gap)
      const label = `${verdict.label}${run.failures > 0 ? ` · ${run.failures} failed` : ''}${run.sha ? ` · ${run.sha.slice(0, 7)}` : ''}`
      return `<g><title>${escapeXml(label)}</title><rect x="${x}" y="0" width="${size}" height="${size}" rx="3" fill="${verdict.hex}"/></g>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${size}" viewBox="0 0 ${width} ${size}">${dots}</svg>`
}

/** Last runs as bars whose height is the run's duration, like the dashboard's history chart. */
export const historyBars = (runs: Run[], width: number, height = 36): string => {
  const list = runs.slice(0, 12).reverse()
  if (list.length === 0) return ''
  const gap = 4
  const barWidth = Math.max(6, Math.min(28, (width - gap * (list.length - 1)) / list.length))
  const longest = Math.max(1, ...list.map(run => run.durationMs ?? 0))
  const bars = list
    .map((run, index) => {
      const verdict = VERDICT[verdictOf(run)]
      const h = Math.max(4, ((run.durationMs ?? longest * 0.5) / longest) * height)
      const x = index * (barWidth + gap)
      const failed = failedCount(run.tests)
      const label = `${verdict.label}${failed > 0 ? ` · ${failed} failed` : ''} · ${run.sha?.slice(0, 7) ?? run.runId.slice(0, 7)}`
      return `<g><title>${escapeXml(label)}</title><rect x="${x.toFixed(1)}" y="${(height - h).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${verdict.hex}"/></g>`
    })
    .join('')
  const w = list.length * (barWidth + gap) - gap
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(0)}" height="${height}" viewBox="0 0 ${w.toFixed(1)} ${height}">${bars}</svg>`
}

export const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ---- Terminal ----

export type TextBarPart = { text: string; color: string }

/** A bar in eighth-blocks for the terminal: one part per colored run of cells. */
export const textBar = (segments: Segment[], colors: string[], total: number, cells: number): TextBarPart[] => {
  const sum = Math.max(total, segments.reduce((acc, s) => acc + s.value, 0), 1)
  const parts: TextBarPart[] = []
  let used = 0
  segments.forEach((segment, index) => {
    if (segment.value <= 0) return
    const n = Math.max(1, Math.round((segment.value / sum) * cells))
    const take = Math.min(n, cells - used)
    if (take > 0) parts.push({ text: '█'.repeat(take), color: colors[index] ?? 'text' })
    used += take
  })
  if (used < cells) parts.push({ text: '░'.repeat(cells - used), color: 'inactive' })
  return parts
}
