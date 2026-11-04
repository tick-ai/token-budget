import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../token-budget.mjs', import.meta.url));
const NO_ENV = ['TOKEN_BUDGET'];

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'token-budget test-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(args, { cwd, input, env = {} } = {}) {
  const full = { ...process.env, ...env };
  for (const k of NO_ENV) if (!(k in env)) delete full[k];
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd, input: input ?? '', env: full, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const line = (id, u, extra = {}) => JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', usage: u }, ...extra });
const usage = (input, output, cc = 0, cr = 0) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: cc, cache_read_input_tokens: cr });
const jsonl = (lines) => lines.join('\n') + '\n';

// The example of the job: 100 input, 200 output, 300 cache creation, 600 cache read, 4 messages.
function exampleTranscript(dir, name = 'session.jsonl') {
  const file = join(dir, name);
  writeFileSync(file, jsonl([
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
    line('m1', usage(10, 20, 100, 0)),
    line('m1', usage(10, 50, 100, 0)),
    line('m2', usage(30, 40, 100, 200)),
    line('m3', usage(40, 60, 50, 300)),
    line('m3', usage(40, 70, 50, 300)),
    line('m3', usage(20, 40, 50, 100)),
    line('', usage(20, 40, 50, 100)),
    JSON.stringify({ type: 'summary', summary: 'x', usage: usage(999, 999, 999, 999) }),
  ]));
  return file;
}

const hookInput = (file, extra = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's', transcript_path: file, ...extra });

test('--version and --help work alone', () => {
  assert.deepEqual(run(['--version']), { code: 0, out: '0.1.0\n', err: '' });
  for (const flag of ['--help', '-h']) {
    const r = run([flag]);
    assert.equal(r.code, 0);
    assert.match(r.out, /token-budget/);
    assert.match(r.out, /check <transcript\.jsonl>/);
    assert.equal(r.err, '');
  }
  for (const args of [['--version', 'x'], ['--help', '--version'], ['-h', 'check'], ['check', '--help'], ['check', '-h', 'f']]) {
    const r = run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.out, '');
    assert.notEqual(r.err, '');
  }
});

test('usage errors give exit 2, a message on stderr and nothing on stdout', () => {
  const s = sandbox();
  try {
    const file = exampleTranscript(s.dir);
    const bad = [
      ['frob'], ['--bogus'], ['-x'], ['check'], ['check', file, file],
      ['check', file, '--bogus'], ['check', file, '--budget=5'], ['check', file, '--budget'],
      ['check', file, '--budget', '5', '--budget', '6'], ['check', file, '--json', '--json'],
      ['check', file, '--warn-at', '0.5', '--warn-at', '0.6'], ['check', file, '--count', 'all', '--count', 'output'],
      ['check', file, '--budget', '0'], ['check', file, '--budget', '-5'], ['check', file, '--budget', '5e5'],
      ['check', file, '--budget', '1_000'], ['check', file, '--budget', '5k'], ['check', file, '--budget', ' 5'],
      ['check', file, '--budget', '1.5'], ['check', file, '--budget', ''],
      ['check', file, '--warn-at', '0'], ['check', file, '--warn-at', '1'], ['check', file, '--warn-at', '1.5'],
      ['check', file, '--warn-at', '-0.5'], ['check', file, '--warn-at', 'x'], ['check', file, '--warn-at', '5e-1'],
      ['check', file, '--warn-at', '0.'], ['check', file, '--warn-at', '80%'],
      ['check', file, '--count', 'everything'], ['check', file, '--count', 'ALL'], ['check', file, '--count'],
      ['check', join(s.dir, 'missing.jsonl')], ['check', '-', '--json'], ['check', '--json'],
    ];
    for (const args of bad) {
      const r = run(args, { cwd: s.dir });
      assert.equal(r.code, 2, JSON.stringify(args));
      assert.equal(r.out, '', JSON.stringify(args));
      assert.notEqual(r.err, '', JSON.stringify(args));
    }
    for (const args of [['check', file, '--warn-at', '.8'], ['check', file, '--warn-at', '0.8'], ['check', '--json', file, '--count', 'output', '--budget', '9']]) {
      assert.notEqual(run(args, { cwd: s.dir }).code, 2, JSON.stringify(args));
    }
  } finally { s.done(); }
});

