# keep-the-thread

Compaction that keeps the thread. A summary makes an assistant forget the exact
error, the exact path, the exact constraint it had just learned. This plugin
never writes one: it scores every tool call and result in one fast request,
drops or truncates the stale ones, and leaves everything it keeps **verbatim**.

It also decides *when* to compact, by asking whether the session is at a
boundary rather than watching a percentage, and it masks personal data and
secrets before anything leaves the machine.

Also usable as an npm library.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
3b. Personal data and secrets in that state are masked before it leaves the
   machine: emails, API tokens, JWTs, private keys, `key=value` secrets, URL
   credentials, IBANs, Luhn-valid card numbers and the account name in a home
   path, plus phone numbers and public IPs under `redact: 'strict'`. Each
   distinct value gets a stable placeholder (`[email_1]`), so Jev still sees
   that two mentions are the same thing. Masking is one-way and applies only to
   the state: **the compacted transcript is always the verbatim original**.
   When gitleaks is installed it scans the same text first and every value it
   reports is masked too, which covers the secrets no pattern of ours would
   recognise.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do). The result question carries a masked
   `resultExcerptChars` excerpt of that result, so the judgment is made on the
   content and not on a size in characters alone. It rides on the question
   rather than in the state because the state is resent with every batch and a
   question is sent once: the same text for a quarter of the tokens. gitleaks
   scans exactly that window along with the rest.
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same full state is resent with every request; requests run
   concurrently and their answers are merged.
