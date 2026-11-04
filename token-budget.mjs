#!/usr/bin/env node
// token-budget: a Claude Code PreToolUse hook that stops a session once it has spent its token budget.
// Plain Node 22, built-in modules only. Everything runs at top level, so it works through a symlink.
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const VERSION = '0.1.0';
const DEFAULT_BUDGET = 10000000;
const KINDS = ['all', 'no-cache-read', 'input+output', 'output'];
const EVENT = 'PreToolUse';

const USAGE = `token-budget ${VERSION}: stop your AI agent when it has spent its token budget.

Usage:
  token-budget                       Claude Code PreToolUse hook: reads the hook JSON on stdin
  token-budget check <transcript.jsonl> [--budget <n>] [--warn-at <fraction>] [--count <kind>] [--json]
  token-budget --help | -h           this text
  token-budget --version             prints ${VERSION}

Count kinds (--count, or "count" in token-budget.json):
  all             input + output + cache creation + cache read (default)
  no-cache-read   input + output + cache creation
  input+output    input + output
  output          output only

Budget: --budget, then the TOKEN_BUDGET environment variable, then "budget" in
token-budget.json, then ${DEFAULT_BUDGET}. Warn at: --warn-at, then "warn_at" in token-budget.json.

Exit codes of check: 0 under, 1 warn, 3 over, 2 usage error, 4 something cannot be read.
In hook mode the exit code is always 0; the answer is on stdout (nothing when under).
`;

class UsageError extends Error {}
class Unreadable extends Error {}

const oneLine = (text) => String(text).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// ---------- settings ----------

