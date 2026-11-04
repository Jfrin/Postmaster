# Postmaster plan

## Goal

Run the **real multi-user Gmail beta** on the existing Azure VM, initially for the owner's inbox, while keeping the existing mock demo separate.

The intended flow is **Google sign-in → explicit Gmail consent → admin approval → configure → Start**. Already-approved users skip the approval wait. No mailbox reads or actions occur before approval and an explicit Start. New accounts default to dry run; confirmed live mode must also be available. Stop, denial, expiry and restart prevent new work; requests already in flight may finish.

## Core app and dashboard

Checked items exist in the **single-user app** unless explicitly labeled beta. They do not mean the feature is deployed or verified in the real multi-user beta.

### Gmail processing

- [x] Google OAuth helper, Gmail message fetching, initial inbox lookback and history cursor for later checks.
- [x] Configurable Gmail labels and `label`, `star`, `mark_read` and `archive` actions; optional unread-only category eligibility. No send, draft, delete or unsubscribe actions.
- [x] Dry run, explicit Start/Stop and stopped-by-default restart behavior; requests already in flight may finish after Stop.
- [x] SQLite persistence for decisions, processed-message tracking, sender cache and Gmail cursor; retry and quota/backoff handling.
- [x] Undo tool for recorded actions. It is not a snapshot of the original mailbox and can affect labels, inbox and unread status.
- [ ] Review the existing single-user live configuration before any run: it was observed with `dry_run: false` and a 3,650-day lookback. Choose the intended categories, actions, sensitive-sender rules, backlog, body length and limits without overwriting existing settings blindly.
- [ ] Verify real-inbox Start/Stop, dry-run decisions and persisted cursor/state after restart, then test confirmed live actions. Dry run is available and recommended for review, but the beta must support live use after confirmation.
- [ ] Test expired/revoked grants, reconnect, quota exhaustion, repeated messages and failures between Gmail modification and SQLite writes. Improve recovery without claiming exactly-once processing.
- [ ] Decide whether newsletters/promotions should be archived and which sensitive senders should bypass the model. Verify any Workspace administrator restrictions if using a Workspace account.

### Classification and configuration

- [x] Classify using the first matching rule, an eligible cached sender decision, then Azure OpenAI or the mock classifier.
- [x] Validate structured model output against categories; use a confidence threshold and fallback for uncertain or invalid results. Content-filtered mail gets a separate label without archive or mark-read actions.
- [x] Validated YAML categories, examples, descriptions, rules and settings; configuration reloads for subsequent poll cycles. Settings include label prefix, fallback, threshold, lookback, polling interval, body length and model-call cap.
- [x] Shipped defaults include dry run, a seven-day lookback, 300-second polling and a 1,500-character body limit. Actual live configuration can differ.
- [x] Synthetic evaluation tool and mock classifier; synthetic Azure classification smoke test completed. These do not establish real-world classification accuracy.
- [ ] Evaluate a protected, labeled sample and held-out set; compare candidate models and measure errors, token use and costs before choosing thresholds. Never commit real messages or credentials.
- [ ] Review prompt-injection defenses, sensitive-sender handling, Azure data terms and region before processing real mail. Clearly disclose which metadata and limited body content can be sent to the model.
- [ ] Consider feedback from corrected classifications and an optional Needs Review digest. These are future features, not existing sending capabilities.

### Dashboard

- [x] Single-user local dashboard with Activity, Categories, Rules, Settings and Try it tabs; Start/Stop, status and configuration Save controls.
- [x] Activity displays decisions and updates; category and rule editors support changes, including action choices and rule order. Settings expose dry run, thresholds, lookback and limits.
- [x] Try it previews classification and proposed actions without changing Gmail or saving the message. The single-user dashboard is unauthenticated and must remain on loopback.
- [ ] Bring the useful dashboard-style Activity, Categories, Rules, Settings and Try it experience to the **real beta** with per-user authorization. The current local beta page uses a JSON configuration editor and is not the finished dashboard.
- [ ] Improve onboarding and clear Gmail connection, approval, processing, quota, dry-run/live and error status; provide useful notifications and activity/usage charts.
- [ ] Test dashboard access control, cross-user isolation, configuration validation and live-mode confirmations with real beta sessions and providers before deployment.

