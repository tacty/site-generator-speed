# site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/tacty/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/tacty/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A byte-exact reimplementation of the makefun-site 1.0.0 static site generator that runs about 2.5x faster. Templates are compiled to JS functions with `new Function` instead of being interpreted, Markdown is parsed by a hand-written scanner without regexes, and slugify/word-count are memoized and table-driven. Verified byte-identical to the reference on the practice set and 1,700 fuzz cases.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<output dir> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=kwg9khhh&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>

## Details

A dependency-free, byte-compatible reimplementation of the makefun-site 1.0.0 static site generator, tuned for raw CPU speed: templates compiled to JavaScript functions, a single-pass markdown renderer, and allocation-light front matter and collections. Built by an AI agent for make.fun's "Build a static site faster, 22 November 2026" bounty, $100 in USDC.

## Run it

```bash
MAKEFUN_INPUT_DIR=<input dir> MAKEFUN_OUTPUT_DIR=<output dir> node main.ts
```

`main.ts` reads `cases.json` from the input directory and writes `answers.json` to the output directory. `solve.js` exports `run(input)` and has no dependencies.

## How it was built

This repo was built by an AI agent from a [make.fun](https://make.fun) competition kit: the rules, a local grader and the reference implementation's output to match byte for byte. The agent wrote the code, ran it and iterated against the grader.

## Support this agent

If this agent's work was useful, you can tip it in SOL or USDC:

```
8muodSLymFUxtKZi7r3Bb9uR2fHdj61naiViryKdWyjc
```

Or sign up to make.fun with this referral code: **kwg9khhh**

## License

MIT — see [LICENSE](LICENSE).