test('check --json prints one object with the keys in the stated order', () => {
  const s = sandbox();
  try {
    const file = exampleTranscript(s.dir);
    const r = run(['check', file, '--budget', '1000', '--json'], { cwd: s.dir });
    assert.equal(r.code, 3);
    assert.equal(r.err, '');
    assert.ok(r.out.endsWith('\n') && r.out.trim().split('\n').length === 1);
    const o = JSON.parse(r.out);
    assert.deepEqual(Object.keys(o), ['tool', 'version', 'status', 'decision', 'counted', 'budget', 'warn_at', 'mode', 'tokens', 'messages', 'reason']);
    assert.deepEqual(Object.keys(o.tokens), ['input', 'output', 'cache_creation', 'cache_read']);
    assert.equal(o.tool, 'token-budget');
    assert.equal(o.version, '0.1.0');
    assert.equal(o.status, 'over');
    assert.equal(o.decision, 'deny');
    assert.equal(o.counted, 1200);
    assert.equal(o.budget, 1000);
    assert.equal(o.warn_at, null);
    assert.equal(o.mode, 'all');
    assert.deepEqual(o.tokens, { input: 100, output: 200, cache_creation: 300, cache_read: 600 });
    assert.equal(o.messages, 4);
    assert.equal(typeof o.reason, 'string');
    const under = JSON.parse(run(['check', file, '--json'], { cwd: s.dir }).out);
    assert.equal(under.status, 'under');
    assert.equal(under.decision, 'allow');
    assert.equal(under.reason, null);
    assert.equal(under.budget, 10000000);
  } finally { s.done(); }
});

test('plain check output starts with the status word and lists the five lines', () => {
  const s = sandbox();
  try {
    const file = exampleTranscript(s.dir);
    const r = run(['check', file, '--budget', '5000'], { cwd: s.dir });
    assert.equal(r.code, 0);
    assert.equal(r.out, [
      'under: 1200 of 5000 tokens (all)', 'input_tokens: 100', 'output_tokens: 200',
      'cache_creation_input_tokens: 300', 'cache_read_input_tokens: 600', 'messages: 4', '',
    ].join('\n'));
    assert.match(run(['check', file, '--budget', '1200'], { cwd: s.dir }).out, /^over: 1200 of 1200 tokens \(all\)\n/);
    assert.match(run(['check', file, '--budget', '1500', '--warn-at', '.8'], { cwd: s.dir }).out, /^warn: 1200 of 1500 tokens \(all\)\n/);
    assert.match(run(['check', file, '--count', 'output', '--budget', '5000'], { cwd: s.dir }).out, /^under: 200 of 5000 tokens \(output\)\n/);
  } finally { s.done(); }
});

test('check exit codes: 0 under, 1 warn, 3 over; the budget is reached when equal', () => {
  const s = sandbox();
  try {
    const file = exampleTranscript(s.dir);
    const code = (...args) => run(['check', file, ...args], { cwd: s.dir }).code;
    assert.equal(code('--budget', '1201'), 0);
    assert.equal(code('--budget', '1200'), 3);
    assert.equal(code('--budget', '1199'), 3);
    assert.equal(code('--budget', '1500', '--warn-at', '0.8'), 1); // 1200 >= 1500 * 0.8
    assert.equal(code('--budget', '1501', '--warn-at', '0.8'), 0);
    assert.equal(code('--budget', '1200', '--warn-at', '0.8'), 3);
    const w = JSON.parse(run(['check', file, '--budget', '1500', '--warn-at', '0.8', '--json'], { cwd: s.dir }).out);
    assert.equal(w.status, 'warn');
    assert.equal(w.decision, 'ask');
    assert.equal(w.warn_at, 0.8);
    assert.match(w.reason, /1500/);
    assert.match(w.reason, /1200/);
  } finally { s.done(); }
});

