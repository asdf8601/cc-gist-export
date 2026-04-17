# cc-gist-export

Export a Claude Code session (JSONL) to a GitHub Gist as Markdown.

Zero runtime deps. Shells out to the [`gh`](https://cli.github.com) CLI for gist
upload, so auth is whatever `gh` already has.

## Usage

```sh
# Pick session via fuzzy picker (fzf if installed, otherwise a numbered prompt)
npx cc-gist-export

# Skip the picker and take the latest session
npx cc-gist-export --latest

# Public gist and open in browser
npx cc-gist-export --public --open

# Specific session file
npx cc-gist-export ~/.claude/projects/-Users-me-repo/<uuid>.jsonl

# Just render markdown to a file (no upload)
npx cc-gist-export --out session.md

# Or dump to stdout
npx cc-gist-export --stdout > session.md

# List recent sessions of the current project
npx cc-gist-export --list
```

## Options

| flag            | default | description                                  |
|-----------------|---------|----------------------------------------------|
| `--public`      | off     | Public gist (default: secret)                |
| `--open`        | off     | Open resulting gist URL in the browser       |
| `--title <t>`   | auto    | Gist description                             |
| `--out <file>`  | —       | Write markdown to file, skip upload          |
| `--stdout`      | off     | Print markdown to stdout, skip upload        |
| `--no-thinking` | off     | Skip assistant `thinking` blocks             |
| `--no-tools`    | off     | Skip `tool_use` / `tool_result` blocks       |
| `--latest`      | off     | Take most recent session, skip the picker    |
| `--list`        | off     | List recent sessions for current project     |
| `-h`, `--help`  |         | Show help                                    |

## How session lookup works

With no file argument, the current working directory is mapped to
`~/.claude/projects/<slug>/` where `<slug>` is the cwd with `/` and `.` replaced
by `-`. The most recently modified `.jsonl` in that directory is used.

## Output format

- `## 👤 User` and `## 🤖 Assistant` sections
- `thinking` wrapped in `<details>` (GFM renders collapsibles on gists)
- `tool_use` and `tool_result` collapsed with truncation on long payloads
- `<system-reminder>` user blocks are skipped

## Requirements

- Node.js ≥ 18
- [`gh`](https://cli.github.com) CLI authenticated (`gh auth login`) if uploading

## License

MIT
