#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
}

const ALLOWED_COMMANDS = {
  "board-list": ["jira", "board", "list"],
  "ticket-list": ["jira", "workitem", "search"],
  "ticket-show": ["jira", "workitem", "view"],
  "comment-list": ["jira", "workitem", "comment", "list"],
  "comment-add": ["jira", "workitem", "comment", "create"],
  "comment-delete": ["jira", "workitem", "comment", "delete"],
  transition: ["jira", "workitem", "transition"]
};

function printHelp() {
  const payload = {
    name: "local-jira-cli",
    purpose: "Safe thin wrapper around Atlassian ACLI for AI tooling",
    usage: [
      "local-jira-cli --help",
      "local-jira-cli <command> [options]",
      "local-jira-cli ticket-list --jql \"project = TEAM ORDER BY created DESC\" --limit 20"
    ],
    commands: Object.keys(ALLOWED_COMMANDS),
    commonOptions: [
      "--json (always forced to true)",
      "--dry-run (print resolved ACLI command only)",
      "--yes (required for write commands unless --dry-run)",
      "--project <KEY> (used with ticket-list when JQL is omitted)"
    ]
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(code, message, details) {
  process.stderr.write(`${JSON.stringify({ ok: false, code, message, details }, null, 2)}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const [k, vInline] = a.split("=", 2);
    const key = k.slice(2);
    if (vInline !== undefined) {
      out[key] = vInline;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function isWriteCommand(cmd) {
  return cmd === "comment-add" || cmd === "comment-delete" || cmd === "transition";
}

function resolveAcliBinary() {
  return process.env.ACLI_PATH || "acli";
}

function buildAcliArgs(command, args) {
  const base = [...ALLOWED_COMMANDS[command]];
  const pushIf = (flag, key) => {
    if (args[key] !== undefined && args[key] !== true) {
      base.push(flag, String(args[key]));
    }
  };

  if (command === "ticket-list") {
    if (!args.jql) {
      const project = args.project || process.env.JIRA_DEFAULT_PROJECT;
      if (!project) {
        fail("VALIDATION_ERROR", "ticket-list requires --jql or --project or JIRA_DEFAULT_PROJECT");
      }
      args.jql = `project = ${project} ORDER BY updated DESC`;
    }
    pushIf("--jql", "jql");
    pushIf("--limit", "limit");
  }

  if (command === "ticket-show") {
    pushIf("--key", "key");
  }

  if (command === "comment-list") {
    pushIf("--key", "key");
    pushIf("--limit", "limit");
    pushIf("--order", "order");
  }

  if (command === "comment-add") {
    pushIf("--key", "key");
    pushIf("--body", "body");
    pushIf("--body-file", "body-file");
  }

  if (command === "comment-delete") {
    pushIf("--key", "key");
    pushIf("--id", "id");
  }

  if (command === "transition") {
    pushIf("--key", "key");
    pushIf("--status", "status");
  }

  if (command !== "board-list") {
    if (!base.includes("--key") && ["ticket-show", "comment-list", "comment-add", "comment-delete", "transition"].includes(command)) {
      if (!args.key) fail("VALIDATION_ERROR", `${command} requires --key`);
    }
  }

  if (command === "comment-add" && !args.body && !args["body-file"]) {
    fail("VALIDATION_ERROR", "comment-add requires --body or --body-file");
  }
  if (command === "comment-delete" && !args.id) {
    fail("VALIDATION_ERROR", "comment-delete requires --id");
  }
  if (command === "transition" && !args.status) {
    fail("VALIDATION_ERROR", "transition requires --status");
  }

  if (isWriteCommand(command)) {
    if (!args.yes && !args["dry-run"]) {
      fail("CONFIRMATION_REQUIRED", "Write command requires --yes (or use --dry-run)");
    }
    base.push("--yes");
  }

  base.push("--json");
  return base;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;

  if (!command || args.help || command === "--help" || command === "help") {
    printHelp();
    return;
  }

  if (!ALLOWED_COMMANDS[command]) {
    fail("UNKNOWN_COMMAND", `Unsupported command: ${command}`, { allowed: Object.keys(ALLOWED_COMMANDS) });
  }

  const acli = resolveAcliBinary();
  const acliArgs = buildAcliArgs(command, args);

  if (args["dry-run"]) {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, cmd: [acli, ...acliArgs] }, null, 2)}\n`);
    return;
  }

  const result = spawnSync(acli, acliArgs, { encoding: "utf8" });

  if (result.error) {
    fail("EXEC_ERROR", "Failed to execute ACLI", { message: result.error.message, command: [acli, ...acliArgs] });
  }

  if (result.status !== 0) {
    fail("ACLI_ERROR", "ACLI returned non-zero exit status", {
      exitCode: result.status,
      stderr: (result.stderr || "").trim(),
      command: [acli, ...acliArgs]
    });
  }

  const stdout = (result.stdout || "").trim();
  if (!stdout) {
    process.stdout.write(`${JSON.stringify({ ok: true, result: null }, null, 2)}\n`);
    return;
  }

  try {
    const parsed = JSON.parse(stdout);
    process.stdout.write(`${JSON.stringify({ ok: true, result: parsed }, null, 2)}\n`);
  } catch (e) {
    fail("PARSE_ERROR", "ACLI output is not valid JSON", { raw: stdout.slice(0, 1000) });
  }
}

main();
