# Open questions

## Identity PII (names, organisations, places) is not masked

Tracking the gap the current masking leaves, and what was looked at, so the
next person does not redo the survey.

### What is covered today

Two layers, both on the state only, never on the compacted transcript:

- **built-in patterns** (`src/redact.ts`): emails, API tokens with a known
  prefix, JWTs, private keys, `key=value` secrets, URL credentials, IBANs,
  Luhn-valid cards, the account name in a home path; phones and public IPs
  under `strict`;
- **gitleaks** (`gitleaks: true`): hundreds of maintained secret rules, scored
  on entropy and exact lengths.

Both work on **shape**. That is why they work with no model and no runtime.

### What is not covered

Anything whose shape carries no signal, which in practice means **identities**:
a person's name, an organisation, a place, a free-text postal address. A
transcript that says "call Marie about the Dupont account" goes out as is.

### Options looked at, with verified numbers

| Option | Weight | Runtime |
| --- | ---: | --- |
| Presidio + spaCy `en_core_web_sm` | 13 MB | Python |
| Presidio + spaCy `en_core_web_lg` | 401 MB | Python |
| ONNX `Xenova/bert-base-NER` int8 | 108 MB | Node, English only |
| ONNX `distilbert-base-multilingual-cased-ner-hrl` int8 | 135 MB | Node, multilingual |
| GLiNER `gliner_multi_pii-v1` int8 | 349 MB | Node or Python |

Weight turned out not to be the deciding factor: Presidio on the small model is
13 MB, and ONNX in Node removes the Python dependency entirely.

### Why none of them is in

**False positives on code.** Every candidate above is an NER model, and NER on a
coding transcript flags identifiers: a `Jackson` class, a `Faker` library, a
`Mr` in a fixture. Masking those destroys the signal Jev needs to decide what
to keep, which is the one thing this project cannot trade away. The cure would
be worse than the disease at the current level of accuracy.

A second, smaller reason: a hook cannot load native bindings, so any of these
runs as a sidecar through `$.process.run` anyway.

### What would change the decision

- A detector with usable precision on source code, rather than on prose.
- Or an offline pass: run a heavy detector rarely, off the hot path, to
  *propose* values that a human approves once, and let the hot path do exact
  matching only. That splits precision from recall instead of trading them.

### Where it would plug in

`createRedactor({ literals })` in `src/redact.ts`. It takes literal values and
masks them with the same stable placeholders as everything else, which is how
the gitleaks results already get in. A detector that returns values, rather
than patterns, needs no other change.

Until then the README states the limit plainly: masking narrows the exposure,
it does not remove it.