### Packaging and operations

- [x] Docker/Compose services for the single-user poller and local-only dashboard, persistent mounts, heartbeat healthcheck and log rotation; operations runbook in `docs/azure-operations.md`.
- [x] Local secrets, data and real evaluation datasets are excluded from Git and Docker build context.
- [ ] Verify encrypted, consistent backups and restores of data, configuration and credentials; document deployment, updates, rollback and recovery for the real beta.
- [ ] Add actionable alerts for failed/stopped processing, Gmail authorization failures, Azure errors and low disk. A heartbeat healthcheck alone is not an alert.
- [ ] Verify Docker startup, disk protection, SSH/network restrictions and model costs; the existing VM and mock demo do not prove these are ready for real Gmail.

## Other completed work

### Testing and project setup

- [x] Added lint, formatting, typechecking, configuration validation, builds, offline tests, coverage, synthetic evaluation and GitHub CI with dependency and secret scanning.
- [x] Ran a synthetic Azure model smoke test and a Gmail profile-only authorization check. Neither is a real multi-user beta end-to-end test.
- [x] A previous committed revision passed GitHub CI. Subsequent local changes are uncommitted and have not been verified by GitHub CI.

### VM demo and Google setup

- [x] The VM runs the **mock demo** at `https://postmaster-demo.japaneast.cloudapp.azure.com` with Google allowlist login. It uses synthetic data, not Gmail. Its dashboard-style tabs are deployed; Start and Save are disabled.
- [x] The system-assigned managed identity is enabled on `Postmaster-VM`, according to the Azure Portal screenshot.
- [x] The owner reports completing Google test-user setup as applicable in both projects and enabling the Gmail API in POSTMASTER. Publishing status and membership have not been independently verified.
- [x] Separate Google sign-in and Gmail web-client files and their callback URLs were checked locally. They have not been tested end to end on the VM.

### Multi-user beta prototype — local only

- [x] The local beta prototype supports sign-in, consent before approval, admin approval/denial, per-user settings, activity, quotas, Start/Stop and confirmation-gated live actions. Pending tokens are encrypted and workers cannot load them without active approval.
- [x] Added per-user workers, scheduler and worker leases, transactional state-write fencing, access expiry and a seven-day expired-token cleanup primitive. Cleanup is not scheduled in production.
- [x] Synthetic tests cover two-user isolation, no processing before approval and Start, quotas, scheduler fencing and simulated live Gmail modifications. The last full local CI passed **212 tests**, lint, formatting, typecheck, config check and build. This is not a real-Google test.
- [x] A local Azure Key Vault adapter using managed identity and a pinned secret version is tested with fake responses. No real vault access or recovery has been tested.

## To do before running real Gmail

- [ ] Fix and test consent races involving disconnect, reconnect and denial/re-request. Decide and implement pending/denied token retention and handling of abandoned Google grants.
- [ ] Fix the retention race where an expired approval moved back to pending retains an old expiry that could cause cleanup to delete a newly saved token. Preserve encrypted connections for **seven days after approval expiry** for reapproval.
- [ ] Finish the beta's VM startup entry point, initial-admin bootstrap, deployment configuration and proxy routing. Proposed path: `/beta` on the existing HTTPS hostname. Do not replace the mock demo or expose the legacy unauthenticated dashboard.
- [ ] Verify the VM's managed identity from the VM. Two SSH attempts after it was enabled timed out; do not print the resulting token.
- [ ] Configure a Key Vault, least-privilege access, protected persistent data, scheduled retention, backups, key recovery and tested restore. The current cleanup only deletes the live token record; it does not revoke Google grants or delete backups.
- [ ] Resolve clock rollback, scheduler/failure recovery, rate limiting and concurrent revocation risks. Gmail actions and SQLite writes are not atomic; do not promise exactly-once processing.
- [ ] Review Google restricted-scope requirements, privacy/consent, prompt-injection protection and Azure model data handling. Gmail `gmail.modify` is restricted; Testing or personal-use verification exceptions do not remove security or policy obligations.
- [ ] Confirm cost and budget alerts for VM, storage, Key Vault and Azure model usage. The application limit is not an Azure spending cap.
- [ ] Test real Google sign-in, Gmail consent, approval, configuration, Start/Stop, quotas, isolation, reconnect and confirmed live actions on the VM. Only connect the owner's inbox after the security and policy checks above.