function validBudget(text) {
  if (!/^[0-9]+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function validWarnAt(text) {
  if (!/^0?\.[0-9]+$/.test(text)) return null;
  const n = Number(text);
  return n > 0 && n < 1 ? n : null;
}

function readConfigFile(dir) {
  const file = resolve(dir, 'token-budget.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return {};
    throw new Unreadable(`token-budget.json (${file}) cannot be read: ${error && error.code ? error.code : error}`);
  }
  let value;
  try {
    value = JSON.parse(stripBom(text));
  } catch (error) {
    throw new Unreadable(`token-budget.json (${file}) is not valid JSON: ${error.message}`);
  }
  if (!isObject(value)) throw new Unreadable(`token-budget.json (${file}) must hold a JSON object`);
  const out = {};
  if (has(value, 'budget')) {
    const b = value.budget;
    if (typeof b !== 'number' || !Number.isSafeInteger(b) || b <= 0) {
      throw new Unreadable(`"budget" in token-budget.json (${file}) must be a whole number above 0`);
    }
    out.budget = b;
  }
  if (has(value, 'warn_at')) {
    const w = value.warn_at;
    if (typeof w !== 'number' || !(w > 0 && w < 1)) {
      throw new Unreadable(`"warn_at" in token-budget.json (${file}) must be a number above 0 and below 1`);
    }
    out.warn_at = w;
  }
  if (has(value, 'count')) {
    if (typeof value.count !== 'string' || !KINDS.includes(value.count)) {
      throw new Unreadable(`"count" in token-budget.json (${file}) must be one of ${KINDS.join(', ')}`);
    }
    out.count = value.count;
  }
  return out;
}

// flags: { budget?, warnAt?, count? } already validated. configDir: where token-budget.json is looked for.
function resolveSettings(flags, configDir) {
  let envBudget;
  const raw = process.env.TOKEN_BUDGET;
  if (raw !== undefined && raw !== '') {
    envBudget = validBudget(raw);
    if (envBudget === null) {
      throw new Unreadable('the environment variable TOKEN_BUDGET must be digits only, a whole number above 0 (for example 500000)');
    }
  }
  const file = readConfigFile(configDir);
  return {
    budget: flags.budget ?? envBudget ?? file.budget ?? DEFAULT_BUDGET,
    warnAt: flags.warnAt ?? file.warn_at ?? null,
    mode: flags.count ?? file.count ?? 'all',
  };
}

// ---------- the transcript ----------

function readTranscript(path) {
  const byId = new Map();
  const loose = { input: 0, output: 0, cache_creation: 0, cache_read: 0 };
  let looseCount = 0;
  let sawObject = false;
  let hasContent = false;
  let first = true;

  const num = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

  const handle = (line) => {
    if (first) {
      first = false;
      line = stripBom(line);
    }
    // Once a JSON object has been seen, a line that cannot be an assistant line is not parsed at all.
    if (sawObject && !line.includes('assistant') && !line.includes('\\u')) return;
    if (line.trim() === '') return;
    hasContent = true;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(obj)) return;
    sawObject = true;
    if (obj.type !== 'assistant' || !isObject(obj.message)) return;
    const message = obj.message;
    const usage = isObject(message.usage) ? message.usage : {};
    const i = num(usage.input_tokens);
    const o = num(usage.output_tokens);
    const cc = num(usage.cache_creation_input_tokens);
    const cr = num(usage.cache_read_input_tokens);
    const id = message.id;
    if (typeof id === 'string' && id !== '') {
      const seen = byId.get(id);
      if (seen) {
        if (i > seen[0]) seen[0] = i;
        if (o > seen[1]) seen[1] = o;
        if (cc > seen[2]) seen[2] = cc;
        if (cr > seen[3]) seen[3] = cr;
      } else {
        byId.set(id, [i, o, cc, cr]);
      }
    } else {
      loose.input += i;
      loose.output += o;
      loose.cache_creation += cc;
      loose.cache_read += cr;
      looseCount += 1;
    }
  };

  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(4 * 1024 * 1024);
    let parts = []; // bytes of the line that is not finished yet
    let n;
    while ((n = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      const view = chunk.subarray(0, n);
      let start = 0;
      for (;;) {
        const nl = view.indexOf(10, start);
        if (nl === -1) {
          if (start < n) parts.push(Buffer.from(view.subarray(start)));
          break;
        }
        const segment = view.subarray(start, nl);
        if (parts.length) {
          parts.push(Buffer.from(segment));
          handle(Buffer.concat(parts).toString('utf8'));
          parts = [];
        } else {
          handle(segment.toString('utf8'));
        }
        start = nl + 1;
      }
    }
    if (parts.length) handle(Buffer.concat(parts).toString('utf8'));
  } finally {
    closeSync(fd);
  }

  if (hasContent && !sawObject) throw new Unreadable(`the transcript ${path} has content but no line that is a JSON object, so it is not a transcript`);

  const tokens = { ...loose };
  for (const [i, o, cc, cr] of byId.values()) {
    tokens.input += i;
    tokens.output += o;
    tokens.cache_creation += cc;
    tokens.cache_read += cr;
  }
  return { tokens, messages: byId.size + looseCount };
}

// ---------- the decision ----------

function countedFor(tokens, mode) {
  switch (mode) {
    case 'all': return tokens.input + tokens.output + tokens.cache_creation + tokens.cache_read;
    case 'no-cache-read': return tokens.input + tokens.output + tokens.cache_creation;
    case 'input+output': return tokens.input + tokens.output;
    default: return tokens.output;
  }
}

function decide(counted, budget, warnAt) {
  if (counted >= budget) return { status: 'over', decision: 'deny' };
  if (warnAt !== null && counted >= budget * warnAt) return { status: 'warn', decision: 'ask' };
  return { status: 'under', decision: 'allow' };
}

function reasonFor(status, counted, budget, mode, tokens) {
  const head = status === 'over'
    ? `token-budget: budget reached. This session has used ${counted} tokens (count kind ${mode}), which reaches the budget of ${budget} tokens.`
    : `token-budget: warning. This session has used ${counted} tokens (count kind ${mode}) of its budget of ${budget} tokens.`;
  const cache = mode === 'all'
    ? ` The count includes cache read: ${tokens.cache_read} tokens (set count to no-cache-read to leave cache reads out).`
    : '';
  return `${head}${cache} To raise the budget, set the TOKEN_BUDGET environment variable or "budget" in token-budget.json.`;
}

function evaluate(transcript, settings) {
  const { tokens, messages } = readTranscript(transcript);
  const counted = countedFor(tokens, settings.mode);
  const { status, decision } = decide(counted, settings.budget, settings.warnAt);
  const reason = status === 'under' ? null : oneLine(reasonFor(status, counted, settings.budget, settings.mode, tokens));
  return { status, decision, counted, budget: settings.budget, warn_at: settings.warnAt, mode: settings.mode, tokens, messages, reason };
}

// ---------- output ----------

function write(stream, text) {
  stream.write(text);
}

function hookAnswer(decision, reason) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: EVENT, permissionDecision: decision, permissionDecisionReason: reason },
  }) + '\n';
}

// ---------- hook mode ----------

