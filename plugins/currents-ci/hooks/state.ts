// What the state starts as. Each file that reads or writes a value declares its
// atom itself (`atom({ plugin: 'currents-ci', key }, ...)`), so `claude plugin
// validate` can read the literal keys where they are used.

import type { RunDetail, Snapshot, View } from '../types'

export const EMPTY: Snapshot = {
  connection: { state: 'checking' },
  repo: null,
  project: null,
  unseen: [],
  projects: [],
  projectSource: null,
  branchRuns: [],
  scope: 'branch',
  baseRun: null,
  prs: [],
  quietPrs: [],
  pushedAt: null,
  updatedAt: null,
  isLoading: false,
  error: null,
}

/** A snapshot an earlier version saved lacks the fields added since: fill them in. */
export const normalize = (s: Snapshot): Snapshot => ({ ...EMPTY, ...s })

export const NO_DETAILS: Record<string, RunDetail> = {}

export const FIRST_VIEW: View = { runId: null, tab: 'summary', isPicking: false }

export const PANE = 'currents'
