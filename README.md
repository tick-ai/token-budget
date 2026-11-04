# token-budget

Stops your AI agent when its Claude Code session has spent its token budget: a `PreToolUse` hook that counts the session's tokens before every tool call and says no, with the budget, the count and how to raise it.

```
npx github:tick-ai/token-budget
```

```
$ node token-budget.mjs check session.jsonl --budget 20000 --warn-at 0.8
over: 30303 of 20000 tokens (all)
input_tokens: 18
output_tokens: 485
cache_creation_input_tokens: 10600
cache_read_input_tokens: 19200
messages: 3
$ echo $?
3
```

Plain Node 22, nothing to install, no network. It reads the transcript and `token-budget.json`, and writes nothing.

## Why

An agent left alone can spend a day's budget in an hour: a loop that never ends, a test that fails the same way forty times, a model that rereads the whole repository on every step. token-budget is the thing you install once and forget. Before each tool call it reads the session's transcript, counts the tokens used so far, and when the count reaches the budget it stops the session with a message that holds the budget, the count and how to raise it.

## First run in one minute

```
node token-budget.mjs check <a transcript>
```

A transcript is the session file Claude Code keeps (a `.jsonl` file, usually under `~/.claude/projects/`). Add `--budget 500000` to try a smaller budget, `--json` for one line of JSON.

## The Claude Code hook

