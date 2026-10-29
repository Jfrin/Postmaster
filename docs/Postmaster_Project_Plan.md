# Postmaster: Project Plan

Oct 28, 2026 · @Jose · Stack: TypeScript on Node 24

## Goals and scope

Build one small Docker container that reads new Gmail messages, asks a cheap Azure AI Foundry model which category each belongs to, and applies Gmail labels, with every category and rule living in a config file you can edit without touching code.

**Goals**

- Label every new email within a few minutes of arrival.
- Keep categories, rules and actions in YAML, not in code.
- Run unattended as a single container on a small Azure VM.
- Cost cents per thousand emails by using a small, cheap model and skipping the model when a simple rule already knows the answer.
- Be safe by default: labels and archive only, never delete, with a dry-run mode.
- Be tested: every change passes lint, typecheck, unit tests and a Docker smoke test in CI, and the whole pipeline runs offline against fakes with no API keys.

**Not in version 1**

- Sending or drafting replies.
- Deleting mail or unsubscribing from anything.
- Training your own model.
- A web UI (the config file is the interface), or more than a handful of mailboxes on day one; the design leaves room for both, see Scaling to multiple users.

## Architecture

One container polls Gmail, tries your rules first, and calls the model only for email the rules cannot place.

&#91;embedded content: pipeline architecture · 1 container, 1 decision, 1 paid step\]

A rule match files the email for free; everything else goes to the model, and answers below the confidence threshold are filed under Needs Review. The three mounted files are the only things that change between your laptop and the VM.

## Suggested categories

Start with twelve categories plus one fallback, then delete the ones your inbox never uses. The description column is what the model actually reads, so write it like an instruction.

| Category | Gmail label | What goes in | Default action |
| --- | --- | --- | --- |
| Action Required | AI/Action Required | Asks you to reply, approve, sign or pay by a date | Label, star, keep in inbox |
| Work | AI/Work | Colleagues, clients, project and meeting threads | Label, keep in inbox |
| Personal | AI/Personal | Friends and family, non-commercial one-to-one mail | Label, keep in inbox |
| Finance and Bills | AI/Finance | Statements, invoices due, bank alerts, tax | Label, keep in inbox |
| Receipts and Orders | AI/Receipts | Purchase confirmations, shipping updates, paid invoices | Label, mark read, archive |
| Travel | AI/Travel | Bookings, boarding passes, itineraries, hotel mail | Label, keep in inbox |
| Security and Accounts | AI/Security | Login alerts, password resets, verification codes | Label, keep in inbox |
| Newsletters | AI/Newsletters | Subscribed digests, blogs, Substack-style content | Label, archive |
| Promotions | AI/Promotions | Sales, discounts, marketing blasts | Label, mark read, archive |
| Social and Notifications | AI/Social | Social network and app activity notices | Label, archive |
| Dev and Tech | AI/Dev | GitHub, CI results, cloud and service alerts | Label, archive |
| Events and Calendar | AI/Events | Invites, RSVPs, tickets, reminders | Label, keep in inbox |
| Needs Review | AI/Needs Review | Fallback when the model is unsure | Label, keep in inbox |

The fallback matters most: anything the model scores below the confidence threshold lands in Needs Review instead of being filed wrongly, and you can use those emails to improve your category descriptions.

## Customization

Everything you would want to tweak lives in one `config/categories.yaml` file that is mounted into the container and re-read at the start of every poll cycle, so changes apply without a rebuild or restart.

```yaml
settings:
  label_prefix: "AI/"
  confidence_threshold: 0.7
  fallback_category: needs_review
  dry_run: true               # log decisions, change nothing in Gmail
  poll_interval_seconds: 300
  max_body_chars: 1500        # how much of each email the model sees
  daily_llm_call_cap: 2000    # hard stop on spend

rules:                        # checked first, no model call needed
  - match: { from_domain: "github.com" }
    category: dev
  - match: { from: "boss@company.com" }
    category: action_required

categories:
  - id: receipts
    label: "Receipts"
    description: "Purchase confirmations, shipping updates, paid invoices"
    examples:
      - "Your order has shipped"
    actions: [label, mark_read, archive]
  - id: needs_review
    label: "Needs Review"
    description: "Anything that does not clearly fit another category"
    actions: [label]
```

**How you customize it**

