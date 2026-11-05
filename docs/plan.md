# Postmaster plan

## Current state

- The closed beta and synthetic demo run at `https://postmaster-demo.japaneast.cloudapp.azure.com/` using `postmaster-beta:ui-refresh-20261105`. The demo uses no Gmail or Azure model. The owner accepted the remaining security and recovery risks for approved beta users; this is not a public-release readiness decision.
- Sign-in, Gmail consent, approval, configuration and explicit Start are separate. New settings default to dry run and a 365-day lookback; live settings and Start require confirmation. Processing stops on restart, denial or expiry, although in-flight requests may finish. The default limit is 100 Gmail message-read attempts per user per UTC day, including retries.
- Identity sign-in uses Google project `postmaster-sign-in`; Gmail consent uses `postmaster-513311`. Testing-mode users may need enrollment in both projects; Postmaster applications do not manage Google's test-user lists. Submitted application addresses are not inbox-verified. Denial has a 24-hour reapplication cooldown; deleting an application or testing access is not denial and permits immediate reapplication.
- Data deletion stops processing but retains the account, approval, session and Gmail grant. Account deletion attempts Gmail revocation, removes the account and signs out; if revocation fails, the account remains for retry. Without a local token, revocation cannot be confirmed and the user must check Google directly. Sign-in authorization is separate.
- Sender and subject display data expires after 24 hours and is cleaned hourly while online. Decision and sender-cache identifiers are per-user keyed hashes; identifiers and categories can still be sensitive. Deletion does not erase existing backups, journals, logs or provider-held data, undo Gmail actions, or recall in-flight work and notices. Minimal safety records and current-day quota counters remain temporarily.
- Last checked on 2026-11-05: no accounts processing, three approved applications, 377 decisions, 69 cache entries and an empty notification outbox. These counts can change. Beta sign-in and synthetic classification returned 200; unauthenticated admin returned 401. The deployment check did not delete any real account.
- The dashboard keeps Stop available when processing is requested but Gmail or the poller is unavailable. The local changes passed 309 tests, lint, typecheck, build and changed-code formatting. Full CI previously stopped on an existing README formatting issue. Authenticated deletion, real Google revocation and scheduled cleanup are not independently verified.
- The owner reports completing real-account testing and testing an alert; the precise scenarios and alert type have not been independently verified. Azure monitoring is deferred at the owner's request. `scripts/beta_monitor.py` is local and not installed; see `docs/beta-monitoring.md`.

## Priorities

### Privacy and backups

- [ ] Implement and test per-user backup isolation, deletion propagation, crash-safe fencing and recovery without resurrecting deleted data. See `docs/beta-per-user-backup-design.md`.
- [ ] Decide retention and recovery for historical shared backups. They cannot selectively erase one user; do not destroy them without a separate decision or claim backup erasure is implemented.
- [ ] Review deletion races and provide restricted, identity-verified deletion or operator handling for people unable to sign in. Verify authenticated deletion and Google revocation with controlled accounts.
- [ ] Verify scheduled content and token cleanup, revocation and crash recovery. Token cleanup does not revoke Google grants or erase backups or journals. See `docs/beta-revocation-recovery.md`.

### Security and operations

- [ ] Isolate VM managed identity and Key Vault access; the VM, not an individual container, is the current identity boundary. Protect SQLite, WAL, logs, temporary files and backups.
- [ ] Complete least-privilege storage access, automated encrypted off-VM backups, real-data restore and pinned Key Vault recovery. See `docs/beta-backup.md`. Prior isolated restores do not establish full disaster or Key Vault recovery.
- [ ] Review scheduler and lease recovery, clock rollback, rate limits and Gmail request fencing. Gmail actions and SQLite writes are not atomic; do not promise exactly-once processing.
- [ ] Review disk, network, dependencies and public demo abuse controls.

### Verification and release

