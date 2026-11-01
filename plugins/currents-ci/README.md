# currents-ci

Your Currents test runs inside Claude Code, for the branch you are on and its
pull request. A line above the prompt shows the branch's latest run and what
is failing in it, and whether those failures are new against the default
branch. A drawer shows the branch's runs, failures, flaky and slow tests, and
the builds of its pull request. Works in the Claude Code CLI, the Code tab of
the Desktop app and the VS Code extension.

## Install

At a Claude Code prompt in the terminal:

```
/plugin install currents-ci --marketplace currents-dev/claude-mod
```

## What you see

**The band above the prompt**

```
✗ Currents · fix-login · 3 failed, 2 flaky · Login › redirects to the dashboard +4 · 2 new · 6m 40s · 12m ago · PR #42   [Fix with Claude] [Open] ×
```

- The verdict, the branch, and the outcome: failed, flaky, running, or passed.
- The first failing test by name, and how many others the run has.
- **new** when the branch fails tests the default branch does not. **failing on main too** when every failure also fails there.
- **run for abc1234** when the run is for a commit other than the one you have checked out, so you know the run is not for your latest local commit.
- While a run is in progress it shows the spec files done and the time so far,
  and refreshes every 15 seconds.
- After Claude Code pushes the branch (`git push`, `gh pr create`), the band
  waits for the run that push starts.
- When a run on your branch finishes, you get a toast and a notification.
- × hides the band for the session. `/currents band` hides it in every
  session, and shows it again.

**The drawer** (`/currents`, or Open on the band)

- The run's header: status, title, framework, age, duration, spec files done,
  PR, branch, commit, author and CI build; then Overall, pass rate, Passed,
  Failed, Interrupted, Ignored and flaky, with a bar of the results. Under them,
  how many of the run's failures are new on the branch.
- **Summary**: progress while running, the top failures (each tagged **new** or
  **on main too**), and the branch's run history. Pick an older run to see it.
- **Errors**: each failed and flaky test with the first lines of its error,
  where it failed, a link to the test in Currents, and a link to share it.
- **Spec Files**: failures first, then the slowest.
- **Tests**: the branch's flakiest or slowest tests over the last 30 days,
  read when you open the tab. Pick **Flakiest** or **Slowest**.
  **Fix flaky tests with Claude** (or **Speed up the slow tests**) drafts the
  list in the box.
- **Pull request**: the branch's pull request, with its review state (approved,
  changes requested, review required) and a link to it. Below, its builds,
  grouped by commit, with a strip of the last builds. Pick a build to open it.

**Fix with Claude** puts a prompt in the box with the run's link and id, its
failed and flaky tests, their errors, and which failures are new against the
default branch. Claude can then read the full errors, steps and traces with the
Currents MCP tools.

**Share link** makes a public link to the run's report, or to one failing test,
and copies it. Anyone with the link can open the report, without a Currents
login, until it expires (seven days). Only a press makes a link.

## Connect

The plugin reads Currents over MCP, through whichever of these the session
has. With more than one, it uses yours before its own.

- **Sign in here.** The plugin ships the Currents MCP server
  (`https://mcp.currents.dev/mcp`). Press **Sign in** on the band: in the
  terminal the /mcp dialog opens; in the Desktop app it drafts `/mcp` in the
  prompt box (Connectors in the session sidebar works too). Choose
  `plugin:currents-ci:currents`, sign in with your Currents account and pick the
  organization. Claude Code keeps and refreshes the tokens.
