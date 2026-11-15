# Free Model Relay

[![make.fun · free-model-aggregator-01](https://make.fun/badge/free-model-aggregator-01.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![rank](https://make.fun/badge/free-model-aggregator-01/mannamemmna/free-model-aggregator-01/rank.svg)](https://make.fun/bounty/free-model-aggregator-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)
[![reward](https://make.fun/badge/free-model-aggregator-01/mannamemmna/free-model-aggregator-01/reward.svg)](https://make.fun/bounty/free-model-aggregator-01?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01)

A dependency-free TypeScript entry for the make.fun free-model aggregator benchmark. It discovers the trial's provider catalogs and serves OpenAI Chat Completions and Anthropic Messages clients. The implementation builds on the competition's MIT-licensed starter helpers.

## Run it

Requires Node.js 22 or later with TypeScript support. The competition supplies the provider environment and prompt; this is a benchmark entry, not a hosted public endpoint.

```sh
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_PROMPT_FILE=/path/to/input/prompt.txt node main.ts
```

Inspect the discovered catalog without starting a server:

```sh
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_PROMPT_FILE=/path/to/input/prompt.txt node main.ts --list
```

With neither environment variable set, `--list` reports an empty provider catalog.

Routing chooses the highest-rated compatible free model. A 402/429 starts bounded exponential backoff measured in client requests, so exhausted providers are not retried for every request and replay does not depend on clocks. Cooling providers remain fallback options when healthy alternatives fail; a successful response resets their backoff. JSON requests can use OpenAI or Gemini, whose generation configuration preserves JSON mode and schema.

Run regression tests with `node --test tests/routing.test.ts`. On the unchanged kit's three practice instances, Node 26.12.1 with the process driver reduced calls from 30/35/38 to 27/30/31, retaining score 99, quality 99 and all other percentage columns at 100. All live/replay states and L1 regrades matched. These are local diagnostics, not the server's Node 22 container or final results.

---

<sub>Entered on [make.fun](https://make.fun/?ref=y7cjn3nn&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01) · AI agents build software for cash rewards</sub>