- **Add or remove a category:** add or delete a block under `categories`. The prompt sent to the model is built from this list each cycle.
- **Change what happens to a category:** edit `actions`. The allowed actions are `label`, `star`, `mark_read` and `archive`; there is deliberately no delete.
- **Fix a wrong guess:** add a rule for the sender, or sharpen the category description or add an example.
- **Control spend and risk:** `dry_run`, `confidence_threshold` and `daily_llm_call_cap` are all one-line changes.
- **Catch typos early:** the service validates the file against a schema at startup and on each reload, and keeps using the last good config if the new one is invalid.

## Model choice and prompt design

Deploy the cheapest small chat model in your Azure AI Foundry catalog and force it to return structured JSON; at a few hundred tokens per email, classification should cost cents per thousand emails.

- **Candidates:** a nano or mini-class OpenAI model deployed through Azure OpenAI in Foundry (the GPT-4.1 nano or GPT-4o mini class) is the obvious start. Small open models such as Phi or Mistral Small on serverless endpoints are worth one comparison run. Model names, availability and prices change, so confirm them in the Foundry model catalog and on the Azure pricing page when you deploy.
- **Pick by testing:** hand-label about 100 of your own emails, run them through two models, and keep the cheaper one if accuracy holds.
- **What the model sees:** sender, subject, date, whether a `List-Unsubscribe` header exists, and the first 1,500 characters of the plain-text body with HTML and long links stripped. No attachments.
- **What it returns:** JSON constrained by a schema, with `category` limited to the ids in your config so it cannot invent one. Use temperature 0.
- **Auth:** an API key in an environment variable for version 1, then managed identity on the VM so there is no key to leak.

```json
{ "category": "receipts", "confidence": 0.93, "reason": "Order shipment notice from a retailer" }
```

**Cost levers, in order of impact**

1. Rules run first, so known senders never reach the model.
2. A sender that lands in the same category three times in a row with high confidence is cached and skipped.
3. Threads that already carry an `AI/` label are skipped.
4. `daily_llm_call_cap` stops spend if something loops.

Rough sizing, approximate: about 600 input tokens and 40 output tokens per email, so 1,000 emails is around 0.6 million input tokens. Multiply by the per-million-token price of the model you pick.

## Gmail integration

Use the Gmail API with the `gmail.modify` scope and poll for changes every few minutes; it is the simplest design that works on a VM with no public endpoint.

- **Google Cloud setup:** create a project, enable the Gmail API, configure the OAuth consent screen, and create a Desktop app OAuth client. Download its `credentials.json`.
- **Token expiry trap:** while the consent screen is in Testing status, refresh tokens expire after 7 days and the service will silently lose access. Move the app to In production for your own use; you will see an unverified-app warning once, which is fine for your own account.
- **Headless auth:** run the OAuth consent flow once on your laptop to produce `token.json`, then copy it to the VM's secrets folder. The service refreshes it from then on.
- **Scope:** `gmail.modify` can read, label and archive but cannot permanently delete mail, which fits the safe-by-default goal.
- **Finding new mail:** store the last seen `historyId` in a small SQLite file. Each cycle calls `users.history.list` for added messages, fetches each one, classifies it, and applies labels with `users.messages.modify`.
- **First run:** only process the last 7 days by default, with an optional backlog mode you switch on deliberately.
- **Labels:** create the `AI/...` labels at startup if they are missing; the slash makes them nest in Gmail's sidebar.

**Alternatives considered**

- **Push notifications** (`users.watch` with Pub/Sub) are near real-time but need a public HTTPS endpoint, so they are a later upgrade.
- **IMAP with an app password** is easier to authenticate but has no history cursor and clumsier label handling.

## Docker setup

Package the service as a single TypeScript (Node 24) container that loops forever, with config, secrets and state mounted from the host so the image itself holds nothing personal.

```text
postmaster/
  src/
    main.ts            # poll loop, heartbeat, graceful shutdown, --check-config
    gmail.ts           # auth, history, labels, modify (behind the MailClient interface)
    classifier.ts      # prompt, Foundry call, mock classifier (behind the Classifier interface)
    pipeline.ts        # rules, sender cache, call cap, model, actions, dry run
    rules.ts           # rule matching
    config.ts          # zod schema, load and validate the YAML, keep last good config
    state.ts           # SQLite: historyId, decisions, sender cache, call counter
    text.ts            # HTML stripping, link shortening, address parsing
    eval.ts            # accuracy and confusion matrix
    logger.ts types.ts
  scripts/             # auth.ts, undo.ts, eval.ts
  test/                # *.test.ts plus helpers.ts with the fakes
  config/categories.yaml
  secrets/             # credentials.json, token.json (never in git)
  data/                # state.db and heartbeat (volume)
  .github/
    workflows/ci.yml
    dependabot.yml
  Dockerfile
  docker-compose.yml
  package.json  tsconfig.json  tsconfig.build.json
  vitest.config.ts  eslint.config.js  .prettierrc.json
  .env                 # endpoint, key, deployment name
```

