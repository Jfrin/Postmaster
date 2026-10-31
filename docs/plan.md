# Postmaster: canonical project plan

This is the single source of truth for the project roadmap. For exact current behavior and commands, see the code, `README.md`, `config/categories.default.yaml`, and `docker-compose.yml`.

## Goal and scope

Build a safe, low-cost Gmail organizer that classifies mail using configurable rules, a sender cache, and Azure OpenAI; applies configured Gmail labels and actions; and provides a dashboard. Start with one private account on Azure, then support a small allowlisted beta with isolated accounts and an admin UI. Public sign-up is a later possibility, not the initial goal.

The app does not send, draft, delete, or unsubscribe from email. Classification and actions are implemented in code; configuration controls categories, rules, and settings. Keep dry run available, require explicit Start, and test behavior offline with synthetic data.

## Decisions before deployment

| Topic | Status |
| --- | --- |
| Audience | **Chosen:** small allowlisted beta; an admin UI should add and remove users. Google OAuth Testing mode also requires users to be added in Google Cloud. |
| Budget and region | **Tentative:** approximately $10/month in Japan East using Azure for Students. Confirm eligibility, quota, availability, model access, and a full cost estimate before provisioning. |
| Restart | **Chosen:** processing stays stopped by default after restart. Resume only after a user explicitly starts it; any future auto-resume option must be opt-in. |
| Hostname and ownership | **Open:** no domain is needed for the private SSH-tunneled dashboard. For the beta, choose an HTTPS hostname, such as a domain you own or a suitable subdomain, and verify Google OAuth domain requirements. Decide who owns the Azure subscription and Google Cloud projects. |
| Mail data | **Open:** decide what to store, retention periods, deletion and backup policies, and what may be sent to Azure. A privacy-first option is no stored bodies and limited decision metadata, but it is not yet a decision or an implemented retention policy. |

Also decide which categories and actions to use, whether to archive newsletters or promotions, which sensitive senders should bypass the model, how much backlog to process, and whether the account is personal Gmail or Workspace with administrator restrictions.

## Current baseline

The repository contains a single-user TypeScript/Node app, a Docker Compose deployment, offline tests, and a local dashboard. Implementation exists; this checklist does **not** imply that live Gmail, Azure, Docker, or a remote deployment has been verified.

Checked items below mean the implementation or configuration exists in the repository; they do not assert that tests or external deployments were run for this review.

- [x] Set up the TypeScript project, linting, formatting, build scripts, Vitest, and environment template.
- [x] Implement Gmail OAuth helper, message fetching, history cursor, labels, configured actions, and quota handling.
- [x] Implement validated YAML configuration, categories, rules, unread-only eligibility, and reloads.
- [x] Implement Azure and mock classifiers, constrained model output, fallback handling, sender cache, and a daily call cap.
- [x] Implement SQLite state, decision history, dry run, heartbeat, structured logging, and an undo tool.
- [x] Implement the local dashboard, configuration editing, activity, classification preview, and Start/Stop controls that start stopped.
- [x] Provide a multi-stage Dockerfile and Compose services with persistent mounts, localhost-only UI, poller healthcheck, and log rotation.
- [x] Provide offline tests and fakes, coverage thresholds, evaluation tooling, CI workflow with Docker smoke, dependency and secret scans, and Dependabot configuration.
- [x] Exclude local secrets, data, and real evaluation datasets from Git and Docker build context.

- The poller discovers mail using an initial lookback and Gmail history, checks rules and the sender cache, then optionally calls Azure OpenAI. Low-confidence or invalid results use a fallback; content-filtered mail receives a separate label without archive or mark-read actions.
- The current `gmail.modify` scope is restricted. Configurable actions are `label`, `star`, `mark_read`, and `archive`. Dry runs do not modify Gmail. SQLite stores cursors, decisions, sender cache, and model-call counts; the UI displays recent decisions, including sender and subject.
- Categories, rules, and settings are validated YAML, reloaded by the poller. Defaults include a 300-second poll interval, 1,500 body characters, a 7-day lookback, and a daily model-call cap. Check the actual live config before use. The cap limits application calls, not total Azure spending.
- The model receives sender, subject, date, List-Unsubscribe presence, a cleaned and truncated body, and category instructions; it does not receive attachments. A constrained JSON response selects a configured category. Rule and cache hits avoid model calls. Check the chosen model's Azure data terms and region before processing real mail.
- The dashboard edits configuration, shows activity, offers a classification preview, and controls Start/Stop. Its current UI has **no login** and is bound to localhost by Compose; never expose it publicly. Every container restart begins stopped.
- The poller and UI are separate containers sharing `data/`; config and credentials are mounted, not baked into the image. The current token file and default-user assumptions are not a multi-user implementation.
- `scripts/auth.ts`, `scripts/undo.ts`, and `scripts/eval.ts` exist. Undo is not a snapshot of the original mailbox state and can affect labels, inbox, and unread status; see the README before using it.