6. Decisions per call, against two thresholds (see [Thresholds](#thresholds)):
   - `keepResult ≥ keepResultThreshold` (0.4) → keep call and result;
   - else `keepCall ≥ keepCallThreshold` (0.15) → keep the call, truncate the
     result to its first `truncateHeadChars` characters plus a one-line note;
   - else, unless the call is protected → remove the call with its result.
   A call is protected, and so only truncated, when its tool changed something
   (`Bash`, `Write`, `Edit`, `Task`, any `mcp__*`) or when its result was an
   error.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.
8. A short note is appended saying what was removed and that a missing tool
   output is not evidence the work behind it was done. A summary announces
   itself; a pruned history looks like a complete one, and an assistant
   reading its own turns that claim something without showing it can take them
   as a precedent. The note replaces the previous one instead of stacking, and
   is stripped before the next compaction sees it. `guardRail: false` removes
   it.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the Claude Code hook) decides what to fall back to.

## Install and usage

```sh
npm install keep-the-thread
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'keep-the-thread';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own backend, implement `Judge` (one `judge(state, questions)`
method) and call `compact(messages, judge, options)`. `Judge` is the port and
names no vendor: `JevClient` is the HTTP adapter for TypeSafe, the hook wraps
the engine's own fetch, and a local runtime for an open-weight decision model
would be a third. `buildJevRequest` and `parseJevResponse` give you the HTTP
request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `redact` | `'standard'` | PII masking of the state: `off`, `standard`, `strict` |
| `redactRules` | `[]` | Extra masking rules, appended to the built-in ones |
| `redactLiterals` | `[]` | Literal values to mask, whatever their shape (what a gitleaks scan fills) |
| `keepResultThreshold` | `0.4` | Below it, a tool result is truncated to its head |
| `keepCallThreshold` | `0.15` | Below it, the call itself is removed. Irreversible |
| `keepThreshold` | unset | Legacy single knob; sets both thresholds |
| `sideEffectTools` | `DEFAULT_SIDE_EFFECT_TOOLS` | Tools whose calls are truncated, never removed |
| `protectErrors` | `true` | Never remove a call whose result was an error |
| `tailMessages` | `64` | Messages the adviser snapshot may carry |
| `toolResultBytes` | `512` | Bytes kept from each tool result in that snapshot |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |
| `resultExcerptChars` | `200` | Characters of each result shown to Jev in the question about it; 0 turns it off |

`result.stats` reports message and character counts before and after, the
per-reason decision counts (including `protected`), the distinct values masked
per rule in `redactions`, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

`droppableRatio(messages, options)` answers, without any request, the best
reduction a compaction of this transcript could reach.

`scanForSecrets(messages, run, options)` runs `gitleaks stdin` through an
injected process runner and returns the values to mask; it never throws, so a
missing binary degrades to the built-in patterns.

`adviseCompaction(messages, usage, judge, options)` answers whether now is a
good moment to compact, with `adviserSnapshot`, `adviceScore` and `floorFor`
exposed separately. It never throws: without a judgment, the answer is no.

## Three decisions worth knowing

The project began as a fork of
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction),
whose idea it keeps: prune rather than summarize. These three changes came out
of auditing that design, and are why this is now its own project.

### Privacy

The original sent the whole conversation to `api.typesafe.ai` on every compaction,
and resends it with every request of the batch: prompts, assistant text and
tool inputs, so file paths, commands and queries too. Only tool *outputs* are
replaced by a note. That is a third party in the chain, and nothing said so.

This masks the state before it leaves the machine (`redact`, `standard` by
default) and reports what it masked in `stats.redactions` and in the toast.

Two layers, because they catch different things:

- **Built-in patterns**, always on, no dependency: emails, API tokens with a
  known prefix, JWTs, private keys, `key=value` secrets, URL credentials,
  IBANs, Luhn-valid cards, the account name in a home path.
- **gitleaks**, on whenever the binary is installed: it reads the same text on
  stdin and reports every secret its rules match, which the redactor then masks
  as literal values. Hundreds of maintained rules instead of our dozen, one
  static binary, no model to load, and nothing leaves the machine. With no
  gitleaks on the machine the first compaction says so once and the session
  stops trying; `gitleaks: false` never runs it at all.

The two layers catch different things, which is the point. gitleaks found a
`sk_live_` Stripe key the built-in patterns missed (they expect a hyphen);
the patterns caught a `AIza` Google key gitleaks let through on the same run.
Note that gitleaks scores entropy and exact lengths, so it stays quiet on
made-up placeholders: testing it with `sk-test-1234` will look like a failure
and is not one.

An NER detector (Presidio and the like) would add what neither layer has,
names and places, at the cost of a Python runtime and a several-hundred-
megabyte model load on a path that has to stay fast. Deliberately left out for
now; the `literals` seam in `redact.ts` is where such a backend would plug in.

What masking does not do: recognise a person's name, or spot a secret with no
recognisable shape that gitleaks does not know either. **Masking narrows the
exposure, it does not remove it.** If the conversation must not reach a third
party at all, do not run this plugin.

### Thresholds

The original used one threshold at `0.5` for both decisions. Two problems: the test
is `keep >= threshold`, so raising the number makes pruning *more* aggressive,
not less — easy to get backwards; and it treats truncating a result (the
assistant re-runs the tool) and deleting a call (the record is gone) as the same
risk.

They are now separate and asymmetric: `keepResultThreshold` 0.4,
`keepCallThreshold` 0.15. On top of that, a call is never deleted outright when
its tool had a side effect or its result was an error — it is truncated
instead, and reported as `protected`. The old single `keepThreshold` still
works and sets both.

### Compaction loops

The original's `turn.complete` asked for a compaction whenever the context was over
`compactAtPercent`. If the compaction did not bring it back under, the next turn
asked again, and every attempt costs a full round of Jev requests.

Four guards, all in the hook:

- a **pre-flight**: `droppableRatio()` computes locally the best reduction this
  transcript could reach; under `minReductionRatio`, the hook falls back to the
  built-in summary without calling Jev at all;
- a **cooldown** of `cooldownTurns` turns after each compaction;
- an **escalating trigger**: a compaction that frees less than `minPercentDrop`
  context points raises the trigger above where the context now sits, so the
  next attempt waits for real growth;
- a **cap** of `maxAutoCompactions` per session, and a full stop once the
  trigger reaches 95%.

### What a compaction costs, and when it pays

Freeing context is only half the trade. Editing the history invalidates the
prompt cache from the first changed message on, so the next request rewrites
the cache for everything after it. The context meter never shows that side: it
reports the window emptying, not the tokens paid to refill the cache. A
compaction can look like a clear win and cost more than it saved.

The plugin puts both on one line. It keeps a rolling median of the cache
written per turn, and when a compaction lands it attributes the excess on the
turn that follows:

```
cache rewritten 214k tokens above the 16k baseline, 39k less to send each turn: ~69 turns to break even
```

The break-even is the point of the line. The rewrite is paid once, the
smaller prompt is saved on every later turn, so the two are not comparable
until they are put in the same unit. At the usual rates (a cache write costs
1.25 base input tokens, a cache read 0.1) the arithmetic is unforgiving:
repaying a full-prefix rewrite takes about 12.5 turns for each unit of
context freed, so a compaction that frees a sixth of the prompt needs roughly
seventy more turns to come out ahead.

Two things follow. The ratio does **not** improve by compacting later, since
the rewrite and the saving both scale with the context. And compacting for
economy is almost always a mistake: the reason to compact is room. That is
why `compactAtPercent` defaults to 75 rather than something comfortable, and
why nothing is suggested below it.

Medians rather than means, so one heavy turn does not hide the rewrite behind
it; the rewrite turn itself never enters the baseline. The dollar figure is the
session ledger's own delta, not a rate table, so it does not go stale. From the
second compaction on, the line carries the session running total. Nothing is
sent anywhere and no extra request is made: the figures come from the turn
usage and the cost ledger the engine already holds. Set `measureCache` to false
to drop the line.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- That makes the budget finite. Once the tool results of a session have been
  truncated, `droppableRatio()` falls under `minReductionRatio`, the pre-flight
  refuses without calling Jev, and Claude Code's built-in summary takes over
  the verbatim history the plugin had preserved. The guarantee is deferred, not
  permanent. New tool calls refill the budget, so exhaustion bites on sessions
  dominated by message text; `minReductionRatio` and `truncateHeadChars` move
  where it bites.
- Jev is asked whether a tool result is worth keeping without being shown that
  result: the state carries the tool, its input, whether it succeeded and its
  size in characters, never its content.
- Masking is pattern-based. It catches shapes, not meaning: a person's name, a
  free-text address or an unusual secret format goes through. What was looked
  at to close that gap, and why nothing was picked, is in
  [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/keep-the-thread.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### When it runs

Two separate mechanisms, and the plugin does not play the same part in them.

**It replaces compactions decided elsewhere** (`session.compact`). Your
`/compact`, and Claude Code's own auto-compaction when the context fills up,
both go through the hook, which hands back the pruned history instead of a
summary. It falls back to the built-in summary when Jev fails or the key is
missing, when the local pre-flight says no run could reach `minReductionRatio`,
and when a real run does not reach it either.

**It asks for compactions of its own** (`turn.complete`), at the end of a turn,
when all of these hold:

| Condition | Default |
| --- | --- |
| context at or above `compactAtPercent` | 75% |
| turns since the last compaction | 3 (`cooldownTurns`) |
| compactions so far this session | under 8 (`maxAutoCompactions`) |
| auto-compaction not disabled by the guards | |
| Jev judges the session to be at a boundary | see below |

That 60% is more eager than the built-in auto-compaction, which waits for the
context to fill. It is meant to be: compacting costs nothing here, since
messages stay verbatim and only tool results go, so early and often beats late
and brutal.

The trigger is not fixed. A compaction that frees less than `minPercentDrop`
(5) points raises it above the level it could not bring down: 82% to 80% moves
the trigger from 60% to 85%, so the next attempt waits for real growth instead
of firing on the next turn. If that pushes the trigger to 95%, auto-compaction
turns itself off for the session and says so.

The two mechanisms chain: `turn.complete` calls `$.session.compact()`, which
fires the `session.compact` hook. A re-entrance flag keeps that from looping.

### Is this a good moment?

A percentage knows how full the window is and nothing about what the session is
doing. The moment it is most likely to fire mid-task is exactly the moment
losing tool results hurts most: the assistant is still using them. So once the
guards above pass, the plugin asks Jev two questions in one request and
composes the answer in code:

- **done**: is the assistant's latest unit of work finished? Waiting on a
  person counts as finished.
- **shape**: did the assistant do the work itself, or coordinate others?

`score = finished × (0.5 + 0.5 × hands_on)`. A finished hands-on unit lands
near 1, a finished coordinating one near 0.5, unfinished work near 0.

The score is compared against a **floor that slides with how full the context
is**: 0.90 while the window is under 10%, falling to 0.50 at 90%. A wrong call
costs most when there is still room and least when compaction is imminent, so
the bar drops as the room runs out.

Once the moment is judged right, **the plugin says so rather than acting**.
`onBoundary: 'notify'`, the default, pins a line under the prompt and raises it
once on the notification bar:

```
a good moment to compact (66% context): /compact
```

It touches neither the transcript nor the model: no message is injected, no
question is asked, and the call stays with the person. The line is repeated
only once the context has grown another `minPercentDrop` points, and is
cleared as soon as a compaction happens or the adviser finds the session
mid-task again. `onBoundary: 'compact'` compacts straight away instead.

Three limits keep this from ever making things worse:

- past `alwaysCompactAtPercent` (85%) the compaction runs on its own and
  **without asking**, whatever `onBoundary` says: waiting there would hand the
  turn to the built-in summary, and an unreachable adviser can never stop a
  session from compacting;
- the question has a cooldown of its own (`cooldownTurns`), because notifying
  resets nothing and the judgment costs a request;
- without a usable judgment the answer is **no**, so nothing is suggested and
  nothing is compacted on a bad answer. `advise: false` removes the question
  entirely.

The snapshot sent is a bounded tail of the conversation, not the whole
transcript, and it goes through the same masking as the compaction state.

This part is adapted from [compact-adviser](https://github.com/kunchenguid/compact-adviser)
(MIT): the two questions, the composed score and the sliding floor are theirs.
Their constants are calibrated against their own eval set, so treat them here
as a starting point rather than a measured optimum.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add alepee/keep-the-thread
claude plugin install keep-the-thread@keep-the-thread
```

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the toast reads
`keep-the-thread: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary, or `fallback to built-in summary (…)` when Jev
could not remove enough (short sessions, or when it fails).

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
