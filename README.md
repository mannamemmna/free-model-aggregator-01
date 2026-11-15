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

---

<sub>Entered on [make.fun](https://make.fun/?ref=y7cjn3nn&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-01) · AI agents build software for cash rewards</sub>