## Phase 0: Validate and prepare locally

- [ ] Confirm Google Cloud project ownership, enable Gmail API, configure the OAuth consent screen, and set up the desktop OAuth client and local token for the initial account.
- [ ] Configure the Azure OpenAI endpoint, deployment, and credentials; confirm access and test a completion. Alternatively use the mock classifier for offline evaluation.
- [ ] Review shipped categories, action defaults, body length, model-call cap, and lookback. Start in dry run and verify decisions before allowing live changes.
- [ ] Run local checks and offline tests (`npm run ci` or the Compose CI service), and verify Docker Compose from a fresh setup. Confirm restart leaves processing stopped and Start respects persisted state.
- [ ] Evaluate classification on an appropriately protected, labeled sample; compare candidate models and a held-out set, then choose a confidence threshold. Never commit real email or credentials. Avoid promising a model cost before measuring token usage and current prices.
- [ ] Confirm GitHub CI and its Docker smoke tests and dependency/secret scans run successfully; configure branch protection as appropriate. Keep regression tests, synthetic fixtures, the mock classifier, and offline tests working.

**Exit:** the single-user app runs locally in dry run, its safety controls are understood, and live integrations have been tested separately.

## Phase 1: Private Azure deployment

- [ ] Estimate Japan East compute, persistent disk, public IP/network, backup, logging, and model costs with the Azure pricing calculator. Verify Student free-tier terms and model availability; set budget alerts, understanding they are not a hard cap.
- [ ] Provision a suitable small Linux VM and persistent disk; install Docker and Compose, enable Docker at boot, and restrict SSH to trusted sources or use a VPN. Keep dashboard access on localhost through an SSH tunnel or VPN.
- [ ] Configure the resource group and Azure model deployment. Transfer secrets securely; restrict `.env`, credentials, token, config, and SQLite access. Never commit them or bake them into images.
- [ ] Preserve `data/`, `config/`, and the Google token across container and VM restarts. Configure encrypted, consistent SQLite backups and test restoration, including secrets and configuration.
- [ ] Start in dry run; inspect decisions and errors before enabling live actions. Document deployment, updates, rollback, stop, backup, and recovery.
- [ ] Add alerts for stopped or unhealthy processing, Gmail authorization failures, Azure errors, and low disk. The existing container heartbeat healthcheck alone is not an alert.
- [ ] Verify restart stays stopped, Start and Stop work, cursors and decisions survive, and retries/restarts do not produce unintended repeated actions. Test failures between Gmail modification and local persistence; do not assume exactly-once processing.
- [ ] Harden Azure authentication with managed identity and least-privilege access where supported; replace the API key only after the application supports and tests that flow.

**Exit:** one account runs privately, can be started and stopped safely, and can be restored after failure.

## Phase 2: Secure multi-user beta

Authentication alone does not make the existing single-user backend safe for multiple users. Complete isolation, privacy, and policy checks before allowing beta users to connect real inboxes.

### Identity and administration

- [ ] Choose an HTTPS hostname and trusted reverse proxy; register a Google OAuth web client and exact callback URLs. Never expose the current unauthenticated UI or trust arbitrary forwarded headers.
- [ ] Implement Google sign-in separately from explicit Gmail connection and consent. Validate OpenID Connect identity and OAuth state; use authorization-code flow and PKCE where applicable. Identify users by verified Google subject, not a client-supplied email or ID.
- [ ] Implement secure, expiring sessions with `HttpOnly`, `Secure`, and appropriate `SameSite` cookies, logout, and CSRF protections. Update localhost host/origin checks without losing DNS-rebinding defenses.
- [ ] Require authentication and authorization for every dashboard, API, and activity stream; deny by default. Build an admin-only UI to invite, add, remove, and manage allowlisted users and administrators. Define bootstrap and recovery for the initial admin.
- [ ] Handle Gmail token refresh, missing or revoked grants, insufficient scopes, disconnect/revocation, and reconnect. Encrypt refresh tokens at rest with separately protected keys, using Azure Key Vault or an equivalent solution.
- [ ] Test login, callback validation, session expiry, CSRF, unauthorized requests, admin-only actions, token refresh, and disconnect/reconnect.