async function readStdin() {
  if (process.stdin.isTTY) {
    process.stderr.write('token-budget: hook mode reads the hook JSON on stdin; for a first run use: token-budget check <transcript.jsonl>\n');
    return '';
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function hook() {
  try {
    const text = await readStdin();
    let input;
    try {
      input = JSON.parse(stripBom(text));
    } catch {
      throw new Unreadable('the hook input on stdin is not valid JSON');
    }
    if (!isObject(input)) throw new Unreadable('the hook input on stdin is not a JSON object');
    if (typeof input.hook_event_name === 'string' && input.hook_event_name !== EVENT) return;
    if (typeof input.transcript_path !== 'string' || input.transcript_path === '') {
      throw new Unreadable('the hook input has no transcript_path');
    }
    const transcript = resolve(process.cwd(), input.transcript_path);
    const dir = typeof input.cwd === 'string' && input.cwd !== '' ? resolve(process.cwd(), input.cwd) : process.cwd();
    const settings = resolveSettings({}, dir);
    let result;
    try {
      result = evaluate(transcript, settings);
    } catch (error) {
      if (error instanceof Unreadable) throw error;
      throw new Unreadable(`the transcript ${transcript} cannot be read: ${error && error.code ? error.code : error && error.message}`);
    }
    if (result.status !== 'under') write(process.stdout, hookAnswer(result.decision, result.reason));
  } catch (error) {
    const what = error instanceof Unreadable ? error.message : `token-budget failed unexpectedly: ${error && error.message}`;
    const reason = oneLine(`token-budget could not check the budget: ${what}. The budget is therefore not being enforced for this tool call; fix the problem, or choose whether to continue.`);
    write(process.stdout, hookAnswer('ask', reason));
  }
  process.exitCode = 0;
}

// ---------- check ----------

function parseCheck(args) {
  const flags = {};
  const seen = new Set();
  let json = false;
  let path = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      if (seen.has(arg)) throw new UsageError('--json given twice');
      seen.add(arg);
      json = true;
    } else if (arg === '--budget' || arg === '--warn-at' || arg === '--count') {
      if (seen.has(arg)) throw new UsageError(`${arg} given twice`);
      seen.add(arg);
      if (i + 1 >= args.length) throw new UsageError(`${arg} needs a value`);
      const value = args[++i];
      if (arg === '--budget') {
        flags.budget = validBudget(value);
        if (flags.budget === null) throw new UsageError(`--budget must be a whole number above 0 written with digits only, not "${value}"`);
      } else if (arg === '--warn-at') {
        flags.warnAt = validWarnAt(value);
        if (flags.warnAt === null) throw new UsageError(`--warn-at must be a decimal number above 0 and below 1 (0.8 or .8), not "${value}"`);
      } else {
        if (!KINDS.includes(value)) throw new UsageError(`--count must be one of ${KINDS.join(', ')}, not "${value}"`);
        flags.count = value;
      }
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option ${arg}`);
    } else if (path !== null) {
      throw new UsageError('check takes exactly one transcript, but got more than one');
    } else {
      path = arg;
    }
  }
  if (path === null) throw new UsageError('check needs a transcript path');
  return { flags, json, path };
}

function check(args) {
  const { flags, json, path } = parseCheck(args);
  const transcript = resolve(process.cwd(), path);
  try {
    statSync(transcript);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) throw new UsageError(`the transcript ${path} does not exist`);
    throw new Unreadable(`the transcript ${path} cannot be read: ${error && error.code ? error.code : error}`);
  }
  const settings = resolveSettings(flags, process.cwd());
  let result;
  try {
    result = evaluate(transcript, settings);
  } catch (error) {
    if (error instanceof Unreadable) throw error;
    throw new Unreadable(`the transcript ${path} cannot be read: ${error && error.code ? error.code : error && error.message}`);
  }
  if (json) {
    write(process.stdout, JSON.stringify({ tool: 'token-budget', version: VERSION, ...result }) + '\n');
  } else {
    const t = result.tokens;
    write(process.stdout, [
      `${result.status}: ${result.counted} of ${result.budget} tokens (${result.mode})`,
      `input_tokens: ${t.input}`,
      `output_tokens: ${t.output}`,
      `cache_creation_input_tokens: ${t.cache_creation}`,
      `cache_read_input_tokens: ${t.cache_read}`,
      `messages: ${result.messages}`,
    ].join('\n') + '\n');
  }
  process.exitCode = result.status === 'over' ? 3 : result.status === 'warn' ? 1 : 0;
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2);
  try {
    if (args.length === 0) {
      await hook();
    } else if (args[0] === 'check') {
      check(args.slice(1));
    } else if (args[0] === '--help' || args[0] === '-h' || args[0] === '--version') {
      if (args.length > 1) throw new UsageError(`${args[0]} is only valid alone`);
      write(process.stdout, args[0] === '--version' ? `${VERSION}\n` : USAGE);
    } else {
      throw new UsageError(`unknown command or option ${args[0]}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`token-budget: ${oneLine(error.message)}\nRun token-budget --help for usage.\n`);
      process.exitCode = 2;
    } else if (error instanceof Unreadable) {
      process.stderr.write(`token-budget: ${oneLine(error.message)}\n`);
      process.exitCode = 4;
    } else {
      process.stderr.write(`token-budget: unexpected error: ${oneLine(error && error.message)}\n`);
      process.exitCode = 4;
    }
  }
}

await main();
