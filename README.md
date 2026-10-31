# Postmaster

Gmail auto-labeler. Rules first, a cheap Azure AI Foundry model second, every category and rule in `config/categories.yaml`. The safe shipped default lives in `config/categories.default.yaml`; your live config is `config/categories.yaml`. See the project plan for the full design.

## Run it (Docker only, no Node on your machine)

```bash
cp .env.example .env                  # fill in Azure values, or set POSTMASTER_MOCK=1
# put your Google OAuth client in secrets/credentials.json

docker compose run --rm ci            # lint, format, typecheck, tests, config check, build
docker compose run --rm --service-ports auth   # one-time login, writes secrets/token.json
docker compose up -d --build          # starts the containers, but Postmaster stays idle
# open http://localhost:8080 and press Start
docker compose logs -f                # read the decisions
```

When a day of logs looks right, set `dry_run: false` in `config/categories.yaml` (no restart needed).

| Command                                        | What it does                                            |
| ---------------------------------------------- | ------------------------------------------------------- |
| `docker compose run --rm test`                 | Tests only                                              |
| `docker compose run --rm ci`                   | Everything CI runs                                      |
| `docker compose run --rm undo <ISO timestamp>` | Remove labels applied since a time                      |
| `docker compose run --rm eval --mock`          | Accuracy and confusion matrix over `eval/dataset.jsonl` |

## Start and Stop

Gmail requests share a quota-unit limiter (4,800 units/minute initially). If Gmail throttles the account, Postmaster preserves progress, waits at least a minute (or Gmail's `Retry-After`), and retries on a later check at a reduced rate. Repeated throttling increases the cooldown.

`docker compose up` never starts processing your mail by itself. Every time the containers start, Postmaster is **stopped** until you press **Start** in the UI. **Start** scans the configured inbox lookback, skipping already-processed emails, then checks new arrivals on the poll interval. Changing the lookback triggers another inbox scan on the next check. **Stop** finishes in-flight emails and then pauses. If something is missing (for example `secrets/token.json`), pressing Start shows what to fix instead of crashing.

## Admin UI

```bash
docker compose up -d ui     # then open http://localhost:8080
```

Recent decisions, editable categories, rules and settings, and a "Try it" box that shows how a pasted email would be sorted without touching Gmail. Saving rewrites your live `config/categories.yaml` (the old version is kept as `categories.yaml.bak`, comments are not preserved) and Postmaster picks it up on its next poll cycle. The shipped default is never touched. The port is published on 127.0.0.1 only and there is no login, so do not expose it.

## Testing approach

- `MailClient` and `Classifier` are interfaces; tests use fakes, so the whole pipeline runs offline.
- Gmail is tested against a mocked service object, Azure against a fake chat client.
- The shipped `config/categories.default.yaml` is loaded in a test, so a typo fails CI before it ships. CI never reads your live `config/categories.yaml`, so local settings cannot break the build.
- Safety properties have explicit tests: dry run changes nothing, no delete action exists, call cap holds, processing is idempotent, injected categories are rejected.
- Use synthetic emails only. Never commit real mail, `.env` or `secrets/`.