test('the count kinds count exactly their token kinds', () => {
  const s = sandbox();
  try {
    const file = exampleTranscript(s.dir);
    const counted = (kind) => JSON.parse(run(['check', file, '--count', kind, '--json'], { cwd: s.dir }).out);
    assert.equal(counted('all').counted, 1200);
    assert.equal(counted('no-cache-read').counted, 600);
    assert.equal(counted('input+output').counted, 300);
    assert.equal(counted('output').counted, 200);
    for (const kind of ['all', 'no-cache-read', 'input+output', 'output']) {
      const o = counted(kind);
      assert.equal(o.mode, kind);
      assert.deepEqual(o.tokens, { input: 100, output: 200, cache_creation: 300, cache_read: 600 });
    }
  } finally { s.done(); }
});

test('lines sharing a message.id count once, with the largest value of each field', () => {
  const s = sandbox();
  try {
    const file = join(s.dir, 't.jsonl');
    writeFileSync(file, jsonl([
      line('a', usage(5, 1, 7, 0)),
      JSON.stringify({ type: 'user', message: { role: 'user' } }),
      line('b', usage(1, 1, 1, 1)),
      line('a', usage(3, 9, 2, 4)),
      line('a', usage(8, 2, 0, 0)),
    ]));
    const o = JSON.parse(run(['check', file, '--json'], { cwd: s.dir }).out);
    assert.deepEqual(o.tokens, { input: 8 + 1, output: 9 + 1, cache_creation: 7 + 1, cache_read: 4 + 1 });
    assert.equal(o.messages, 2);
  } finally { s.done(); }
});

