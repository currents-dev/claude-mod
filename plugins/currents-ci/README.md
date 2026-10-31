# currents-ci

Your Currents test runs inside Claude Code. A line above the prompt shows the
run for the branch you are on and how your other pull requests stand. A drawer
shows the whole run, laid out like the run page of the Currents dashboard.
Works in the Claude Code CLI, the Code tab of the Desktop app and the VS Code
extension.

## Install

At a Claude Code prompt in the terminal:

```
/plugin install currents-ci --marketplace currents-dev/claude-mod
```

## What you see

**The band above the prompt**

```
✗ Currents · fix-login · 3 failed, 2 flaky · 420 tests · 6m 40s · 12m ago   2 other PRs ✓1 ✗1   [Fix with Claude] [Open] ×
```

- While a run is in progress it shows the spec files done and the time so far,
  and refreshes every 15 seconds.
- After Claude Code pushes the branch (`git push`, `gh pr create`), the band
  waits for the run that push starts.
- When a run on your branch or one of your pull requests finishes, you get a
  toast and a notification.

**The drawer** (`/currents`, or Open on the band)

- The run's header: status, title, framework, age, duration, spec files done,
  PR, branch, commit, author and CI build; then Overall, pass rate, Passed,
  Failed, Interrupted, Ignored and flaky, with a bar of the results.
- **Summary**: progress while running, the top failures, and the branch's run
  history. Pick an older run to see it.
- **Errors**: each failed and flaky test with the first lines of its error,
  where it failed, and a link to the test in Currents.
- **Spec Files**: failures first, then the slowest.
- **Pull requests**: each of your open pull requests with its latest run and
  its last ten runs. Pick one to open its run.

**Fix with Claude** puts a prompt in the box with the run's link and id and
its failed tests and errors. Claude can then read the full errors, steps and
traces with the Currents MCP tools.

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
`currents-list-pull-requests`, `currents-get-run-details` and
`currents-get-context`, on whichever Currents server the session has. Claude
can call these five without asking too. None of them changes anything in
Currents, every other Currents tool asks as before, and a `deny` rule for one
of the five still wins.

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
      "mcp__plugin_currents-ci_currents__currents-list-pull-requests",
      "mcp__plugin_currents-ci_currents__currents-get-run-details",
      "mcp__plugin_currents-ci_currents__currents-get-context"
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

## Which pull requests

Your open pull requests from the GitHub CLI (`gh pr list --author @me`),
matched to Currents by branch. Pull requests with no run yet are listed too.
Without the GitHub CLI, the plugin shows the pull requests whose runs carry
your git author name. Set **Pull requests to show** to `all` for the project's
latest pull requests.

## Commands

| Command | What it does |
| --- | --- |
| `/currents` | Opens the drawer |
| `/currents refresh` | Refreshes now |
| `/currents connect` | Looks for the Currents connector, or shows how to add it |
| `/currents status` | Shows what the plugin found: connection, project, repository |
| `/currents project` | Picks the project for this repository |
| `/currents band` | Hides or shows the band |

## Settings

| Setting | Default | |
| --- | --- | --- |
| Notify when a run finishes | on | A toast always; this adds a notification |
| Pull requests to show | `mine` | `mine` or `all` |

## What it runs and reads

- `git` in your repository: the branch, HEAD, the `origin` remote, the project
  ids in Currents config and CI files, and your git user name.
- `gh pr list` for your open pull requests, every two minutes at most.
- Currents, only through the Currents connector (or your Currents MCP server).
  It reads results and projects and changes nothing.
- A `PreToolUse` hook that prints a fixed answer: it approves the five
  read-only Currents tools above, for the band and for Claude.

## Requirements

- Claude Code 2.1.287 or later in the terminal, or the Desktop app with 2.1.286
  or later. Tested with Claude Code 2.1.310 in the terminal and 2.1.295 in the
  Desktop app's Code tab. Mods' events and methods can change between releases.
- `git`. The GitHub CLI is optional.

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
| `hooks/register.tsx` | The hooks: the command, the band, the drawer, push watching |
| `hooks/controller.ts` | Polling, the project choice, notifications, Fix with Claude |
| `hooks/currents.ts` | Finding the Currents server and calling its tools |
| `hooks/model.ts` | The API's JSON into runs, pull requests and failures; the dashboard's words |
| `hooks/views.tsx` | What the band and the drawer draw |
| `hooks/repo.ts` | git and the GitHub CLI |
| `hooks/svg.ts` | Charts for the surfaces that draw SVG, bars for the terminal |
| `types/index.d.ts` | The values kept in `$.state` |

## License

Apache-2.0
