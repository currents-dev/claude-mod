# Currents for Claude Code

Claude Code plugins from [Currents](https://currents.dev), the test results
dashboard for Playwright and Cypress. This repository is a plugin marketplace.

## Plugins

| Plugin | What it does |
| --- | --- |
| [`currents-ci`](plugins/currents-ci) | Your Currents test runs inside Claude Code: a live status band above the prompt for the branch you are on and your open pull requests, and a drawer with the run's results, errors and spec files, laid out like the Currents dashboard. Fix with Claude drafts a prompt from a failed run. |

## Install

At a Claude Code prompt in the terminal:

```
/plugin install currents-ci --marketplace currents-dev/claude-mod
```

Answer `y` to add the marketplace, then choose the user scope. Or from your shell:

```bash
claude plugin marketplace add currents-dev/claude-mod
claude plugin install currents-ci@currents
```

The plugin loads in Claude Code in the terminal, the Code tab of the Desktop app
and the VS Code extension. It needs Claude Code 2.1.287 or later (the Desktop
app's 2.1.286 or later).

Then connect Currents: press **Sign in** on the band, or connect
[Currents in the Claude directory](https://claude.ai/directory/currents). The
[plugin's README](plugins/currents-ci/README.md) has the details.

## Develop

Load the plugin from your clone for one session:

```bash
claude --plugin-dir plugins/currents-ci
```

Claude Code reloads it as you save. Or install it from your clone, so every
session runs your working copy, and pick up edits with `/reload-plugins`:

```bash
claude plugin marketplace add .
claude plugin install currents-ci@currents
```

Before you push:

```bash
claude plugin validate .
claude plugin validate plugins/currents-ci
claude plugin test plugins/currents-ci
```

Once Claude Code has loaded the plugin, it lays its API types in
`plugins/currents-ci/.claude-plugin/types/` (ignored by git), and
`npx tsc -p plugins/currents-ci` type-checks it. CI runs the validation and the
tests on every push and pull request.

## License

Apache-2.0
