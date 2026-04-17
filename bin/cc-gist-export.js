#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");

const HELP = `cc-gist-export — export Claude Code session to a GitHub Gist

Usage:
  cc-gist-export [SESSION.jsonl] [options]

If SESSION is omitted, opens a fuzzy picker (fzf) over recent sessions of the
current cwd project, pre-highlighted on the most recent one. Pass --latest to
skip the picker and take the newest session automatically.

Options:
  --public            Public gist (default: secret)
  --open              Open the resulting gist in the browser
  --title <title>     Gist description
  --out <file>        Write markdown to file instead of uploading
  --stdout            Print markdown to stdout (no upload)
  --no-thinking       Skip assistant thinking blocks
  --no-tools          Skip tool_use and tool_result blocks
  --latest            Pick most recent session, skip the picker
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
    latest: false,
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
    else if (a === "--latest") opts.latest = true;
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

function sessionTitle(file) {
  // Read first user text message for a human-friendly title.
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const m = d.message;
      if (d.type !== "user" || !m) continue;
      const c = m.content;
      let text = null;
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) {
        const t = c.find((x) => x && x.type === "text" && x.text);
        if (t) text = t.text;
      }
      if (!text) continue;
      if (/^\s*<(system-reminder|command-name|local-command)/i.test(text))
        continue;
      const clean = text
        .replace(/<command-[^>]*>[^<]*<\/command-[^>]*>/gi, "")
        .replace(/<[^>]+>/g, "")
        .replace(/^\s*(Human|H|User):\s*/i, "")
        .replace(/\s+/g, " ")
        .replace(/^[#>*\-\d.\s]+/, "")
        .trim();
      if (clean) return clean.slice(0, 120);
    }
  } catch {}
  return "(no user prompt)";
}

function humanAge(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function which(cmd) {
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function pickWithFzf(sessions) {
  const lines = sessions
    .map((s, i) => {
      const age = humanAge(s.mtime).padStart(4);
      const title = sessionTitle(s.path);
      return `${String(i).padStart(3)}\t${age}\t${title}\t${s.path}`;
    })
    .join("\n");
  const res = spawnSync(
    "fzf",
    [
      "--ansi",
      "--prompt=session> ",
      "--with-nth=2,3",
      "--nth=2",
      "--delimiter=\t",
      "--tiebreak=begin,index",
      "--height=60%",
      "--reverse",
      "--border",
    ],
    { input: lines, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] },
  );
  if (res.status !== 0) return null;
  const picked = res.stdout.trim();
  if (!picked) return null;
  return picked.split("\t")[3];
}

function pickWithReadline(sessions) {
  console.error("Recent sessions:");
  const shown = sessions.slice(0, 20);
  for (let i = 0; i < shown.length; i++) {
    const age = humanAge(shown[i].mtime);
    console.error(
      `  [${i}] ${age.padStart(4)}  ${sessionTitle(shown[i].path)}`,
    );
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question("Pick [0]: ", (ans) => {
      rl.close();
      const i = ans.trim() === "" ? 0 : Number(ans.trim());
      if (!Number.isInteger(i) || i < 0 || i >= shown.length) {
        console.error("invalid selection");
        process.exit(1);
      }
      resolve(shown[i].path);
    });
  });
}

async function resolveSession(opts) {
  if (opts.file) {
    if (!fs.existsSync(opts.file)) {
      console.error(`not found: ${opts.file}`);
      process.exit(1);
    }
    return opts.file;
  }
  const dir = cwdProjectDir();
  const sessions = listSessions(dir);
  if (!sessions.length) {
    console.error(`no sessions found in ${dir}`);
    process.exit(1);
  }
  if (opts.latest || sessions.length === 1) return sessions[0].path;

  const interactive = process.stdin.isTTY && process.stderr.isTTY;
  if (!interactive) {
    console.error(
      "Non-interactive shell — using latest session. Pass --latest to silence.",
    );
    return sessions[0].path;
  }

  if (which("fzf")) {
    const picked = pickWithFzf(sessions);
    if (!picked) {
      console.error("picker cancelled");
      process.exit(130);
    }
    return picked;
  }
  return pickWithReadline(sessions);
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.list) {
    const dir = cwdProjectDir();
    const sessions = listSessions(dir);
    if (!sessions.length) {
      console.error(`no sessions in ${dir}`);
      process.exit(1);
    }
    for (const s of sessions.slice(0, 20)) {
      console.log(
        `${new Date(s.mtime).toISOString()}  ${sessionTitle(s.path)}  ${s.path}`,
      );
    }
    return;
  }

  const file = await resolveSession(opts);
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
