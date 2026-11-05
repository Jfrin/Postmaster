# Controlled beta verification

The owner reports completing real-account testing; the specific scenarios covered were not provided. Use these checks if additional coverage is needed, with the owner and consenting users with two controlled Google accounts. Do not use real mail content in reports, logs or test fixtures. Do not change existing applications or accounts to create the test; obtain approval for controlled setup and any later cleanup. Google Testing-mode access may be needed in both projects.

## Browser and account isolation

1. With separate browser profiles, sign in as each controlled user and confirm their verified account, approval, separate Gmail consent, configuration and stopped state. Also check an unauthenticated session and a signed-in non-admin cannot access admin pages or APIs.
2. Create distinct, harmless configuration markers in each test account. Verify each sees only its own settings, activity and usage; requests that supply the other account's subject must not select or modify that account. Check rejected invalid configuration and CSRF requests. Do not share session cookies or tokens.
3. Check dry-run defaults and the Gmail connection, approval, quota, processing and error indicators. Verify saving live settings and starting live mode each require separate confirmation; cancel both prompts without saving or starting live mode. Restore test settings only with the account owner's permission.

## Gmail and failure handling

1. Only after the owner explicitly authorizes Start, use a controlled mailbox containing synthetic messages and start in dry run. Verify progress, quota, decisions, backlog completion and Stop; allow in-flight work to finish. Dry run can still send limited mail content to Azure.
2. Separately obtain authorization before testing live Gmail changes, disconnection or revocation. Record only the test outcome and aggregate counts, not mail, OAuth codes, tokens or provider error text. Confirm expected mailbox state directly and reconcile any changes.
3. Test expired/revoked grants, provider failures and notifications only with controlled credentials and a planned recovery. Verify actual operator inbox receipt separately from a successful API response. Never revoke or delete another user's account to exercise a failure path.

Record which checks passed, failed or could not be performed, with date and environment. Synthetic integration tests do not replace these checks, and no test implies readiness for wider release.