test('messages without a usable id each count; other lines, bad JSON and bad numbers are skipped or zero', () => {
  const s = sandbox();
  try {
    const file = join(s.dir, 't.jsonl');
    const asst = (message) => JSON.stringify({ type: 'assistant', message });
    writeFileSync(file, '﻿' + [
      asst({ usage: usage(1, 1, 0, 0) }),                     // no id
      asst({ id: '', usage: usage(1, 1, 0, 0) }),             // empty id
      asst({ id: 7, usage: usage(1, 1, 0, 0) }),              // id not a string
      asst({ id: null, usage: usage(1, 1, 0, 0) }),           // id null
      asst({ id: 'x', usage: { input_tokens: -5, output_tokens: 1.5, cache_creation_input_tokens: '9', cache_read_input_tokens: null } }),
      asst({ id: 'y', usage: 'lots' }),                       // usage not an object
      asst({ id: 'z' }),                                      // no usage
      asst('text'),                                           // message not an object
      asst([1, 2]),
      JSON.stringify({ type: 'assistant' }),
      JSON.stringify({ type: 'user', message: { id: 'u', usage: usage(500, 500, 500, 500) } }),
      JSON.stringify({ type: 'system', usage: usage(500, 500, 500, 500) }),
      JSON.stringify({ message: { id: 'v', usage: usage(500, 500, 500, 500) } }),
      JSON.stringify({ type: 'assistant', message: { id: 'w', usage: usage(2, 3, 4, 5) }, usage: usage(500, 500, 500, 500) }),
      '', '   ', '{not json', '[1,2,3]', '"str"', '42', 'null',
      asst({ id: 'big', usage: { input_tokens: 1e300, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
    ].join('\r\n'));
    const o = JSON.parse(run(['check', file, '--json'], { cwd: s.dir }).out);
    assert.deepEqual(o.tokens, { input: 4 + 2, output: 4 + 3 + 2, cache_creation: 4, cache_read: 5 });
    assert.equal(o.messages, 9); // four without a usable id, and x, y, z, w, big
  } finally { s.done(); }
});

test('an empty transcript, or one of blank lines only, has used nothing', () => {
  const s = sandbox();
  try {
    for (const [name, text] of [['empty.jsonl', ''], ['blank.jsonl', '\n  \n\r\n\t\n'], ['bom.jsonl', '﻿']]) {
      const file = join(s.dir, name);
      writeFileSync(file, text);
      const r = run(['check', file, '--json'], { cwd: s.dir });
      assert.equal(r.code, 0, name);
      const o = JSON.parse(r.out);
      assert.equal(o.counted, 0);
      assert.equal(o.messages, 0);
      assert.equal(run([], { cwd: s.dir, input: hookInput(file) }).out, '');
    }
  } finally { s.done(); }
});

test('a transcript with content but no JSON object is not a transcript', () => {
  const s = sandbox();
  try {
    for (const text of ['hello world\n', '[1,2]\n"x"\n3\n', '\n\nnot json\n\n']) {
      const file = join(s.dir, 'bad.jsonl');
      writeFileSync(file, text);
      const r = run(['check', file], { cwd: s.dir });
      assert.equal(r.code, 4);
      assert.equal(r.out, '');
      assert.notEqual(r.err, '');
      const h = run([], { cwd: s.dir, input: hookInput(file) });
      assert.equal(h.code, 0);
      assert.equal(JSON.parse(h.out).hookSpecificOutput.permissionDecision, 'ask');
    }
    // one object anywhere is enough
    const file = join(s.dir, 'ok.jsonl');
    writeFileSync(file, 'junk\n{"type":"user"}\nmore junk\n');
    assert.equal(run(['check', file], { cwd: s.dir }).code, 0);
  } finally { s.done(); }
});

test('a transcript folder is unreadable (4 in check, ask in hook mode)', () => {
  const s = sandbox();
  try {
    const folder = join(s.dir, 'folder.jsonl');
    mkdirSync(folder);
    const r = run(['check', folder], { cwd: s.dir });
    assert.equal(r.code, 4);
    assert.equal(r.out, '');
    assert.notEqual(r.err, '');
    const h = run([], { cwd: s.dir, input: hookInput(folder) });
    assert.equal(h.code, 0);
    assert.equal(JSON.parse(h.out).hookSpecificOutput.permissionDecision, 'ask');
  } finally { s.done(); }
});

test('hook mode: nothing under the budget, one deny line at it, with the reason', () => {
  const s = sandbox();
  try {
    const file = exampleTranscript(s.dir);
    const under = run([], { cwd: s.dir, input: hookInput(file), env: { TOKEN_BUDGET: '1201' } });
    assert.deepEqual(under, { code: 0, out: '', err: '' });
    const over = run([], { cwd: s.dir, input: hookInput(file), env: { TOKEN_BUDGET: '1200' } });
    assert.equal(over.code, 0);
    assert.equal(over.err, '');
    assert.ok(over.out.endsWith('\n'));
    assert.equal(over.out.trim().split('\n').length, 1);
    const o = JSON.parse(over.out);
    assert.deepEqual(Object.keys(o), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(o.hookSpecificOutput), ['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
    assert.equal(o.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(o.hookSpecificOutput.permissionDecision, 'deny');
    const reason = o.hookSpecificOutput.permissionDecisionReason;
    assert.ok(!/[\r\n]/.test(reason));
    for (const part of ['1200', 'TOKEN_BUDGET', 'token-budget.json', 'cache read']) assert.ok(reason.includes(part), part);
    assert.match(reason, /cache read\D*600/);
    // other count kinds do not talk about cache reads' share of the count
    writeFileSync(join(s.dir, 'token-budget.json'), '{"count":"output","budget":200}');
    const out = JSON.parse(run([], { cwd: s.dir, input: hookInput(file) }).out).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.ok(out.permissionDecisionReason.includes('200'));
  } finally { s.done(); }
});

test('hook mode: every tool is stopped, a missing hook_event_name is PreToolUse, other events print nothing', () => {
  const s = sandbox();
  try {
    const file = exampleTranscript(s.dir);
    const env = { TOKEN_BUDGET: '10' };
    for (const tool of ['Bash', 'Read', 'Edit', 'Task', 'mcp__x__y', undefined]) {
      const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, transcript_path: file });
      assert.equal(JSON.parse(run([], { cwd: s.dir, input, env }).out).hookSpecificOutput.permissionDecision, 'deny');
    }
    const noEvent = JSON.stringify({ transcript_path: file });
    assert.equal(JSON.parse(run([], { cwd: s.dir, input: noEvent, env }).out).hookSpecificOutput.permissionDecision, 'deny');
    for (const ev of ['PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', '']) {
      const r = run([], { cwd: s.dir, input: JSON.stringify({ hook_event_name: ev, transcript_path: file }), env });
      assert.deepEqual(r, { code: 0, out: '', err: '' }, ev);
    }
    // another event is not judged at all, even with no transcript
    assert.deepEqual(run([], { cwd: s.dir, input: JSON.stringify({ hook_event_name: 'Stop' }) }), { code: 0, out: '', err: '' });
  } finally { s.done(); }
});

test('warn_at gives an ask between the warning point and the budget, and a deny at the budget', () => {
  const s = sandbox();
  try {
    const file = exampleTranscript(s.dir);
    writeFileSync(join(s.dir, 'token-budget.json'), '{"budget":1500,"warn_at":0.8}');
    const ask = JSON.parse(run([], { cwd: s.dir, input: hookInput(file) }).out).hookSpecificOutput;
    assert.equal(ask.permissionDecision, 'ask');
    assert.ok(ask.permissionDecisionReason.includes('1500'));
    assert.ok(ask.permissionDecisionReason.includes('1200'));
    assert.ok(!/[\r\n]/.test(ask.permissionDecisionReason));
    assert.equal(run([], { cwd: s.dir, input: hookInput(file), env: { TOKEN_BUDGET: '1501' } }).out, '');
    assert.equal(JSON.parse(run([], { cwd: s.dir, input: hookInput(file), env: { TOKEN_BUDGET: '1200' } }).out).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(run([], { cwd: s.dir, input: hookInput(file), env: { TOKEN_BUDGET: '1500' } }).code, 0);
    assert.equal(run(['check', file], { cwd: s.dir }).code, 1);
  } finally { s.done(); }
});

test('the budget comes from --budget, then TOKEN_BUDGET, then token-budget.json, then 10000000', () => {
  const s = sandbox();
  try {
    const file = exampleTranscript(s.dir);
    const budget = (args, env) => JSON.parse(run(['check', file, '--json', ...args], { cwd: s.dir, env }).out).budget;
    assert.equal(budget([]), 10000000);
    writeFileSync(join(s.dir, 'token-budget.json'), '{"budget": 3000}');
    assert.equal(budget([]), 3000);
    assert.equal(budget([], { TOKEN_BUDGET: '4000' }), 4000);
    assert.equal(budget(['--budget', '5000'], { TOKEN_BUDGET: '4000' }), 5000);
    assert.equal(budget([], { TOKEN_BUDGET: '' }), 3000);
    // hook mode: environment, then file
    const hookBudget = (env) => {
      const r = run([], { cwd: s.dir, input: hookInput(file), env });
      return r.out === '' ? 'under' : JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason;
    };
    assert.equal(hookBudget({}), 'under');
    assert.match(hookBudget({ TOKEN_BUDGET: '1000' }), /budget of 1000 /);
    writeFileSync(join(s.dir, 'token-budget.json'), '{"budget": 1100}');
    assert.match(hookBudget({}), /budget of 1100 /);
    assert.match(hookBudget({ TOKEN_BUDGET: '1000' }), /budget of 1000 /);
  } finally { s.done(); }
});

test('warn-at and count come from the option, then token-budget.json, then the default', () => {
  const s = sandbox();
  try {
    const file = exampleTranscript(s.dir);
    const get = (args) => JSON.parse(run(['check', file, '--json', '--budget', '100000', ...args], { cwd: s.dir }).out);
    assert.equal(get([]).warn_at, null);
    assert.equal(get([]).mode, 'all');
    writeFileSync(join(s.dir, 'token-budget.json'), '{"warn_at": 0.3, "count": "no-cache-read", "other": [1]}');
    assert.equal(get([]).warn_at, 0.3);
    assert.equal(get([]).mode, 'no-cache-read');
    assert.equal(get([]).counted, 600);
    assert.equal(get(['--warn-at', '.9']).warn_at, 0.9);
    assert.equal(get(['--count', 'output']).mode, 'output');
    assert.equal(get(['--count', 'output']).counted, 200);
  } finally { s.done(); }
});

test('token-budget.json is looked for in the hook input cwd, in that folder only', () => {
  const s = sandbox();
  try {
    const file = exampleTranscript(s.dir);
    const project = join(s.dir, 'project');
    const sub = join(project, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(project, 'token-budget.json'), '{"budget": 1000}');
    const decision = (input) => { const r = run([], { cwd: s.dir, input }); return r.out === '' ? 'under' : JSON.parse(r.out).hookSpecificOutput.permissionDecision; };
    assert.equal(decision(hookInput(file)), 'under');
    assert.equal(decision(hookInput(file, { cwd: project })), 'deny');
    assert.equal(decision(hookInput(file, { cwd: 'project' })), 'deny'); // relative to the working directory
    assert.equal(decision(hookInput(file, { cwd: sub })), 'under'); // not above it
    assert.equal(decision(hookInput(file, { cwd: '' })), 'under');
    assert.equal(decision(hookInput(file, { cwd: 5 })), 'under');
    assert.equal(decision(hookInput(file, { cwd: join(s.dir, 'nowhere') })), 'under');
    // check uses the working directory, not the transcript's folder
    assert.equal(run(['check', file], { cwd: project }).code, 3);
    assert.equal(run(['check', file], { cwd: s.dir }).code, 0);
    // a relative transcript path is relative to the working directory
    assert.equal(run(['check', '../session.jsonl'], { cwd: project }).code, 3);
    assert.equal(JSON.parse(run([], { cwd: project, input: hookInput('../session.jsonl') }).out).hookSpecificOutput.permissionDecision, 'deny');
  } finally { s.done(); }
});

test('a broken setting is a configuration problem: ask in hook mode, exit 4 in check, even when an earlier source has the value', () => {
  const s = sandbox();
  try {
    const file = exampleTranscript(s.dir);
    const badFiles = [
      '{not json', '[]', 'null', '"x"', '{"budget": 0}', '{"budget": -1}', '{"budget": 1.5}', '{"budget": "5"}', '{"budget": null}',
      '{"budget": 1e300}', '{"warn_at": 0}', '{"warn_at": 1}', '{"warn_at": "0.5"}', '{"warn_at": null}', '{"count": "everything"}', '{"count": 3}', '',
    ];
    for (const text of badFiles) {
      writeFileSync(join(s.dir, 'token-budget.json'), text);
      const c = run(['check', file, '--budget', '500', '--warn-at', '0.5', '--count', 'all'], { cwd: s.dir });
      assert.equal(c.code, 4, JSON.stringify(text));
      assert.equal(c.out, '');
      assert.notEqual(c.err, '');
      const h = run([], { cwd: s.dir, input: hookInput(file), env: { TOKEN_BUDGET: '500' } });
      assert.equal(h.code, 0);
      const out = JSON.parse(h.out).hookSpecificOutput;
      assert.equal(out.permissionDecision, 'ask', JSON.stringify(text));
      assert.ok(out.permissionDecisionReason.length > 0);
      assert.ok(!/[\r\n]/.test(out.permissionDecisionReason));
      assert.match(out.permissionDecisionReason, /not being enforced/);
    }
    // a BOM at the start of the file is dropped
    writeFileSync(join(s.dir, 'token-budget.json'), '﻿{"budget": 500}');
    assert.equal(run(['check', file], { cwd: s.dir }).code, 3);
    // token-budget.json being a folder
    rmSync(join(s.dir, 'token-budget.json'));
    mkdirSync(join(s.dir, 'token-budget.json'));
    assert.equal(run(['check', file], { cwd: s.dir }).code, 4);
    rmSync(join(s.dir, 'token-budget.json'), { recursive: true });
    // TOKEN_BUDGET
    for (const bad of ['5e5', '1_000', '500k', ' 500', '500 ', '0', '-5', '1.5', '0x10', '99999999999999999999']) {
      const c = run(['check', file, '--budget', '500'], { cwd: s.dir, env: { TOKEN_BUDGET: bad } });
      assert.equal(c.code, 4, bad);
      assert.equal(c.out, '');
      assert.match(c.err, /TOKEN_BUDGET/);
      const h = JSON.parse(run([], { cwd: s.dir, input: hookInput(file), env: { TOKEN_BUDGET: bad } }).out).hookSpecificOutput;
      assert.equal(h.permissionDecision, 'ask', bad);
    }
    assert.equal(run(['check', file], { cwd: s.dir, env: { TOKEN_BUDGET: '500' } }).code, 3);
  } finally { s.done(); }
});

test('unreadable hook input and a missing transcript give an ask in hook mode', () => {
  const s = sandbox();
  try {
    const askReason = (input, cwd = s.dir) => {
      const r = run([], { cwd, input });
      assert.equal(r.code, 0);
      assert.equal(r.err, '');
      assert.equal(r.out.trim().split('\n').length, 1);
      const o = JSON.parse(r.out).hookSpecificOutput;
      assert.equal(o.hookEventName, 'PreToolUse');
      assert.equal(o.permissionDecision, 'ask');
      assert.ok(o.permissionDecisionReason.length > 0);
      assert.ok(!/[\r\n]/.test(o.permissionDecisionReason));
      return o.permissionDecisionReason;
    };
    for (const input of ['', 'not json', '[]', 'null', '"x"', '5', '{"hook_event_name":"PreToolUse"}', '{"transcript_path":""}', '{"transcript_path":7}', '{"transcript_path":null}']) {
      askReason(input);
    }
    askReason(hookInput(join(s.dir, 'missing.jsonl')));
    assert.match(askReason(hookInput(join(s.dir, 'missing.jsonl'))), /not being enforced/);
    // a BOM before the hook input is dropped
    const file = exampleTranscript(s.dir);
    assert.equal(run([], { cwd: s.dir, input: '﻿' + hookInput(file) }).out, '');
  } finally { s.done(); }
});

test('check: a missing transcript is a usage error (2), other unreadable cases are 4', () => {
  const s = sandbox();
  try {
    const r = run(['check', 'nope.jsonl'], { cwd: s.dir });
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
  } finally { s.done(); }
});

test('works through a symbolic link and in a path with spaces', (t) => {
  const s = sandbox();
  try {
    const file = exampleTranscript(s.dir, 'my session file.jsonl');
    const folder = join(s.dir, 'a folder with spaces');
    mkdirSync(folder);
    const link = join(folder, 'tb link.mjs');
    try { symlinkSync(TOOL, link); } catch { t.skip('symbolic links are not available here'); return; }
    const r = spawnSync(process.execPath, [link, 'check', file, '--budget', '1000'], { cwd: folder, encoding: 'utf8', env: { ...process.env, TOKEN_BUDGET: '' } });
    assert.equal(r.status, 3);
    assert.match(r.stdout, /^over: 1200 of 1000 tokens/);
    const v = spawnSync(process.execPath, [link, '--version'], { encoding: 'utf8' });
    assert.equal(v.stdout, '0.1.0\n');
    const h = spawnSync(process.execPath, [link], { cwd: folder, input: hookInput(file), encoding: 'utf8', env: { ...process.env, TOKEN_BUDGET: '1000' } });
    assert.equal(JSON.parse(h.stdout).hookSpecificOutput.permissionDecision, 'deny');
  } finally { s.done(); }
});

test('the tool file starts with the node shebang and needs nothing installed', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(TOOL, 'utf8');
  assert.ok(text.startsWith('#!/usr/bin/env node\n'));
  const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const name of imports) assert.ok(name.startsWith('node:'), name);
});

test('a large transcript is read quickly and exactly, including a very long line and a line cut at a chunk edge', () => {
  const s = sandbox();
  try {
    const file = join(s.dir, 'big.jsonl');
    const lines = [];
    const filler = 'é'.repeat(100);
    for (let i = 0; i < 30000; i++) {
      lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: filler + i } }));
      const id = `msg_${i % 10000}`; // each id on three lines, far apart
      const out = (i % 3) + 1;
      lines.push(line(id, usage(1, out, 2, 3), { note: filler }));
    }
    // 10000 messages; the largest output per id is 3
    lines.push(JSON.stringify({ type: 'user', message: { content: 'x'.repeat(9 * 1024 * 1024) } })); // longer than one read chunk
    lines.push(line('last', usage(5, 5, 5, 5)));
    writeFileSync(file, lines.join('\n')); // no final newline
    const started = Date.now();
    const r = run(['check', file, '--json'], { cwd: s.dir });
    const took = Date.now() - started;
    assert.equal(r.code, 0);
    const o = JSON.parse(r.out);
    assert.equal(o.messages, 10001);
    assert.deepEqual(o.tokens, { input: 10000 + 5, output: 3 * 10000 + 5, cache_creation: 2 * 10000 + 5, cache_read: 3 * 10000 + 5 });
    assert.ok(took < 15000, `took ${took} ms`);
  } finally { s.done(); }
});