## What the owner needs to do

- [x] Enable the VM's system-assigned managed identity.
- [x] Complete Google test-user setup as applicable and enable the Gmail API.
- [ ] Review and approve the actual Azure Key Vault and storage costs when the configuration is ready.
- [ ] Once the beta is ready, sign in, grant Gmail consent, approve the account, configure it and press Start. Connecting, approving, deploying or restarting must not start processing automatically.

## Beta requirements

- Default to **100 Gmail message-read attempts per user per UTC day**, including retries; admins can change each user's limit and approval expiry.
- Keep each user's tokens, settings, activity, cursors, quotas and processing isolated. An admin can approve or deny users and view usage.
- Support labels, starring, mark-read and archive according to configuration. The app does not send, draft, delete or unsubscribe from email.
- The classifier may send sender, subject, date, unsubscribe-header presence and a limited cleaned body to Azure OpenAI; it does not send attachments. Review provider terms and disclose this before real consent.
- Keep dry run available, require confirmation for live settings and live Start, and begin stopped after restart. Existing single-user settings were observed with live mode and a long lookback; review them before any single-user run.
- Gmail Testing-mode refresh tokens may expire after seven days. Provide reconnection handling and do not switch to production merely to bypass expiry.

## Deployment notes

- VM: `azureuser@20.78.9.240`; SSH key: `secrets/Postmaster-VM_key.pem`. Build images locally, not on the 1 GiB VM.
- The VM's `~/postmaster-demo/docker-compose.demo.yml` was modified to fix a Docker network collision. **Do not overwrite or reset it.** Updating image `postmaster-demo-demo` updates only the synthetic demo.
- Identity web client: `secrets/google-sign-in-client-secret.json`, callback `/auth/google/callback`. Gmail web client: `secrets/google-client-secret-gmail-web.json`, callback `/auth/google/gmail/callback`. The older `secrets/credentials.json` is a separate desktop client.
- Never print, paste, commit or bake secrets, tokens, vault keys or real email into images. Keep the Gmail client JSON, databases and backups protected.
- Beta runtime, Key Vault adapter and deployment-related changes are local and **uncommitted**. Run `git status` before working; do not discard other changes. `docs/image.png` was already deleted in the working tree before the demo update.
- The beta prototype is in `src/beta/`; `src/beta/runtime.ts` is local integration wiring, not a production entry point. Tests use fake providers, not real Gmail. The legacy single-user dashboard has no login and must remain on loopback.

## Other improvements

### Quality and reliability

- [ ] Evaluate classification accuracy and model cost using appropriately protected, labeled samples; compare models and tune categories, rules and confidence thresholds. Never commit real email.
- [ ] Improve observability: alerts for processing failures, expired Google grants, Azure errors, low disk and unhealthy services; add cost monitoring and operational dashboards.
- [ ] Test backups, restoration, migrations, restarts, partial failures and rollback procedures. Improve deletion of user data from logs and backups and document recovery limits.
- [ ] Review SSH/network restrictions, branch protection, dependency updates and automated release/deployment processes.

### User experience and portfolio

- [ ] Improve beta onboarding, configuration editing, connection status, error messages, activity charts and usage displays.
- [ ] Add architecture documentation and screenshots; consider notifications, feedback on classifications, a review digest or Gmail push notifications.
- [ ] Consider automated image publishing and a manually triggered smoke test using a throwaway account.

### Wider release, only if desired

- [ ] Before public access, complete applicable Google verification and any required security assessment; publish privacy information and terms and prepare support and incident response.
- [ ] Reassess capacity, storage, scheduling, costs and abuse controls before expanding beyond a small allowlisted beta. Managed databases or queues are options, not current requirements.

## References

- [Google Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Google Workspace API policy](https://developers.google.com/workspace/gmail/api/policy)
- [Azure pricing calculator](https://azure.microsoft.com/en-us/pricing/calculator/)
