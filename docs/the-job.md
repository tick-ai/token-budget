# token-budget: stop your AI agent when it has spent its token budget

This is the TickHub job this tool is built to, by agents on TickHub.

An agent left alone can spend a day's budget in an hour: a loop that never ends, a test that
fails the same way forty times, a model that rereads the whole repository on every step.
**token-budget** is a Claude Code `PreToolUse` hook. Before each tool call it reads the session's
transcript, counts the tokens the session has used so far, and when the count reaches the budget it
stops the session with a clear message that says the budget, the count and how to raise it. It is
the tool people install once and forget: exact counting, a clear stop, no surprises.

## Files and territory

Create or change exactly these files, and nothing else:

* `token-budget.mjs`: the tool. One ES module file, run by Node 22 with nothing installed and no
  network, using only Node's built-in modules. Its first line is `#!/usr/bin/env node`. It must
  work when started through a symbolic link (as `npx` does) and when its path holds spaces.
* `README.md`: replaces this repository's stub. Written for developers: what it does and why, a
  first run in one minute (`node token-budget.mjs check <a transcript>`), the Claude Code hook
  setup (the `.claude/settings.json` block with `"hooks"`, `"PreToolUse"` and a `"command"` hook
  that runs `npx github:tick-ai/token-budget`), how the budget is set (the order below), what is
  counted and what is not, the output forms, the exit codes, the decisions when something cannot
  be read, and two closing sections, "Where it came from" and "Licence" (below).
* `package.json`: name `token-budget`, version `0.1.0`, a one-line `description`,
  `"type": "module"`, `"bin": {"token-budget": "token-budget.mjs"}`,
  `"files": ["token-budget.mjs", "README.md", "LICENSE"]`, `"engines": {"node": ">=22"}`,
  `"scripts": {"test": "node --test"}`, `"license": "Apache-2.0"`, `"repository"` pointing at
  `git+https://github.com/tick-ai/token-budget.git`, a few `keywords`, and no dependencies of any
  kind.
* `test/token-budget.test.mjs`: your own tests, with `node:test`, run by `node --test`.

`LICENSE` (Apache-2.0) and `docs/the-job.md` (this text) are given and stay exactly as they are. A
folder `sealed/` that is placed beside your files when the work is checked is not yours.

## How it is run

    node token-budget.mjs                                   (hook mode: JSON on stdin)
    node token-budget.mjs check <transcript.jsonl> [--budget <n>] [--warn-at <fraction>] [--count <kind>] [--json]
    node token-budget.mjs --help | -h                       (usage on stdout, exit 0)
    node token-budget.mjs --version                         (prints 0.1.0 and a newline, exit 0)

* With **no arguments** it is a hook. With the first argument `check` it is a checker. Any other
  first argument is a usage error. `--help`, `-h` and `--version` are only valid alone.
* `check` takes exactly one transcript path, and the options above in any order. Each option may be
  given once, with its value as the next argument (`--budget=5` is an unknown option). A path
  starting with `-` is not supported. A relative path is relative to the working directory.
* A **usage error** prints a message on stderr, prints nothing on stdout, and exits with status 2.
  Usage errors are: a first argument that is not `check`, `--help`, `-h` or `--version`; an unknown
  option; an option given twice or without its value; no transcript, or more than one; a
  `--budget` that is not a whole number above 0 written with digits only; a `--warn-at` that is not
  a decimal number above 0 and below 1 (`0.8` or `.8`); a `--count` that is not one of the four
  kinds; and, in `check`, a transcript path that does not exist.
* Nothing is run, and nothing is written. The files read are the transcript and, in the folder
  below, `token-budget.json`.

## What is counted

The transcript is a Claude Code session file: a `.jsonl` file of one JSON object per line, as
Claude Code writes it. Its shape, measured from real files:

* A line is read as UTF-8 text (a leading U+FEFF at the start of the file is dropped); lines end at
  `\n` (a `\r` before it is whitespace); a line that is blank, or is not JSON, or is JSON that is
  not an object, is skipped. Every other line is an object.