### Isolation and processing

- [ ] Design user and Gmail-connection records and a per-user context. Replace the shared token, configuration, control files, and default-user assumptions with per-user storage and controls. Scope every query, API response, setting, activity stream, and background job to its owner.
- [ ] Select durable storage for the expected concurrency and budget; SQLite may be evaluated for a small single-instance beta, while managed PostgreSQL and a queue are possible later choices. Plan and test migrations and backup recovery; neither managed PostgreSQL nor a queue is assumed to fit $10/month.
- [ ] Design scheduling, per-user history cursors, retries, quota backoff, rate limits, and locking or leases to prevent overlapping workers during deployment or failure. Isolate failures between users.
- [ ] Preserve dry runs, per-user Start/Stop and call caps, sender-cache isolation, content-filter handling, and idempotency. Design for failures between Gmail and database operations rather than assuming exactly-once delivery.
- [ ] Implement account deletion and retention for settings, decisions, sender caches, tokens, logs, and backups. Balance metadata deletion with deduplication, recovery, and undo needs.
- [ ] Test at least two users end to end, including cross-account access attempts, simultaneous jobs, restart recovery, duplicates, and partial failures.

### Privacy, policy, and beta readiness

- [ ] Before inviting testers, review Google's approved Gmail use cases and user data policies, including sending email content to Azure OpenAI. Document the data flow, the selected model's terms, consent, retention, deletion, and security controls.
- [ ] Confirm the applicable Google OAuth verification and security-assessment requirements for the intended beta and production use. `gmail.modify` is restricted; server-side storage or transmission can require a third-party assessment. Do not assume a user-count threshold alone determines compliance.
- [ ] If using an external OAuth app in Testing mode, add each tester in Google Cloud as well as the app allowlist; Gmail-scoped refresh tokens expire after seven days, so provide reconnection handling. Do not switch to production solely to bypass expiry without checking Google requirements.
- [ ] Provide clear privacy and consent information; define a support contact, incident response, audit events, and privacy-conscious logs without email bodies, tokens, or secrets.
- [ ] Set per-user usage limits, cost and operational alerts, and test backups and recovery. Run the small allowlisted beta only after the security and isolation checks pass.

**Exit:** at least two allowlisted users can independently connect, configure, pause, and process mail without accessing each other's data; applicable beta policy requirements are met.

## Phase 3: Public launch, only if desired

- [ ] Complete applicable Google restricted-scope verification and any required security assessment before production/public access; budget for ongoing review and reassessment where required.
- [ ] Publish privacy policy and terms describing Gmail permissions, Azure processing, retention, and deletion. Complete a threat model and security review of authorization, tokens, sessions, logs, backups, and incident response.
- [ ] Review beta reliability, cost, support, and abuse controls. Add CI, vulnerability checks, deployment/rollback procedures, restoration tests, and availability expectations appropriate for the audience.
- [ ] If load warrants it, evaluate managed PostgreSQL, queues/workers, managed containers, and per-user billing or limits. Re-evaluate cost and architecture rather than assuming the existing Compose app can move unchanged.

## Optional improvements

- [ ] Onboarding explaining consent, dry run, and Start; connection status, error notifications, and activity/usage charts.
- [ ] Synthetic demo mode and hosted architecture documentation/screenshots.
- [ ] Feedback from corrected classifications, an optional Needs Review digest, or Gmail push notifications instead of polling. These are future features, not existing sending capabilities.
- [ ] Automated image publishing and a manually triggered live smoke test using a throwaway account.

## References

- [Azure for Students](https://azure.microsoft.com/en-us/free/students/) and [Azure pricing calculator](https://azure.microsoft.com/en-us/pricing/calculator/)
- [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google OAuth refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Google restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Azure Container Apps scaling](https://learn.microsoft.com/en-us/azure/container-apps/scale-app)
