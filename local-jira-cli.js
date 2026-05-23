#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
}

const COMMANDS = {
  "board-list": {
    acli: ["jira", "board", "search"],
    write: false,
    supportsJson: true,
    supportsAcliYes: false,
    flags: {
      project: "--project",
      name: "--name",
      type: "--type",
      limit: "--limit",
      "order-by": "--order-by"
    }
  },
  "ticket-list": {
    acli: ["jira", "workitem", "search"],
    write: false,
    supportsJson: true,
    supportsAcliYes: false,
    flags: {
      jql: "--jql",
      limit: "--limit",
      fields: "--fields"
    },
    synthesize(args) {
      if (!args.jql) {
        const project = args.project || process.env.JIRA_DEFAULT_PROJECT;
        if (!project) {
          return "ticket-list requires --jql or --project or JIRA_DEFAULT_PROJECT";
        }
        args.jql = `project = ${project} ORDER BY updated DESC`;
      }
      return null;
    }
  },
  "ticket-show": {
    acli: ["jira", "workitem", "view"],
    write: false,
    supportsJson: true,
    supportsAcliYes: false,
    positional: ["key"],
    required: ["key"],
    flags: {
      fields: "--fields"
    }
  },
  "comment-list": {
    acli: ["jira", "workitem", "comment", "list"],
    write: false,
    supportsJson: true,
    supportsAcliYes: false,
    required: ["key"],
    flags: {
      key: "--key",
      limit: "--limit",
      order: "--order"
    }
  },
  "comment-add": {
    acli: ["jira", "workitem", "comment", "create"],
    write: true,
    supportsJson: true,
    supportsAcliYes: false,
    required: ["key"],
    flags: {
      key: "--key",
      body: "--body",
      "body-file": "--body-file"
    },
    validate(args) {
      const hasBody = Boolean(args.body);
      const hasFile = Boolean(args["body-file"]);
      if (!hasBody && !hasFile) return "comment-add requires --body or --body-file";
      if (hasBody && hasFile) return "comment-add accepts only one of --body or --body-file";
      return null;
    }
  },
  "comment-delete": {
    acli: ["jira", "workitem", "comment", "delete"],
    write: true,
    supportsJson: false,
    supportsAcliYes: false,
    required: ["key", "id"],
    flags: {
      key: "--key",
      id: "--id"
    }
  },
  transition: {
    acli: ["jira", "workitem", "transition"],
    write: true,
    supportsJson: true,
    supportsAcliYes: true,
    required: ["key", "status"],
    flags: {
      key: "--key",
      status: "--status"
    }
  }
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
    commands: Object.keys(COMMANDS),
    commonOptions: [
      "--json (forced when the underlying acli command supports it)",
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

function resolveAcliBinary() {
  return process.env.ACLI_PATH || "acli";
}

function buildAcliArgs(name, spec, args) {
  if (typeof spec.synthesize === "function") {
    const err = spec.synthesize(args);
    if (err) fail("VALIDATION_ERROR", err);
  }

  for (const req of spec.required || []) {
    if (args[req] === undefined || args[req] === true) {
      fail("VALIDATION_ERROR", `${name} requires --${req}`);
    }
  }

  if (typeof spec.validate === "function") {
    const err = spec.validate(args);
    if (err) fail("VALIDATION_ERROR", err);
  }

  if (spec.write && !args.yes && !args["dry-run"]) {
    fail("CONFIRMATION_REQUIRED", `${name} is a write command — pass --yes (or use --dry-run)`);
  }

  const out = [...spec.acli];

  for (const key of spec.positional || []) {
    out.push(String(args[key]));
  }

  const positionalSet = new Set(spec.positional || []);
  for (const [argKey, flag] of Object.entries(spec.flags || {})) {
    if (positionalSet.has(argKey)) continue;
    const v = args[argKey];
    if (v === undefined || v === true) continue;
    out.push(flag, String(v));
  }

  if (spec.supportsAcliYes) out.push("--yes");
  if (spec.supportsJson) out.push("--json");

  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;

  if (!command || args.help || command === "--help" || command === "help") {
    printHelp();
    return;
  }

  const spec = COMMANDS[command];
  if (!spec) {
    fail("UNKNOWN_COMMAND", `Unsupported command: ${command}`, { allowed: Object.keys(COMMANDS) });
  }

  const acli = resolveAcliBinary();
  const acliArgs = buildAcliArgs(command, spec, args);

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

  if (!spec.supportsJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, result: { stdout } }, null, 2)}\n`);
    return;
  }

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