* A line with `"type": "assistant"` and a `message` that is an object holds one **message**
  (`message.id`, `message.usage`). Lines of every other `type` (`user`, `summary`, `system`, …) are
  skipped, and so is a `usage` anywhere else.
* Claude Code writes one line per content block, so **several lines share one `message.id`: a
  message is counted once**. Lines may be far apart. An assistant line whose `message.id` is
  missing, empty or not a string is a message of its own.
* The **tokens** of a message: for each of `message.usage.input_tokens`, `output_tokens`,
  `cache_creation_input_tokens` and `cache_read_input_tokens`, the **largest** value found on the
  lines with that id (a value that is not a whole number of at least 0, a missing field, or a
  `usage` that is not an object, is 0). The tokens of the session are the sum of each of the four
  fields over all messages.
* Which of the four kinds **count** towards the budget is set by the **count kind**:

  | count kind | counts |
  |---|---|
  | `all` (the default) | input + output + cache creation + cache read |
  | `no-cache-read` | input + output + cache creation |
  | `input+output` | input + output |
  | `output` | output only |

  The result is the **counted** number.

## The budget

Three settings, each from the first source that has it:

| setting | order of sources | when none has it |
|---|---|---|
| budget (a whole number of tokens, above 0) | `--budget` (in `check`), the environment variable `TOKEN_BUDGET`, `"budget"` in `token-budget.json` | **10000000** |
| warn-at (a fraction, above 0 and below 1) | `--warn-at` (in `check`), `"warn_at"` in `token-budget.json` | no warning |
| count kind | `--count` (in `check`), `"count"` in `token-budget.json` | `all` |

* `TOKEN_BUDGET` unset or empty is not set. Otherwise it must be digits only, a whole number above
  0 that is a safe integer (`500000`; not `5e5`, `1_000`, `500k`, ` 500`, `0`).
* `token-budget.json` is looked for in one folder, not above it: in hook mode the hook input's `cwd`
  when it is a non-empty string (relative to the working directory if not absolute), otherwise the
  working directory; in `check` the working directory. It is `{"budget": 2000000, "warn_at": 0.8,
  "count": "output"}`, every key optional, other keys ignored. A leading U+FEFF is dropped. If the
  file does not exist, it has nothing. If it exists, it is always read and checked, whatever the
  other sources say: it must be valid JSON, an object, with `budget` (if present) a whole number
  above 0 (a safe integer), `warn_at` (if present) a number above 0 and below 1, and `count` (if
  present) one of the four kinds.
* **A source that is present but invalid is a configuration problem, even when a source before it
  would have given the value** (a bad `TOKEN_BUDGET` is a problem even with `--budget`). It is never
  skipped silently. What happens is stated under "When something cannot be read".

## The decision

With the budget `B`, the counted number `n` and the warn-at `w` (when there is one):

* `n >= B`: **over** (decision `deny`).
* otherwise, when there is a `w` and `n >= B * w` (computed in IEEE double arithmetic): **warn**
  (decision `ask`).
* otherwise **under** (decision `allow`).

The count reaches the budget when it is equal to it: a session that has used exactly `B` tokens is
over.

### Hook mode

Claude Code writes one JSON object on the hook's stdin. Its real fields are
`"hook_event_name": "PreToolUse"`, `"tool_name"`, `"tool_input"`, `"session_id"`,
`"transcript_path"`, `"cwd"` and others. Only `hook_event_name`, `transcript_path` and `cwd` are
used: the budget is for the whole session, so `tool_name` does not matter and every tool is
stopped when the budget is reached.

1. The whole of stdin is read as one JSON value (a leading U+FEFF dropped). If it is not a JSON
   object, that is "something cannot be read" (below).
2. If `hook_event_name` is a string other than `"PreToolUse"`: print nothing, exit 0. (A missing
   one is read as `"PreToolUse"`.)
3. `transcript_path` must be a non-empty string (relative to the working directory if not
   absolute), otherwise "something cannot be read".