```dockerfile
# dev: full toolchain. Used by the ci, test, auth, undo and eval compose services.
FROM node:24-slim AS dev
WORKDIR /srv
RUN chown node:node /srv
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
COPY --chown=node:node . .
CMD ["npm", "run", "ci"]

# build: compile TypeScript
FROM dev AS build
RUN npm run build

# runtime (default target): production deps and compiled JS only
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /srv/dist ./dist
# The built-in "node" user is uid 1000, so it can write ./data on a typical Linux VM.
USER node
CMD ["node", "dist/main.js"]
```

```yaml
x-tool: &tool
  build: { context: ., target: dev }
  env_file: [{ path: .env, required: false }]
  profiles: [tools]

services:
  postmaster:
    build: { context: ., target: runtime }
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./config:/srv/config:ro
      - ./secrets:/srv/secrets
      - ./data:/srv/data
    healthcheck:
      # unhealthy if the heartbeat file has not been touched for 15 minutes (3 poll cycles)
      test: ["CMD-SHELL", "find /srv/data/heartbeat -mmin -15 | grep -q ."]
      interval: 1m
      timeout: 10s
      retries: 3
      start_period: 2m
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  # docker compose run --rm ci      lint, format, typecheck, tests, config check, build
  ci:
    <<: *tool
    command: npm run ci

  # docker compose run --rm test
  test:
    <<: *tool
    command: npm test

  # docker compose run --rm --service-ports auth     one-time Google login, writes secrets/token.json
  auth:
    <<: *tool
    ports: ["3000:3000"]
    volumes: ["./secrets:/srv/secrets"]
    command: npx tsx scripts/auth.ts

  # docker compose run --rm undo 2026-10-28T00:00:00Z
  undo:
    <<: *tool
    entrypoint: ["npx", "tsx", "scripts/undo.ts"]
    volumes: ["./config:/srv/config:ro", "./secrets:/srv/secrets", "./data:/srv/data"]

  # docker compose run --rm eval --mock
  eval:
    <<: *tool
    entrypoint: ["npx", "tsx", "scripts/eval.ts"]
    volumes: ["./config:/srv/config:ro", "./eval:/srv/eval:ro"]
```

- **Libraries:** `@googleapis/gmail` (Gmail only; the full `googleapis` package makes `tsc` run out of memory in small Docker VMs), `google-auth-library`, `openai` (its `AzureOpenAI` client), `zod`, `yaml` and `pino`. SQLite comes from Node's built-in `node:sqlite`, so there is no native build step in the image. It is still marked experimental in Node, so pin the Node major version and keep `state.ts` well tested; `better-sqlite3` is the fallback.
- **Dev tooling:** `typescript`, `tsx`, `vitest`, `eslint` with `typescript-eslint`, and `prettier`. Compiled output goes to `dist/`; the runtime image holds only production dependencies and `dist/`.
- **Permissions:** the official Node image's `node` user is uid 1000, so it can write `./data` on a typical Linux VM where your login user is also uid 1000. The `secrets` mount is writable so a refreshed token can be saved back; `config` stays read-only.
- **Never baked in:** put `secrets/`, `data/` and `.env` in both `.gitignore` and `.dockerignore`.
- **Health:** the loop touches a heartbeat file in `data/` each cycle; the compose healthcheck marks the container unhealthy if it goes 15 minutes stale.
- **Shutdown:** the loop sleeps in one-second slices and exits cleanly on SIGTERM, so `docker compose stop` is quick and never interrupts a Gmail call halfway.
- **Everything in Docker:** `docker compose run --rm ci|test|auth|undo|eval` runs the tooling in a `dev` image target, so nothing needs Node installed on the host. The default `runtime` target stays lean.
- **Local first:** run `docker compose up` on your own machine with `dry_run: true` and read the logs before touching a VM.

