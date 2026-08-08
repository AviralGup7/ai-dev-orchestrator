# Development

```bash
npm test                # 376 tests, no browser, no dependencies
npm run purity          # the core must not touch a browser
npm run env-safety      # nothing may create/close/navigate a tab
npm run secrets         # credentials in source, history, and the escape paths
npm run build           # dist/ + verify Chrome can load it
npm run demo            # demo.html — real engine, fake AIs
npm run sabotage        # break the code 98 ways; each must fail a named test
npm run check           # everything above
```

## Focused testing while developing

Do not run the whole suite after every edit (§30):

```bash
node --test test/parse.test.mjs        # evidence parsers
node --test test/schema.test.mjs       # response validation
node --test test/integration.test.mjs  # end-to-end on the simulator
node --test test/transport.test.mjs    # DOM completion detection
```

## Sabotage verification is not optional

A test that has never failed is a rumour. `tools/sabotage.mjs` applies 98
one-line breakages and requires a **named** test to fail for each.

It has found something in every session, including:

- **a hole in the central guarantee** — eight asserted dimensions at 95% carried
  a run over its target while only `testing` was checked;
- a repeated-failure policy that was decorative;
- dead code in preflight that no test could observe;
- two tests that tested their own source text rather than behaviour.

When a sabotage is missed, the honest first question is whether the *test* is
weak — twice this session it was.

## Simulation

```js
new SimTransport({ seed: 7, faults: { engineer: { 3: 'timeout' } } })
```

Faults are keyed by **call index, not probability**: "fail the third Arena call"
is a reproducible scenario; "fail 20% of calls" is a flaky test. Eight fault
types: `timeout`, `empty`, `malformed`, `truncated`, `transport`, `forbidden`,
`flattery`, `contradiction`.

## Adding an evidence parser

1. Add a pattern to the right list in `core/parse.js`, **most specific first** —
   ordering is load-bearing. `Tests: 3 failed, 1276 passed` matched by a naive
   `/(\d+) passed/` reports zero failures, turning a failing suite into a perfect
   score.
2. Return `null`, never a zero, when nothing was observed.
3. Add a hedged-prose case to `test/parse.test.mjs`.
4. Add a sabotage.
