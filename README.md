[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/endog-ai/makefun-csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/endog-ai/makefun-csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

# Fast CSV reader — a faster drop-in for csv-reader 1.0.0

A dependency-free ES module whose `run(input)` returns exactly what
make.fun's own csv-reader 1.0.0 returns for `{text, header}`:
`{columns, rows, errors}` — same broken-row policy, same errors, same order.
It just reads much faster: about **2.7× the CPU speed of csv-reader 1.0.0**
on the practice set (median 267 ms vs 713 ms of `run()` CPU over the six
practice cases, ~10.2 MB of CSV), verified identical on all six practice
cases and on 50,000+ generated broken-CSV inputs with zero divergences.

## How it is faster

The reference walks the text one character at a time and builds every field
with `value += c`. This reader instead:

- jumps between delimiters with native `indexOf` scans and takes whole
  fields as single slices — no per-character loop, no per-character string
  building;
- takes whole runs of unquoted fields at once, splitting them with the
  native `String.split` (a quote inside an unquoted field is literal, so a
  run only stops at a quoted field, a line break, or the end of the text);
- finds a quoted field's closing quote with `indexOf('"')`, so a plain
  quoted field is a single slice; doubled quotes and line breaks inside
  quotes are handled only when they are actually there;
- skips the CR scan entirely for texts that hold no CR at all;
- sends only genuinely broken pieces (quoted fields, stray CRs, quote junk,
  unterminated quotes) through a per-field reader — and even that reader
  jumps between delimiters instead of walking characters.

Correctness is preserved exactly: BOM drop, LF/CRLF record ends, blank
lines are no records, stray CRs outside quotes are dropped with a
`stray_cr` error, quoted fields unescape `""` and read CRLF/lone CR inside
as LF, junk after a closing quote is appended with a `quote_junk` error, a
never-closing quote is literal and the rest is re-read as unquoted with an
`unterminated_quote` error, short rows are padded (`short_row`) and long
rows cut (`long_row`) to the first record's width, and every error carries
the 1-based line its record starts on and its index in `rows`.

## Files

- `solve.js` — the fast reader; `run(input)` is the whole entry.
- `main.ts` — the harness driver: reads `/input/cases.json`, answers each
  case with `run`, writes `/output/answers.json` (turns V8's incremental
  marking off, as the house baseline does).
- `package.json` — `{"type": "module"}` so `solve.js` loads as an ES module.

## Run locally

```sh
node main.ts   # with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR set outside a container
```

Node 22 or later, nothing to install, no WebAssembly, no native addon.