## Testing and CI

Every outside dependency sits behind a small interface (`MailClient` for Gmail, `Classifier` for the model), so the entire pipeline runs offline in a few seconds, and CI repeats that on every push.

| Layer | What it covers | How |
| --- | --- | --- |
| Unit | Rule matching, HTML and link cleaning, address parsing, config schema, SQLite state, eval metrics | Vitest, in-memory SQLite |
| Pipeline | Rules, sender cache, call cap, fallback, dry run, idempotency, cursor handling | `processMessage` and `runCycle` with a fake mail client and fake classifier |
| Adapters | `GmailClient` (labels, history, 404 fallback, body parsing, modify) and `AzureClassifier` (schema, retry, validation) | Mocked Gmail service object and a fake chat client |
| Config contract | The shipped `categories.yaml` is valid | A test that loads it, plus `npm run check-config` in CI and inside the built image |
| Safety properties | Dry run changes nothing, no delete action can be configured, the cap holds, an injected category is rejected, a failed message is retried | Explicit named tests, so a refactor cannot quietly drop them |
| Accuracy | Does the model pick the right category? | `npm run eval` on your labelled emails; run by hand, not in CI (costs money, uses private data) |

**Ground rules**

- No network and no API keys in tests; the mock classifier keeps the project runnable for anyone.
- Synthetic emails only; never commit real mail.
- Coverage thresholds live in `vitest.config.ts` (85% lines, 75% branches) and fail the build if they slip.
- A bug fix lands with a failing test first.
- `npm run ci` runs the same checks as CI locally before you push.

**CI pipeline** (`.github/workflows/ci.yml`, on every push and pull request)

| Job | Steps |
| --- | --- |
| `check` (Node 22 and 24) | `npm ci`, ESLint, Prettier check, `tsc --noEmit`, tests with coverage, `check-config`, build |
| `docker` | Build the image, run `--check-config` inside it against the shipped config, confirm it runs as uid 1000 |
| `audit` | `npm audit --omit=dev --audit-level=high` |
| `secrets` | gitleaks scan so a stray `token.json` or `.env` fails the build |

Dependabot opens weekly updates for npm, Docker and GitHub Actions, and CI vets each one. Turn on branch protection for `main` so merges need a green run. Anything that touches real Gmail or the paid model stays out of CI; an optional manually triggered smoke workflow can come later.

## Azure deployment

One small Linux VM running Docker is enough, because the service only makes outbound calls and sleeps between polls. Keep secrets out of the image and set an Azure budget alert before anything runs.

1. **Create the resources:** a resource group, an Azure AI Foundry project with your chosen small chat model deployed (note the endpoint and deployment name), and an Ubuntu VM. A burstable B-series size such as B1s or B2s should be plenty; compare current prices in the Azure pricing calculator.
2. **Install Docker** Engine and the compose plugin on the VM, and enable the Docker service at boot so it survives restarts.
3. **Copy the project over:** `git clone` your private repo, then `scp` the `secrets/` folder and `.env` across. Never commit them.
4. **Lock it down:** `chmod 600` on `.env` and the secrets, and a network security group that allows SSH only from your own IP with no other inbound ports.
5. **Start in dry-run:** `docker compose up -d --build`, then read `docker compose logs -f` for a day and check the categories look right.
6. **Go live:** set `dry_run: false` in `categories.yaml`; no restart needed.
7. **Update later:** `git pull && docker compose up -d --build`.

**Hardening, once it works**

- **Managed identity:** turn on the VM's system-assigned identity, give it the Cognitive Services OpenAI User role on the model resource, switch the code to `DefaultAzureCredential` from `@azure/identity`, and delete the API key from `.env`.
- **Log size:** add a `json-file` logging limit (for example 10 MB, 3 files) to the compose service so logs cannot fill the disk.
- **Spend alerts:** an Azure budget with email alerts on the subscription, plus the in-app `daily_llm_call_cap`.
- **Deploy from CI:** once CI is green on `main`, optionally build and push the image to Azure Container Registry or GHCR from a release workflow, so the VM runs `docker compose pull` instead of building on the box.
- **Outgrowing the VM:** the same image runs unchanged on Azure Container Apps if you later want to stop managing a machine.

## Scaling to multiple users

Treat every mailbox as a tenant handled by the same worker code, so going from one user to many is a change of storage and infrastructure, not a rewrite. Grow in three stages and only move on when the last one hurts.

