# Postmaster

**An AI-assisted Gmail organizer built for control, resilience, and safe automation.**

Postmaster classifies incoming email using configurable rules, a learned sender cache, and Azure OpenAI. It applies Gmail labels and optional actions based on the result, with a local dashboard for reviewing decisions and managing the pipeline.

**TypeScript · Node.js · Gmail API · Azure OpenAI · SQLite · Docker**

## Highlights

- **Hybrid classification:** checks deterministic rules and cached sender decisions before calling the model, reducing unnecessary API requests.
- **Guarded AI output:** treats email as untrusted input, restricts model responses to configured categories with a JSON schema, and routes low-confidence or invalid results to a fallback category.
- **Safe operation:** supports dry runs, configurable actions, an LLM call cap, and explicit Start/Stop controls. The application has no send or delete action.
- **Resilient processing:** persists decisions and Gmail history cursors in SQLite, skips already-processed messages, and retries failures without advancing the cursor prematurely.
- **Quota-aware Gmail access:** limits request usage and backs off when Gmail throttles requests.
- **Local dashboard:** inspect recent activity, edit categories and rules, adjust settings, and test sample emails without modifying Gmail.

## How it works

```text
Gmail inbox
  ├─ Matching rule ────────────────────────┐
  ├─ Eligible sender cache ────────────────┤
  └─ Azure OpenAI → confidence check ──────┤
                                           ↓
                              Gmail labels / actions
                                           ↓
                            SQLite + local dashboard
```

1. **Discover:** scan the configured inbox lookback on Start, then use Gmail history to find new messages.
2. **Classify:** apply the first matching rule, use an eligible sender-cache result, or request a structured model classification.
3. **Decide:** route low-confidence or invalid responses to the configured fallback; respect category-specific actions and unread-only restrictions.
4. **Apply and record:** modify Gmail in live mode and store the decision. Dry runs record decisions without changing Gmail.

Azure content-filter blocks are filed separately under **AI/Content Filtered** (with your configured label prefix), without archiving or marking the message read. These decisions are treated as processed, not automatically retried. Other Azure errors remain retryable. The ID `content_filtered` and label `Content Filtered` are reserved for this built-in outcome.

## Getting started

### Prerequisites

- Docker and Docker Compose
- A Google Cloud project with the Gmail API enabled and an OAuth client. Place the downloaded client JSON at `secrets/credentials.json`; configure the OAuth consent screen and test users as needed.
- An Azure OpenAI endpoint, API key, and deployment name, or the built-in mock classifier.

Postmaster requests the Gmail `gmail.modify` OAuth scope. Mock mode avoids Azure calls but still requires Gmail credentials to process email.

### Setup

1. Create the environment file and configure Azure, or set `POSTMASTER_MOCK=1`:

   ```bash
   cp .env.example .env
   ```

2. Put your Google OAuth client in `secrets/credentials.json`, then authorize Gmail:

   ```bash
   docker compose run --rm --service-ports auth
   ```

   Open the URL printed by the command and approve access. The token is saved to `secrets/token.json`.

3. Review `config/categories.yaml` and set `settings.dry_run: true` before the first run. The shipped reference configuration is `config/categories.default.yaml`.

4. Build and start the containers:

   ```bash
   docker compose up -d --build
   ```

5. Open [http://localhost:8080](http://localhost:8080) and press **Start**. Review the dry-run decisions before setting `dry_run: false` in the UI or live configuration. Configuration changes take effect on the next poll cycle.

Postmaster starts **stopped** after each container restart. **Start** scans the configured lookback and skips processed messages; **Stop** finishes in-flight work before pausing.

## Configuration

Categories, rules, and settings live in `config/categories.yaml` and can also be edited in the dashboard. Categories define labels, descriptions, examples, actions, and optional unread-only eligibility. Settings include the confidence threshold, fallback category, poll interval, lookback, body length, and daily LLM call cap.

Supported actions are `label`, `star`, `mark_read`, and `archive`. Choose actions carefully: live mode can change read and inbox status. Saving from the UI rewrites the live YAML, preserves the previous version as `categories.yaml.bak`, and removes YAML comments. The shipped default is not changed.

## Commands

| Command                                        | Purpose                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `docker compose logs -f`                       | Follow application logs                                           |
| `docker compose run --rm test`                 | Run tests                                                         |
| `docker compose run --rm ci`                   | Run lint, format check, typecheck, coverage, config check, build  |
| `docker compose run --rm undo <ISO timestamp>` | Undo recorded labels and configured category actions since a time |
| `docker compose run --rm eval --mock`          | Evaluate the mock classifier against a local dataset              |

The undo command modifies Gmail: it removes recorded labels and may restore inbox or unread status based on the current category configuration. It is not a snapshot of the message's original state.

For evaluation, create `eval/dataset.jsonl` with one synthetic example per line, for example:

```json
{
  "from": "orders@example.com",
  "subject": "Your order shipped",
  "body": "Your package is on its way.",
  "label": "receipts"
}
```

The report includes accuracy and a confusion matrix. Omit `--mock` to evaluate the configured Azure deployment.

## Architecture and testing

The application separates the Gmail client, classifier, pipeline, and persistent state behind testable interfaces. The dashboard and poller run as separate containers and share local state. Configuration is validated with Zod; logs are structured with Pino.

Vitest exercises the pipeline offline using fake mail and classifier implementations, with mocked Gmail and Azure clients. Tests cover dry-run behavior, idempotency, retry and quota handling, call limits, configuration validation, and model output validation.

## Privacy and security

- With Azure enabled, message metadata and a cleaned, truncated body are sent to the configured Azure deployment for classification. Review your Azure configuration and policies before processing sensitive mail.
- The dashboard binds to `127.0.0.1` and has no login. Do not expose it publicly.
- Keep `.env`, `secrets/`, `data/`, and real email datasets private. Use synthetic examples in tests and never commit credentials or real email.