- **The Currents connector.** Connect
  [Currents in the Claude directory](https://claude.ai/directory/currents)
  once and every new session has it. A session gets its connectors when it
  starts, so one already open keeps going without it.
- **Your own server**, as for an API key:

  ```bash
  claude mcp add --transport http --scope user currents https://mcp.currents.dev/mcp --header "Authorization: Bearer <key>"
  ```

The band and the drawer fill in within 20 seconds of a connection appearing.
Each of these also gives Claude the Currents tools that **Fix with Claude**
relies on.

### The band's reads

Claude Code checks a plugin's tool calls as it checks Claude's, and the band
polls in the background, where nobody would see the question. So the plugin
allows the five read-only Currents tools it calls: a `PreToolUse` hook in
`hooks/hooks.json` approves `currents-get-projects`, `currents-get-runs`,
`currents-get-run-details`, `currents-get-context` and
`currents-get-tests-performance`, on whichever Currents server the session has.
Claude can call these five without asking too. None of them changes anything in
Currents. Share link is the one call that makes something, and it asks as any
other Currents tool does; a `deny` rule for one of the five still wins.

Where the hook does not decide, the band says the session's permissions
stopped it, and **Allow…** opens the drawer with the five as rules for
`permissions.allow` in `~/.claude/settings.json`, and a button that copies
them. That happens when an organization turns plugin hooks off
(`disableAllHooks`, or `allowManagedHooksOnly` for a plugin it does not
manage), and can happen in auto mode in the Desktop app, whose classifier
judges only Claude's own calls and is asked even about an approved one. For
the plugin's own server:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_currents-ci_currents__currents-get-projects",
      "mcp__plugin_currents-ci_currents__currents-get-runs",
      "mcp__plugin_currents-ci_currents__currents-get-run-details",
      "mcp__plugin_currents-ci_currents__currents-get-context",
      "mcp__plugin_currents-ci_currents__currents-get-tests-performance"
    ]
  }
}
```

The connector's id stands in for `plugin_currents-ci_currents` when the band
reads through the Currents connector. Claude Code picks up the rules without a
restart: press **Check again**.

## Which project

1. The one you picked for this repository (`/currents project`).
2. The project the repository names: `projectId` in a `currents.config.*` file
   or `CURRENTS_PROJECT_ID` in a CI workflow. The most-named one wins; a tie
   goes to the project with the newest run on your branch.
3. The only project you can see.
4. With eight projects or fewer, the one whose runs mention the repository.

On a branch with no run yet, the band shows how the project's default branch
stands. Outside a git repository, it shows your own latest run: the newest run
whose commit carries your git name, in the project where you ran last.

## Which branch and pull request

The branch is the one you have checked out. Its runs are the ones on that
branch in Currents.

Its pull request comes from the GitHub CLI (`gh pr view`), which also gives the
review state and whether it is a draft. Without the GitHub CLI the pull request
comes from the Currents runs' pull request, which shows the number and its
link, and the review state is not shown. A branch with no pull request says so,
and offers to open one on GitHub.

## Commands

| Command | What it does |
| --- | --- |
| `/currents` | Opens the drawer |
| `/currents refresh` | Refreshes now |
| `/currents share` | Makes a link to the branch's latest run, and prints it |
| `/currents connect` | Looks for the Currents connector, or shows how to add it |
| `/currents status` | Shows what the plugin found: connection, project, repository, pull request |
| `/currents project` | Picks the project for this repository |
| `/currents band` | Hides the band in every session, or shows it again |

## Settings

| Setting | Default | |
| --- | --- | --- |
| Notify when a run finishes | on | A toast always; this adds a notification |

## What it runs and reads

- `git` in your repository: the branch, HEAD, the `origin` remote, the project
  ids in Currents config and CI files, and your git user name.
- `gh pr view` for the branch's pull request, at most every two minutes.
- Currents, only through the Currents connector (or your Currents MCP server).
  It reads the branch's runs, the default branch's newest run, the failing tests
  of those runs, and the branch's test statistics. It changes nothing, except
  that **Share link** makes a public report link when you press it. A run of a
  project with many groups is large, so each refresh reads the branch's newest
  run alone, and its history only once a new run starts.
- A reply over Claude Code's MCP output limit (`MAX_MCP_OUTPUT_TOKENS`), which
  Claude Code saves to a file in the session's `tool-results` folder: the
  plugin reads that file.
- A `PreToolUse` hook that prints a fixed answer: it approves the five
  read-only Currents tools above, for the band and for Claude.

## Requirements

- Claude Code 2.1.287 or later in the terminal, or the Desktop app with 2.1.286
  or later. Tested with Claude Code 2.1.310 in the terminal and 2.1.295 in the
  Desktop app's Code tab. Mods' events and methods can change between releases.
- `git`. The GitHub CLI is optional: it adds the pull request's review state.

## Develop

From this folder:

```bash
claude --plugin-dir .
claude plugin validate .
claude plugin test .
```

`tests/` holds the tests: the API parsing, and the band and the drawer on
every surface against a stand-in Currents server, GitHub and git.

| File | What it holds |
| --- | --- |
| `hooks/register.tsx` | The hooks: the command, the band, the drawer, push watching, share |
| `hooks/controller.ts` | Polling, the project choice, the baseline, notifications, Fix with Claude, the Tests tab |
| `hooks/currents.ts` | Finding the Currents server and calling its tools |
| `hooks/model.ts` | The API's JSON into runs, failures and test statistics; the dashboard's words; the prompts |
| `hooks/views.tsx` | What the band and the drawer draw |
| `hooks/repo.ts` | git and the GitHub CLI |
| `hooks/svg.ts` | Charts for the surfaces that draw SVG, bars for the terminal |
| `types/index.d.ts` | The values kept in `$.state` |

## License

Apache-2.0
