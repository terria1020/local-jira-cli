#!/usr/bin/env node
"use strict";

const fs = require("fs");
const https = require("https");
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
  "ticket-context": {
    handler: runTicketContext,
    write: false,
    required: ["key"]
  },
  "ticket-tree": {
    handler: runTicketTree,
    write: false,
    required: ["key"]
  },
  "transition-list": {
    handler: runTransitionList,
    write: false,
    required: ["key"]
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
  },
  "project-overview": {
    handler: runProjectOverview,
    write: false,
    synthesize(args) {
      if (!args.project) {
        const project = process.env.JIRA_DEFAULT_PROJECT;
        if (!project) return "project-overview requires --project or JIRA_DEFAULT_PROJECT";
        args.project = project;
      }
      return null;
    }
  },
  "ticket-update": {
    acli: ["jira", "workitem", "edit"],
    write: true,
    supportsJson: true,
    supportsAcliYes: true,
    required: ["key"],
    flags: {
      key: "--key",
      summary: "--summary",
      "description-file": "--description-file",
      labels: "--labels",
      "remove-labels": "--remove-labels",
      assignee: "--assignee",
      "remove-assignee": { flag: "--remove-assignee", boolean: true }
    },
    validate(args) {
      const editable = ["summary", "description-file", "labels", "remove-labels", "assignee", "remove-assignee"];
      if (!editable.some((key) => args[key] !== undefined)) {
        return "ticket-update requires one of --summary, --description-file, --labels, --remove-labels, --assignee, --remove-assignee";
      }
      if (args["description-file"] !== undefined) {
        if (args["description-file"] === true) return "ticket-update requires a file path for --description-file";
        const descriptionPath = path.resolve(process.cwd(), expandHome(String(args["description-file"])));
        if (!fs.existsSync(descriptionPath)) return `description file does not exist: ${descriptionPath}`;
        if (!fs.statSync(descriptionPath).isFile()) return `description path is not a file: ${descriptionPath}`;
      }
      return null;
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
      "local-jira-cli ticket-list --jql \"project = TEAM ORDER BY created DESC\" --limit 20",
      "local-jira-cli ticket-context --key TEAM-123 --comments 10"
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

function validateSpec(name, spec, args) {
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
}

function buildAcliArgs(name, spec, args) {
  validateSpec(name, spec, args);

  const out = [...spec.acli];

  for (const key of spec.positional || []) {
    out.push(String(args[key]));
  }

  const positionalSet = new Set(spec.positional || []);
  for (const [argKey, flagSpec] of Object.entries(spec.flags || {})) {
    if (positionalSet.has(argKey)) continue;
    const v = args[argKey];
    if (v === undefined) continue;

    const flag = typeof flagSpec === "string" ? flagSpec : flagSpec.flag;
    const isBoolean = typeof flagSpec === "object" && flagSpec.boolean;
    if (isBoolean) {
      if (v === true) out.push(flag);
      continue;
    }

    if (v === true) continue;
    out.push(flag, String(v));
  }

  if (spec.supportsAcliYes) out.push("--yes");
  if (spec.supportsJson) out.push("--json");

  return out;
}

function executeAcli(acli, acliArgs, spec, options = {}) {
  const handleFailure = (code, message, details) => {
    if (options.throwOnError) {
      const err = new Error(message);
      err.code = code;
      err.details = details;
      throw err;
    }
    fail(code, message, details);
  };

  const result = spawnSync(acli, acliArgs, { encoding: "utf8" });

  if (result.error) {
    handleFailure("EXEC_ERROR", "Failed to execute ACLI", { message: result.error.message, command: [acli, ...acliArgs] });
  }

  if (result.status !== 0) {
    handleFailure("ACLI_ERROR", "ACLI returned non-zero exit status", {
      exitCode: result.status,
      stderr: (result.stderr || "").trim(),
      command: [acli, ...acliArgs]
    });
  }

  const stdout = (result.stdout || "").trim();

  if (!spec.supportsJson) {
    return { stdout };
  }

  if (!stdout) {
    return null;
  }

  try {
    return JSON.parse(stdout);
  } catch (e) {
    handleFailure("PARSE_ERROR", "ACLI output is not valid JSON", { raw: stdout.slice(0, 1000) });
  }
}

function runAcliJson(acli, acliArgs) {
  return executeAcli(acli, acliArgs, { supportsJson: true });
}

function tryRunAcliJson(acli, acliArgs) {
  return executeAcli(acli, acliArgs, { supportsJson: true }, { throwOnError: true });
}

function asInt(value, fallback) {
  if (value === undefined || value === true) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function compactUser(user) {
  if (!user) return null;
  if (typeof user === "string") return { displayName: user };
  return {
    accountId: user.accountId || null,
    displayName: user.displayName || user.name || null,
    emailAddress: user.emailAddress || null
  };
}

function compactNamed(value) {
  if (!value) return null;
  if (typeof value === "string") return { name: value };
  return {
    id: value.id || null,
    key: value.key || null,
    name: value.name || value.value || null
  };
}

function adfToText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  const parts = [];

  function visit(node) {
    if (!node) return;
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (node.text) parts.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(visit);
    if (["paragraph", "heading", "blockquote", "listItem"].includes(node.type)) parts.push("\n");
    if (node.type === "hardBreak") parts.push("\n");
  }

  visit(value);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeIssue(issue) {
  if (!issue) return null;
  const fields = issue.fields || {};
  return {
    id: issue.id || null,
    key: issue.key || null,
    summary: fields.summary || null,
    issueType: compactNamed(fields.issuetype),
    status: compactNamed(fields.status),
    statusCategory: compactNamed(fields.status && fields.status.statusCategory),
    assignee: compactUser(fields.assignee),
    reporter: compactUser(fields.reporter),
    priority: compactNamed(fields.priority),
    labels: fields.labels || [],
    project: compactNamed(fields.project),
    created: fields.created || null,
    updated: fields.updated || null,
    descriptionText: adfToText(fields.description),
    self: issue.self || null
  };
}

function normalizeIssueRef(issue) {
  if (!issue) return null;
  const fields = issue.fields || {};
  return {
    id: issue.id || null,
    key: issue.key || null,
    summary: fields.summary || issue.summary || null,
    issueType: compactNamed(fields.issuetype || issue.issuetype),
    status: compactNamed(fields.status || issue.status),
    priority: compactNamed(fields.priority || issue.priority),
    self: issue.self || null
  };
}

function normalizeComments(payload) {
  const comments = payload && (payload.comments || payload.result && payload.result.comments);
  if (!Array.isArray(comments)) return [];
  return comments.map((comment) => ({
    id: comment.id || null,
    author: compactUser(comment.author),
    created: comment.created || null,
    updated: comment.updated || null,
    visibility: comment.visibility || (comment.jsdPublic === true ? "public" : null),
    bodyText: adfToText(comment.body)
  }));
}

function normalizeLinks(links) {
  if (!Array.isArray(links)) return [];
  return links.map((link) => ({
    id: link.id || null,
    type: link.type && (link.type.name || link.type.inward || link.type.outward) || null,
    inwardIssue: normalizeIssueRef(link.inwardIssue),
    outwardIssue: normalizeIssueRef(link.outwardIssue)
  }));
}

function viewIssue(acli, key, fields) {
  return runAcliJson(acli, ["jira", "workitem", "view", key, "--fields", fields, "--json"]);
}

function searchIssues(acli, jql, limit, fields) {
  return runAcliJson(acli, [
    "jira",
    "workitem",
    "search",
    "--jql",
    jql,
    "--limit",
    String(limit),
    "--fields",
    fields,
    "--json"
  ]);
}

function printOk(result) {
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
}

function printDryRun(steps) {
  process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, steps }, null, 2)}\n`);
}

function runTicketContext(name, spec, args, acli) {
  validateSpec(name, spec, args);
  const key = String(args.key);
  const commentLimit = asInt(args.comments, 10);
  const fields = "summary,status,assignee,reporter,description,labels,priority,parent,subtasks,issuelinks,created,updated,project,issuetype";
  const steps = [
    [acli, "jira", "workitem", "view", key, "--fields", fields, "--json"]
  ];
  if (commentLimit > 0) {
    steps.push([acli, "jira", "workitem", "comment", "list", "--key", key, "--limit", String(commentLimit), "--json"]);
  }
  if (args["dry-run"]) return printDryRun(steps);

  const issue = viewIssue(acli, key, fields);
  const comments = commentLimit > 0
    ? runAcliJson(acli, ["jira", "workitem", "comment", "list", "--key", key, "--limit", String(commentLimit), "--json"])
    : { comments: [] };
  const issueFields = issue.fields || {};

  return printOk({
    issue: normalizeIssue(issue),
    parent: normalizeIssueRef(issueFields.parent),
    subtasks: Array.isArray(issueFields.subtasks) ? issueFields.subtasks.map(normalizeIssueRef) : [],
    links: normalizeLinks(issueFields.issuelinks),
    comments: normalizeComments(comments),
    commentTotal: comments.total || normalizeComments(comments).length
  });
}

function buildIssueTree(acli, key, depth, limit, warnings, seen) {
  if (seen.has(key)) return { key, cycle: true };
  seen.add(key);

  const fields = "summary,status,assignee,priority,parent,subtasks,issuetype";
  const issue = viewIssue(acli, key, fields);
  const issueFields = issue.fields || {};

  if (depth <= 0) {
    return {
      issue: normalizeIssue(issue),
      parent: normalizeIssueRef(issueFields.parent),
      children: []
    };
  }

  const staticSubtasks = Array.isArray(issueFields.subtasks) ? issueFields.subtasks : [];
  let jqlChildren = [];

  try {
    const searchResult = tryRunAcliJson(acli, [
      "jira",
      "workitem",
      "search",
      "--jql",
      `parent = ${key} ORDER BY created ASC`,
      "--limit",
      String(limit),
      "--fields",
      "key,issuetype,summary,status,assignee,priority",
      "--json"
    ]);
    jqlChildren = Array.isArray(searchResult) ? searchResult : [];
  } catch (e) {
    warnings.push(`child search failed for ${key}`);
  }

  const byKey = new Map();
  for (const child of [...staticSubtasks, ...jqlChildren]) {
    if (child && child.key) byKey.set(child.key, child);
  }

  const children = [];
  for (const child of byKey.values()) {
    children.push(buildIssueTree(acli, child.key, depth - 1, limit, warnings, new Set(seen)));
  }

  return {
    issue: normalizeIssue(issue),
    parent: normalizeIssueRef(issueFields.parent),
    children
  };
}

function runTicketTree(name, spec, args, acli) {
  validateSpec(name, spec, args);
  const key = String(args.key);
  const depth = asInt(args.depth, 2);
  const limit = asInt(args.limit, 50);
  if (args["dry-run"]) {
    return printDryRun([
      [acli, "jira", "workitem", "view", key, "--fields", "summary,status,assignee,priority,parent,subtasks,issuetype", "--json"],
      [acli, "jira", "workitem", "search", "--jql", `parent = ${key} ORDER BY created ASC`, "--limit", String(limit), "--fields", "key,issuetype,summary,status,assignee,priority", "--json"]
    ]);
  }

  const warnings = [];
  return printOk({
    root: buildIssueTree(acli, key, depth, limit, warnings, new Set()),
    warnings
  });
}

function runProjectOverview(name, spec, args, acli) {
  validateSpec(name, spec, args);
  const project = String(args.project);
  const limit = asInt(args.limit, 20);
  const boardLimit = asInt(args["board-limit"], 5);
  const sprintLimit = asInt(args["sprint-limit"], 5);
  const issueFields = "key,issuetype,summary,status,assignee,priority";
  const steps = [
    [acli, "jira", "board", "search", "--project", project, "--limit", String(boardLimit), "--json"],
    [acli, "jira", "workitem", "search", "--jql", `project = ${project} ORDER BY updated DESC`, "--limit", String(limit), "--fields", issueFields, "--json"]
  ];
  if (args["dry-run"]) return printDryRun(steps);

  const warnings = [];
  const boards = runAcliJson(acli, ["jira", "board", "search", "--project", project, "--limit", String(boardLimit), "--json"]);
  const issues = searchIssues(acli, `project = ${project} ORDER BY updated DESC`, limit, issueFields);
  const boardValues = boards && Array.isArray(boards.values) ? boards.values : [];
  const sprintsByBoard = {};

  for (const board of boardValues) {
    if (!board.id || board.type !== "scrum") continue;
    try {
      sprintsByBoard[board.id] = tryRunAcliJson(acli, [
        "jira",
        "board",
        "list-sprints",
        "--id",
        String(board.id),
        "--state",
        "active,future",
        "--limit",
        String(sprintLimit),
        "--json"
      ]);
    } catch (e) {
      warnings.push(`sprint list failed for board ${board.id}`);
    }
  }

  const normalizedIssues = Array.isArray(issues) ? issues.map(normalizeIssue) : [];
  const statusCounts = {};
  for (const issue of normalizedIssues) {
    const status = issue.status && issue.status.name || "Unknown";
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }

  return printOk({
    project,
    boards,
    sprintsByBoard,
    recentIssues: normalizedIssues,
    recentIssueStatusCounts: statusCounts,
    warnings
  });
}

function normalizeSite(site) {
  if (!site) return null;
  const value = String(site).trim();
  if (!value) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) return value.replace(/\/+$/, "");
  return `https://${value.replace(/\/+$/, "")}`;
}