Put this in `.claude/settings.json` (project) or `~/.claude/settings.json` (all projects):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "npx github:tick-ai/token-budget" }
        ]
      }
    ]
  }
}
```

Then set the budget (below). Under the budget the hook prints nothing and Claude Code carries on. At the budget it prints one JSON line that denies the tool call:

```
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"token-budget: budget reached. This session has used 30303 tokens (count kind all), which reaches the budget of 20000 tokens. The count includes cache read: 19200 tokens (set count to no-cache-read to leave cache reads out). To raise the budget, set the TOKEN_BUDGET environment variable or \"budget\" in token-budget.json."}}
```

The hook always exits 0; the answer is on stdout. It uses only `hook_event_name`, `transcript_path` and `cwd` from Claude Code's input. The budget is for the whole session, so every tool is stopped when it is reached, whatever `tool_name` is. Other hook events print nothing.

Today token-budget is run from GitHub with `npx github:tick-ai/token-budget` (or `node token-budget.mjs` from a clone). It is not on npm yet, so `npx token-budget` does not work.

## How the budget is set

Three settings, each from the first source that has it:

| setting | order of sources | when none has it |
|---|---|---|
| budget (a whole number of tokens, above 0) | `--budget` (in `check`), the environment variable `TOKEN_BUDGET`, `"budget"` in `token-budget.json` | `10000000` |
| warn-at (a fraction, above 0 and below 1) | `--warn-at` (in `check`), `"warn_at"` in `token-budget.json` | no warning |
| count kind | `--count` (in `check`), `"count"` in `token-budget.json` | `all` |

- `TOKEN_BUDGET` unset or empty is not set. Otherwise it is digits only, a whole number above 0 that is a safe integer: `500000`, not `5e5`, `1_000`, `500k`, ` 500` or `0`.
- `token-budget.json` is looked for in one folder, not above it: in hook mode the hook input's `cwd` (when it is a non-empty string; relative to the working directory if not absolute), otherwise the working directory; in `check` the working directory.

  ```json
  {"budget": 2000000, "warn_at": 0.8, "count": "output"}
  ```

  Every key is optional and other keys are ignored. If the file exists it is always read and checked, whatever the other sources say: valid JSON, an object, `budget` a whole number above 0, `warn_at` a number above 0 and below 1, `count` one of the four kinds.
- A source that is present but invalid is a configuration problem, even when a source before it would have given the value (a bad `TOKEN_BUDGET` is a problem even with `--budget`). It is never skipped silently; see [When something cannot be read](#when-something-cannot-be-read).

### The decision

With the budget `B`, the counted number `n` and the warn-at `w`:

- `n >= B`: **over**, decision `deny`. A session that has used exactly `B` tokens is over.
- otherwise, with a `w` and `n >= B * w` (in IEEE double arithmetic): **warn**, decision `ask`.
- otherwise **under**, decision `allow`.

## What is counted, and what is not

The transcript is a Claude Code session file, one JSON object per line.

- Lines are read as UTF-8 (a leading U+FEFF is dropped), end at `\n` (a `\r` before it is whitespace). A line that is blank, is not JSON, or is JSON that is not an object is skipped.
- Only a line with `"type": "assistant"` and a `message` that is an object holds a message. Lines of every other `type` (`user`, `summary`, `system`, …) are skipped, and so is a `usage` anywhere else.
- Claude Code writes one line per content block, so several lines share one `message.id`: **a message is counted once**, however far apart its lines are. An assistant line whose `message.id` is missing, empty or not a string is a message of its own.
- The tokens of a message: for each of `input_tokens`, `output_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens` in `message.usage`, the **largest** value found on the lines with that id. A value that is not a whole number of at least 0, a missing field, or a `usage` that is not an object, is 0.
- The tokens of the session are the sum of each of the four fields over all messages.

Which kinds count towards the budget is the **count kind**:

| count kind | counts |
|---|---|
| `all` (the default) | input + output + cache creation + cache read |
| `no-cache-read` | input + output + cache creation |
| `input+output` | input + output |
| `output` | output only |

The result is the **counted** number. Cache reads are often most of a long session's tokens; in the `all` kind the reason says how many cache read tokens the count holds.

## What it does not do

token-budget counts what the transcript says. It does not call any API, does not know prices, and does not see tokens a tool spent outside this session's transcript (another session, a subagent that writes its own file). It stops tool calls, not the model's own replies: the hook runs before a tool call, so a session can pass the budget by the tokens of the one reply that came since the last tool call, and is stopped at the next one.

## Usage

```
node token-budget.mjs                                   (hook mode: JSON on stdin)
node token-budget.mjs check <transcript.jsonl> [--budget <n>] [--warn-at <fraction>] [--count <kind>] [--json]
node token-budget.mjs --help | -h                       (usage on stdout, exit 0)
node token-budget.mjs --version                         (prints 0.1.0 and a newline, exit 0)
```

- With no arguments it is a hook. With the first argument `check` it is a checker. Any other first argument is a usage error. `--help`, `-h` and `--version` are only valid alone.
- `check` takes exactly one transcript path (relative to the working directory; a path starting with `-` is not supported) and the options in any order. Each option may be given once, with its value as the next argument (`--budget=5` is an unknown option).
- A **usage error** prints a message on stderr, nothing on stdout, and exits 2. Usage errors are: an unknown first argument, an unknown option, an option given twice or without its value, no transcript or more than one, a `--budget` that is not a whole number above 0 in digits, a `--warn-at` that is not a decimal above 0 and below 1 (`0.8` or `.8`), a `--count` that is not one of the four kinds, and, in `check`, a transcript path that does not exist.

### Output forms of `check`

Plain: the first line is `<status>: <counted> of <budget> tokens (<mode>)`, so its first word is `under`, `warn` or `over`, then one line each:

```
under: 30303 of 10000000 tokens (all)
input_tokens: 18
output_tokens: 485
cache_creation_input_tokens: 10600
cache_read_input_tokens: 19200
messages: 3
```

With `--json`: exactly one line, one object, these keys in this order:

```json
{"tool":"token-budget","version":"0.1.0","status":"over","decision":"deny","counted":1200,"budget":1000,"warn_at":null,"mode":"all","tokens":{"input":100,"output":200,"cache_creation":300,"cache_read":600},"messages":4,"reason":"…"}
```

`status` is `under`, `warn` or `over`; `decision` is `allow`, `ask` or `deny`; `warn_at` is the fraction or `null`; `tokens` holds the four sums over all messages whatever the count kind; `messages` counts the distinct ids plus the messages without an id; `reason` is the hook's reason for warn and over, `null` for under.

### Exit codes of `check`

| code | meaning |
|---|---|
| 0 | under |
| 1 | warn |
| 3 | over |
| 2 | usage error |
| 4 | something cannot be read |

In hook mode the exit status is always 0.

### When something cannot be read

token-budget never guesses silently. These cases cannot be judged:

- the hook's stdin is not a JSON object, or has no non-empty string `transcript_path`;
- the transcript cannot be read: it does not exist (in hook mode; in `check` a missing file is a usage error), is a folder, or cannot be opened;
- the transcript has content but no line at all that is a JSON object: it is not a transcript (an empty file, or one of only blank lines, is a session that has used nothing: under);
- a configuration problem (above).

In **hook mode** the answer is an **ask**: the same one-line form as above with `"ask"` and a reason that says what could not be read and that the budget is therefore not being enforced; exit 0. In **`check`** the message goes to stderr, nothing goes to stdout, and the exit status is 4.

Why ask, and not deny or stay silent: a guard that fails silently stops guarding without telling anyone, and a guard that denies for its own faults stops work for a reason that is not the budget. An ask puts the problem in front of the person, who decides.

A warn is the same one-line form with `"ask"` and a reason that holds the budget and the count.

## Where it came from

Built by agents on TickHub, as TickHub job `4d6d2682-96cf-4c76-8629-0eb3b6ccaa70`. The job, the hand-ins and the receipt are on TickHub's public log: https://tick.company/hub/#/job/4d6d2682-96cf-4c76-8629-0eb3b6ccaa70

`docs/the-job.md` is the job as it was given.

AI does the work. Tick makes it trustworthy. https://tick.company

## Licence

Apache-2.0, Copyright 2026 Parsa Esmaeili, see `LICENSE`.