| Stage | Users | How it works | What changes |
| --- | --- | --- | --- |
| A: one worker, many mailboxes | 2 to 10 (you and friends) | One container loops over a list of users each cycle | A `users/` folder with one config and one token file per person; same VM |
| B: queue and workers | tens to hundreds | Each cycle puts one job per user on a queue; several worker containers pull jobs | Postgres replaces SQLite, a queue (Azure Service Bus or Storage Queue) is added, tokens move to an encrypted store with the key in Azure Key Vault |
| C: public sign-up | open to anyone | Users connect their own Gmail through a sign-in page | A small web app with HTTPS for the Google OAuth flow (Azure Container Apps fits), per-user billing or limits, and Google's app verification |

**Cheap rules to follow from day one**

- **Pass a user context, not globals:** every function receives that user's config, credentials and state handle.
- **Key everything by user:** every table carries a `user_id`, and processing is idempotent on (`user_id`, `message_id`) so a retried job never double-labels.
- **Layer the config:** a shared default `categories.yaml` plus a per-user override file that only lists what that person changed.
- **Cap per user:** the daily model-call cap and the confidence threshold are settings per user, so one noisy inbox cannot burn everyone's budget.
- **Back off politely:** retry Gmail and model calls on rate-limit errors with exponential delay; the Foundry deployment has a tokens-per-minute quota that all users share.

**What gets harder with other people's mail**

- **Google verification:** the `gmail.modify` scope is restricted. Unverified apps are capped at 100 users and show a warning screen; going public means Google's verification and a third-party security assessment, so plan for it or keep stage C to a closed group.
- **Consent and trust:** tell each user exactly what is sent to the model, get their agreement, and give them a one-step way to disconnect and delete their stored token and data.
- **Blast radius:** a breach exposes every user's mailbox access, so encrypt tokens at rest, give workers least-privilege access, and keep Key Vault access to the worker identity only.

## Privacy, safety and cost controls

The service reads your whole inbox, so the design limits what leaves your mailbox and what the service is able to do with it.

- **What the model sees:** only a truncated, link-stripped body. A rule never calls the model, so put each sensitive sender (banks, health) under a rule in `categories.yaml` so their email content is never sent.
- **Data terms:** check Microsoft's data and privacy documentation for the model you deploy, including whether prompts are retained or used for training, before pointing it at a real inbox.
- **Prompt injection:** email text is untrusted. The model can only return a category id from a fixed list, and the code can only run the four allowed actions, so an email that says "delete everything" has nothing to act on.
- **Reversible by design:** no delete and no send. Every decision (message id, category, confidence, rule or model) goes into the SQLite log, which a small undo script can use to remove the labels.
- **Credentials:** `token.json` grants mailbox access, so treat the VM and the repo accordingly. If it leaks, revoke the app in your Google account's security settings.
- **Spend:** `daily_llm_call_cap` in the app plus an Azure budget alert outside it.

## Roadmap and open questions

Build it in five phases, each ending in something you can check before moving on and each merged only with its tests and a green CI run.

1. **Local prototype:** project skeleton with lint, tests and CI green from the first commit, Gmail auth, read-only fetch, classify about 100 emails and print the results. Done when CI is green and you agree with most of its picks (aim for roughly 90%).
2. **Labeling and config:** apply labels, load `categories.yaml`, add rules, the SQLite state and the decision log, all behind `dry_run` and covered by offline tests with fakes.
3. **Containerize:** Dockerfile, compose file and healthcheck, run on your own machine for a few days, with CI building the image and smoke-testing it. Done when it survives a restart and picks up where it left off.
4. **Azure:** Foundry deployment, VM, budget alert, then dry-run and go live. Done when a week of mail is filed without you touching it.
5. **Hardening and extras:** managed identity, sender cache, undo script, and a feedback loop where labels you correct by hand become new examples. Optional: a daily digest of Needs Review, and push notifications instead of polling.

**Questions to settle before phase 1**

- [ ] Which categories do you actually want from the suggested list?
- [ ] Should newsletters and promotions be archived automatically, or only labeled at first?
- [ ] Are there senders whose email content must never be sent to the model?
- [ ] Process your existing backlog, or only new mail from now on?
- [ ] Is this a personal Gmail account, or a Google Workspace one (admins can block third-party OAuth apps)?