function expandHome(filePath) {
  if (!filePath) return filePath;
  const value = String(filePath);
  if (value === "~") return process.env.HOME;
  if (value.startsWith("~/")) return path.join(process.env.HOME || "", value.slice(2));
  return value;
}

function readToken(args) {
  if (process.env.JIRA_API_TOKEN) return process.env.JIRA_API_TOKEN;
  const tokenFile = args["token-file"] || process.env.JIRA_API_TOKEN_FILE;
  if (!tokenFile) return null;
  const resolved = path.resolve(process.cwd(), expandHome(tokenFile));
  if (!fs.existsSync(resolved)) {
    fail("CONFIG_REQUIRED", `Jira API token file does not exist: ${resolved}`);
  }
  return fs.readFileSync(resolved, "utf8").trim();
}

function jiraRestGet(pathname, args) {
  const baseUrl = normalizeSite(args.site || process.env.JIRA_BASE_URL || process.env.JIRA_SITE);
  const email = args.email || process.env.JIRA_EMAIL;
  const token = readToken(args);
  if (!baseUrl || !email || !token) {
    fail("CONFIG_REQUIRED", "transition-list requires JIRA_BASE_URL/JIRA_SITE, JIRA_EMAIL, and JIRA_API_TOKEN or JIRA_API_TOKEN_FILE for Jira REST access");
  }

  const url = new URL(pathname, baseUrl);
  const auth = Buffer.from(`${email}:${token}`).toString("base64");

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${auth}`
      }
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Jira REST returned ${res.statusCode}: ${body.slice(0, 1000)}`));
          return;
        }
        try {
          resolve(body ? JSON.parse(body) : null);
        } catch (e) {
          reject(new Error(`Jira REST output is not valid JSON: ${body.slice(0, 1000)}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function runTransitionList(name, spec, args) {
  validateSpec(name, spec, args);
  const key = String(args.key);
  const restPath = `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
  if (args["dry-run"]) {
    return printDryRun([["GET", restPath]]);
  }

  try {
    const payload = await jiraRestGet(restPath, args);
    return printOk({
      key,
      transitions: (payload.transitions || []).map((transition) => ({
        id: transition.id,
        name: transition.name,
        to: compactNamed(transition.to),
        hasScreen: transition.hasScreen || false,
        isGlobal: transition.isGlobal || false,
        isInitial: transition.isInitial || false
      }))
    });
  } catch (e) {
    fail("REST_ERROR", "Failed to fetch Jira transitions", { message: e.message });
  }
}

async function main() {
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

  if (typeof spec.handler === "function") {
    await spec.handler(command, spec, args, acli);
    return;
  }

  const acliArgs = buildAcliArgs(command, spec, args);

  if (args["dry-run"]) {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, cmd: [acli, ...acliArgs] }, null, 2)}\n`);
    return;
  }

  printOk(executeAcli(acli, acliArgs, spec));
}

main().catch((e) => {
  fail("UNEXPECTED_ERROR", "Unexpected failure", { message: e.message });
});
