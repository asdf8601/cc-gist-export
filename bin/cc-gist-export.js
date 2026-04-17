#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HELP = `cc-gist-export — export Claude Code session to a GitHub Gist

Usage:
  cc-gist-export [SESSION.jsonl] [options]

If SESSION is omitted, picks the most recent session of the current cwd project.

Options:
  --public            Public gist (default: secret)
  --open              Open the resulting gist in the browser
  --title <title>     Gist description
  --out <file>        Write markdown to file instead of uploading
  --stdout            Print markdown to stdout (no upload)
  --no-thinking       Skip assistant thinking blocks
  --no-tools          Skip tool_use and tool_result blocks
  --list              List recent sessions for the current project
  -h, --help          Show this help
`;

function parseArgs(argv) {
  const opts = {
    file: null,
    public: false,
    open: false,
    title: null,
    out: null,
    stdout: false,
    noThinking: false,
    noTools: false,
    list: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (a === "--public") opts.public = true;
    else if (a === "--open") opts.open = true;
    else if (a === "--stdout") opts.stdout = true;
    else if (a === "--no-thinking") opts.noThinking = true;
    else if (a === "--no-tools") opts.noTools = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--title") opts.title = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a.startsWith("--")) {
      console.error(`unknown option: ${a}`);
      process.exit(2);
    } else if (!opts.file) opts.file = a;
    else {
      console.error(`unexpected arg: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function cwdProjectDir() {
  const slug = process.cwd().replace(/[/.]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", slug);
}

function listSessions(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const p = path.join(dir, f);
      return { path: p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function resolveSession(arg) {
  if (arg) {
    if (!fs.existsSync(arg)) {
      console.error(`not found: ${arg}`);
      process.exit(1);
    }
    return arg;
  }
  const dir = cwdProjectDir();
  const sessions = listSessions(dir);
  if (!sessions.length) {
    console.error(`no sessions found in ${dir}`);
    process.exit(1);
  }
  return sessions[0].path;
}

function readJsonl(file) {
  const raw = fs.readFileSync(file, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {}
  }
  return out;
}

function fence(s, lang = "") {
  const text = String(s ?? "");
  let ticks = "```";
  while (text.includes(ticks)) ticks += "`";
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function truncate(s, max = 4000) {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}

function stringifyToolInput(input) {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text")
    .map((c) => c.text || "")
    .join("\n");
}

function renderToolResult(c) {
  let body = "";
  if (typeof c.content === "string") body = c.content;
  else if (Array.isArray(c.content)) {
    body = c.content
      .map((x) => (typeof x === "string" ? x : x.text || JSON.stringify(x)))
      .join("\n");
  } else if (c.content != null) {
    body = JSON.stringify(c.content);
  }
  const status = c.is_error ? " (error)" : "";
  return `<details><summary>tool_result${status}</summary>\n\n${fence(
    truncate(body),
  )}\n\n</details>`;
}

function renderToolUse(c) {
  const name = c.name || "tool";
  const input = stringifyToolInput(c.input ?? {});
  return `<details><summary>🛠️ ${name}</summary>\n\n${fence(
    truncate(input),
    "json",
  )}\n\n</details>`;
}

function isSystemReminder(text) {
  return /<system-reminder>/i.test(text);
}

function toMarkdown(records, opts) {
  const lines = [];
  const meta = records.find((r) => r.cwd || r.sessionId) || {};
  const sessionId = meta.sessionId || "";
  const cwd = meta.cwd || "";
  const gitBranch = meta.gitBranch || "";
  const first = records.find((r) => r.timestamp)?.timestamp || "";
  const last = [...records].reverse().find((r) => r.timestamp)?.timestamp || "";

  lines.push(`# Claude Code session`);
  lines.push("");
  const metaRows = [
    ["session", sessionId],
    ["cwd", cwd],
    ["branch", gitBranch],
    ["started", first],
    ["ended", last],
  ].filter(([, v]) => v);
  if (metaRows.length) {
    lines.push("| | |");
    lines.push("|---|---|");
    for (const [k, v] of metaRows) lines.push(`| ${k} | \`${v}\` |`);
    lines.push("");
  }

  for (const r of records) {
    const t = r.type;
    if (t !== "user" && t !== "assistant") continue;
    const msg = r.message || {};
    const role = msg.role;
    const content = msg.content;

    if (role === "user") {
      if (typeof content === "string") {
        if (isSystemReminder(content)) continue;
        lines.push(`## 👤 User`, "", content.trim(), "");
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === "text") {
            if (isSystemReminder(c.text || "")) continue;
            lines.push(`## 👤 User`, "", (c.text || "").trim(), "");
          } else if (c.type === "tool_result" && !opts.noTools) {
            lines.push(renderToolResult(c), "");
          }
        }
      }
    } else if (role === "assistant") {
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c.type === "text" && c.text) {
          lines.push(`## 🤖 Assistant`, "", c.text.trim(), "");
        } else if (c.type === "thinking" && !opts.noThinking) {
          lines.push(
            `<details><summary>💭 thinking</summary>\n\n${(c.thinking || "")
              .trim()}\n\n</details>`,
            "",
          );
        } else if (c.type === "tool_use" && !opts.noTools) {
          lines.push(renderToolUse(c), "");
        }
      }
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function upload(mdFile, { isPublic, title, open }) {
  const args = ["gist", "create", mdFile];
  if (isPublic) args.push("--public");
  if (title) args.push("--desc", title);
  const res = spawnSync("gh", args, { encoding: "utf8" });
  if (res.error) {
    console.error(
      `failed to run gh: ${res.error.message}. Install: https://cli.github.com`,
    );
    process.exit(1);
  }
  if (res.status !== 0) {
    process.stderr.write(res.stderr || "");
    process.exit(res.status || 1);
  }
  const url = (res.stdout || "").trim().split("\n").pop();
  console.log(url);
  if (open && url) {
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    spawnSync(opener, [url], { stdio: "ignore", detached: true });
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.list) {
    const dir = cwdProjectDir();
    const sessions = listSessions(dir);
    if (!sessions.length) {
      console.error(`no sessions in ${dir}`);
      process.exit(1);
    }
    for (const s of sessions.slice(0, 20)) {
      console.log(`${new Date(s.mtime).toISOString()}  ${s.path}`);
    }
    return;
  }

  const file = resolveSession(opts.file);
  const records = readJsonl(file);
  const md = toMarkdown(records, opts);

  if (opts.stdout) {
    process.stdout.write(md);
    return;
  }

  const base = path.basename(file, ".jsonl");
  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.join(os.tmpdir(), `cc-${base}.md`);
  fs.writeFileSync(outPath, md);

  if (opts.out) {
    console.log(outPath);
    return;
  }

  upload(outPath, {
    isPublic: opts.public,
    title: opts.title || `Claude Code session ${base}`,
    open: opts.open,
  });
}

main();