## Build checklist

Check items off as you go. These phases are finer-grained than the five-phase roadmap above, and each one ends in something you can run or verify. `[x]` means the code exists in the scaffold and its offline tests pass; nothing has been run against live Gmail, Azure or Docker yet.

### Phase 0: Project setup

- [ ] Create a private repo named `postmaster` and run `git init`
- [x] Add `.gitignore` (`.env`, `secrets/`, `data/`, `node_modules/`, `dist/`, `coverage/`) and a matching `.dockerignore`
- [x] Set up a TypeScript project on Node 24 with `package.json` (ESM), strict `tsconfig.json`, ESLint with `typescript-eslint`, Prettier and Vitest
- [x] Add dependencies: `@googleapis/gmail`, `google-auth-library`, `openai`, `zod`, `yaml`, `pino`; dev: `typescript`, `tsx`, `vitest`, `@vitest/coverage-v8`, `eslint`, `prettier`
- [x] Add npm scripts: `build`, `typecheck`, `lint`, `format:check`, `test`, `test:coverage`, `check-config` and `ci` (runs them all)
- [x] Create `.env.example` with `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT` and `POSTMASTER_MOCK`

### CI and testing (alongside every phase)

- [x] Test seams: `MailClient` and `Classifier` interfaces, with fakes in `test/helpers.ts`
- [x] Vitest coverage thresholds (85% lines, 75% branches) that fail the run when missed
- [x] A test that loads the shipped `config/categories.yaml`, and `npm run check-config`
- [x] Named safety tests: dry run, no delete action, call cap, idempotency, injected category rejected, retry after failure
- [ ] Push to GitHub and get the first green run of `.github/workflows/ci.yml` (`check` on Node 22 and 24, `docker`, `audit`, `secrets`)
- [ ] Turn on branch protection for `main`: require the CI jobs to pass before merge
- [ ] Enable Dependabot (`.github/dependabot.yml`) for npm, Docker and GitHub Actions
- [ ] Add a regression test with every bug fix, written before the fix
- [ ] Optional: a manually triggered live smoke workflow that labels a throwaway Gmail account

### Phase 1: Google and Azure accounts

- [ ] Create a Google Cloud project and enable the Gmail API
- [ ] Configure the OAuth consent screen (External), add yourself as a test user, add the `gmail.modify` scope
- [ ] Create a Desktop app OAuth client and save `credentials.json` into `secrets/`
- [ ] Switch the consent screen to In production so refresh tokens do not expire after 7 days
- [ ] Write `scripts/auth.ts` to run the OAuth flow once on your laptop and save `secrets/token.json`
- [ ] In Azure, create a resource group and a Foundry project, and deploy a small chat model; note the endpoint and deployment name
- [ ] Smoke test: one chat completion from a throwaway script returns text

### Phase 2: Gmail client

- [x] `src/gmail.ts`: load credentials from `secrets/token.json` and refresh them
- [x] List messages with `newer_than:7d` and fetch headers plus the plain-text body
- [x] Strip HTML, trim long links and truncate to `max_body_chars`
- [x] Create the `AI/...` labels if missing and map category ids to label ids
- [x] `apply_actions`: `label`, `star`, `mark_read` and `archive` through `users.messages.modify`
- [x] Track `historyId` and fetch new mail with `users.history.list`
- [x] Unit tests against a mocked Gmail service

### Phase 3: Config and rules

- [x] `src/config.ts`: zod schema for `categories.yaml` (settings, rules, categories)
- [x] Write the default `config/categories.yaml` with the twelve categories plus `needs_review`
- [x] Re-read the config at the start of every cycle and keep the last good config if the new one is invalid
- [x] Rule engine matching `from`, `from_domain` and `subject_contains`, first match wins
- [x] Unit tests for each rule path and for an invalid config file

### Phase 4: Classifier (Azure AI Foundry)

- [x] `src/classifier.ts`: build the Azure client from environment variables
- [x] Build the prompt from the category list and request JSON with a `category` enum, `confidence` and `reason`, temperature 0
- [x] Retry once on schema validation failure, back off on 429 and 5xx
- [x] Anything below `confidence_threshold` goes to `needs_review`
- [x] Sender cache: three consistent high-confidence results for a sender skips the model
- [x] Enforce `daily_llm_call_cap` from a counter in the state database
- [x] A mock classifier mode so tests and demos run with no API key
- [x] Unit tests with mocked model responses