- [x] Real-account testing and an alert test, as reported by the owner; detailed test coverage and alert type were not specified.
- [ ] Confirm any remaining coverage of authenticated admin and applicant journeys, deletion and application-alert inbox receipt as needed. See `docs/beta-verification.md`.
- [ ] Review Google branding, restricted-scope verification, security assessment requirements, Limited Use and applicable law; published privacy and terms do not establish compliance. Testing refresh tokens can expire after seven days.
- [ ] Evaluate classification accuracy, sensitive-sender handling, prompt injection, Azure data handling and costs with protected examples. Gmail classification may send sender, subject, date, unsubscribe-header presence and limited cleaned body text to Azure OpenAI Global Standard, including in dry run; attachments are not sent to the model.
- [ ] Reassess security, recovery, abuse controls, capacity and support before broader access.

### Deferred

- [ ] Azure monitoring and operational, missing-signal, backup-failure and cost alerts. The local beta monitoring probe is not alert delivery and does not cover backups or all provider failures.

## Deployment and recovery

- Build images locally, not on the small VM. Before any future deployment or restart, recheck live state, create and verify a fresh backup, and obtain owner approval. A restart stops processing; users must explicitly Start again.
- Earlier dashboard-stop predeployment archives: `secrets/beta-recovery/beta-dashboard-stop-predeploy-20261105.age` and `secrets/beta-recovery/beta-dashboard-stop-extras-20261105.age`; VM copies are in `~/postmaster-beta-backup-dashboard-stop-20261105/`. Checksums matched, isolated database restore and integrity passed, and the extras manifest was verified. Preserve earlier recovery copies as well. Only beta and demo were recreated; processing remained stopped and the application digest was unchanged.
- UI refresh predeployment archives: `secrets/beta-recovery/beta-ui-refresh-predeploy-20261105.age` and `secrets/beta-recovery/beta-ui-refresh-extras-20261105.age`; VM copies are in `~/postmaster-beta-ui-refresh-backup-20261105/`. Checksums matched, isolated restore passed, and the extras manifest was verified. Beta and demo were recreated; processing remained stopped, public pages and synthetic classification returned 200, and unauthenticated admin returned 401. Authenticated flows were not tested against the live service.
- Read-only VM checks on 2026-11-05 found Docker enabled at boot, beta and demo running with `unless-stopped` restart policies, and the beta data filesystem 15% used. Effective SSH defaults showed public-key authentication enabled and password authentication disabled. These observations do not test an actual reboot, Azure network rules, all SSH Match rules, disk isolation or model costs.
- Privacy migration depends on the pinned vault key; a different key fails closed. Do not run an old beta image against the migrated database. For rollback, stop beta instances, preserve current data and reconcile post-snapshot changes, deleted data, credentials and processing state before choosing a recovery path.
- Do not overwrite the independently modified `~/postmaster-demo/docker-compose.demo.yml`. When recreating the demo or proxy, include the existing Compose files and these overrides in order: `docker-compose.public-demo-20261105.yml`, `docker-compose.public-preview-20261105.yml`, `docker-compose.admin-pages-20261105.yml`, `docker-compose.beta-parity-20261105.yml`, `docker-compose.privacy-20261105.yml`, `docker-compose.account-delete-20261105.yml`, `docker-compose.dashboard-stop-20261105.yml`, `docker-compose.ui-refresh-20261105.yml` (all under `~/postmaster-demo/`).
- The VM's notification credential is mounted read-only through `~/postmaster-beta/docker-compose.notifications-20261105.yml`. Never print or expose credentials, tokens, vault keys or real mail.

## Working constraints

- Do not commit, push, modify `.github/`, or change GitHub settings. Preserve unrelated user changes.
- Keep the unauthenticated local dashboard on loopback. Review existing single-user settings before running; they may use live mode and a longer lookback.
- Served legal pages are `src/beta/privacy-page.ts` and `src/beta/terms-page.ts`. Operational procedures are in `docs/azure-operations.md`, `docs/beta-backup.md` and `docs/beta-revocation-recovery.md`.