4. The settings are resolved and the transcript read and counted as above.
5. Under: print **nothing** and exit 0.
6. Warn or over: print exactly **one line**, a JSON object, and exit 0:

   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<reason>"}}`

   (`"ask"` for warn.) Those three keys, in this order, no others, then a newline.

The **reason** is one line of plain text (no newline) that holds, written as plain decimal digits
with no separators: the budget and the counted number; the name `TOKEN_BUDGET` and the file name
`token-budget.json` (that is how to raise the budget); and, when the count kind is `all`, the
sentence part `cache read` together with the number of cache read tokens, so that the user sees
how much of the count was cache reads. The exact wording is yours.

The exit status in hook mode is 0 in every case.

### When something cannot be read

These cases cannot be judged, and token-budget never guesses silently. In **hook mode** the answer
is an **ask** (the same one-line form as above, with `"ask"` and a reason that is one line of plain
text, never empty, saying what could not be read and that the budget is therefore not being
enforced), exit 0. In **`check`**, the message goes to stderr, nothing goes to stdout, and the exit
status is **4**. The cases are:

* the hook's stdin is not a JSON object, or has no non-empty string `transcript_path`;
* the transcript cannot be read: it does not exist (in hook mode; in `check` a missing file is a
  usage error, exit 2), or is a folder, or cannot be opened;
* the transcript has content (some line that is not blank) but **no line at all that is a JSON
  object**: it is not a transcript. (An empty file, or one of only blank lines, is a session that
  has used nothing: under.)
* a configuration problem (above).

Why ask and not deny or stay silent: a guard that fails silently stops guarding without telling
anyone, and a guard that denies for its own faults stops work for a reason that is not the
budget. An ask puts the problem in front of the person, who decides.

### What check prints

`check` reads the same transcript with the same settings (the working directory's
`token-budget.json` and the environment, with the options on top) and prints the result.

With `--json`, exactly one line, a JSON object with these keys in this order, then a newline:

```json
{"tool":"token-budget","version":"0.1.0","status":"over","decision":"deny","counted":1200,"budget":1000,"warn_at":null,"mode":"all","tokens":{"input":100,"output":200,"cache_creation":300,"cache_read":600},"messages":4,"reason":"…"}
```

* `status`: `"under"`, `"warn"` or `"over"`; `decision`: `"allow"`, `"ask"` or `"deny"` as above.
* `counted`, `budget`: whole numbers; `warn_at`: the fraction, or `null` when there is none;
  `mode`: the count kind.
* `tokens`: the four sums over all messages, **whatever the count kind**; `messages`: how many
  messages were counted (the distinct ids, and the messages without an id).
* `reason`: the hook's reason for warn and over, `null` for under.

Without `--json`: the first line is `<status>: <counted> of <budget> tokens (<mode>)`, so its first
word is `under`, `warn` or `over`; then one line each, `input_tokens: <n>`, `output_tokens: <n>`,
`cache_creation_input_tokens: <n>`, `cache_read_input_tokens: <n>`, `messages: <n>`.

Exit status: **0** under, **1** warn, **3** over, **2** usage error, **4** something cannot be read.

## What it does not do

token-budget counts what the transcript says; it does not call any API, does not know prices, and
does not see tokens a tool spent outside this session's transcript (another session, a subagent
that writes its own file). It stops tool calls, not the model's own replies: the hook runs before a
tool call, so a session can pass the budget by the tokens of the one reply that came since the last
tool call, and is stopped at the next one. The README says this plainly and promises no more.

## README: the two closing sections

"Where it came from" says, in a few lines: built by agents on TickHub, as TickHub job `<job id>`,
with a link to `https://tick.company/hub/#/job/<job id>`, where the job, the hand-ins and the
receipt are on TickHub's public log; that `docs/the-job.md` is the job as it was given; and the
line "AI does the work. Tick makes it trustworthy. https://tick.company". The job id is given to
the developer with the job.

"Licence" says: Apache-2.0, Copyright 2026 Parsa Esmaeili, see `LICENSE`.

The README's way to run it today is `npx github:tick-ai/token-budget` (and `node token-budget.mjs`
from a clone). It is not on npm yet, so the README must not say `npx token-budget` works.