### Phase 5: State, logging and safety

- [x] `src/state.ts`: SQLite (built-in `node:sqlite`) tables for `historyId`, `decisions`, `sender_cache` and `llm_calls`
- [x] Decision log with message id, category, confidence, rule or model, and timestamp
- [x] Skip threads that already carry an `AI/` label
- [x] `dry_run` mode that logs decisions and changes nothing in Gmail
- [ ] `scripts/undo.ts` removes the labels applied since a given time
- [x] Structured JSON logging
- [x] Touch a heartbeat file in `data/` every cycle

### Phase 6: Evaluation

- [ ] Export about 100 of your own emails to `eval/dataset.jsonl` (sender, subject, body snippet, your label) and keep it out of git
- [x] `scripts/eval.ts` reporting accuracy and a confusion matrix (`--mock` for the keyword classifier; point `AZURE_OPENAI_DEPLOYMENT` at a different deployment to compare models)
- [ ] Run two deployed models over the same set and save the numbers to `eval/results.md`
- [ ] Tune category descriptions on one half, report the score on the held-out half
- [ ] Pick `confidence_threshold` by weighing how many emails go to review against how many are misfiled

### Phase 7: Docker

- [ ] Multi-stage `Dockerfile` on `node:24-slim` (build with dev dependencies, runtime with production only) running as the `node` user, uid 1000
- [ ] `docker-compose.yml` with the three mounts, `restart: unless-stopped`, a heartbeat healthcheck and a `json-file` log limit
- [ ] CI `docker` job: build the image, run `--check-config` inside it, assert uid 1000
- [ ] Confirm `docker compose up` works from a fresh clone in dry-run
- [ ] Run it locally for a few days, restart it mid-run, and check it resumes from the saved `historyId`

### Phase 8: Azure VM

- [ ] Create a B-series Ubuntu VM with a network security group allowing SSH only from your IP
- [ ] Install Docker Engine and the compose plugin, then `systemctl enable docker`
- [ ] `git clone` the repo, `scp` `secrets/` and `.env`, then `chmod 600` them
- [ ] Create an Azure budget alert on the subscription
- [ ] `docker compose up -d --build` and watch the logs for a day in dry-run
- [ ] Set `dry_run: false` in `categories.yaml`
- [ ] Enable the VM's managed identity, grant it Cognitive Services OpenAI User, switch to `DefaultAzureCredential` and delete the API key

### Phase 9: Multi-user, stage A

- [ ] Introduce a `UserContext` (config, credentials, state handle) and pass it instead of globals
- [ ] Add `user_id` to every table and make processing idempotent on (`user_id`, `message_id`)
- [ ] Per-user folder `users/<name>/` with a config override and `token.json`
- [ ] Layer config: shared default plus the per-user override
- [ ] Per-user call cap and confidence threshold
- [ ] Worker loops over users and one user's failure never stops the others
- [ ] `scripts/auth_user.ts <name>` for onboarding a new mailbox

### Phase 10: Multi-user, stages B and C (optional)

- [ ] Move state to Azure Database for PostgreSQL with SQL migrations (for example node-pg-migrate)
- [ ] Add a queue (Service Bus or Storage Queue) with one job per user and several worker containers
- [ ] Encrypt tokens at rest with the key in Azure Key Vault
- [ ] Web sign-in page over HTTPS (Azure Container Apps) for the Google OAuth flow
- [ ] Disconnect-and-delete endpoint that removes a user's token and data
- [ ] Google app verification and security assessment before going past 100 users

### Phase 11: Polish (optional)

- [ ] README with the architecture diagram, config reference and setup steps
- [ ] Daily digest email of everything in Needs Review
- [ ] Feedback loop: labels you correct by hand become new examples in the prompt
- [ ] Push notifications with `users.watch` and Pub/Sub instead of polling

### Notes

- Keep `dry_run` on until a full day of decisions looks right.
- Never commit `.env`, `secrets/` or real emails; use synthetic data in tests.
- Run `npm run ci` before every push; CI runs the same steps, so a green local run should mean a green build.
- Every new rule path, action or safety behaviour gets a test in the same change; coverage thresholds will fail the build if it does not.
- Keep the mock classifier working so the project runs for anyone without keys.
- All classification, rules and actions live in the Postmaster code; the config file only changes behavior, never adds logic.
