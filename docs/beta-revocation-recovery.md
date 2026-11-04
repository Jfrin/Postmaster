# Beta Gmail revocation recovery

This is an **offline operator procedure**, not an HTTP endpoint or an automatic retry. Use it only when a disconnect is stuck after a crash or failed revocation. Prefer the user's normal Disconnect retry when the service is operating. Neither local cleanup nor this procedure removes encrypted backups or SQLite journal copies.

1. Stop **every** beta server and scheduler, and confirm they are stopped. Wait for already-started requests to settle. Do not stop or alter the separate mock demo. A stale network request might already have reached Google; if its outcome is uncertain, do not assume it was cancelled.
2. Have the affected user revoke the **Gmail** grant for the beta's Gmail OAuth project from their Google Account's third-party connections. Check that it was actually removed; identity-only sign-in is a separate grant. Do not proceed solely because a local token is disabled.
3. Verify the VM clock is synchronized, wait at least 30 seconds after stopping all instances for scheduler leases to expire, and use a reviewed image that contains `dist/beta-revocation-recovery-main.js`. From the beta deployment directory, substitute the affected user's **verified Google subject** and the reviewed image tag:

   ```bash
   sudo docker run --rm --network none --read-only \
     -v "$PWD/data:/srv/data" -e BETA_DATABASE_PATH=/srv/data/beta.db \
     --entrypoint node 'postmaster-beta:REVIEWED_TAG' \
     dist/beta-revocation-recovery-main.js 'VERIFIED_GOOGLE_SUBJECT' GOOGLE_GRANT_REVOKED
   ```

   The confirmation is an operator assertion, not a Google API check. The command rejects a live scheduler lease, missing revocation fence, or enabled replacement token, and atomically stops the user, invalidates older callbacks, deletes the local token and records an audit event. An expired scheduler lease **does not prove** all HTTP handlers or Google requests have stopped; step 1 is mandatory. Never use this command to bypass an active or uncertain revocation.
4. Restart only the reviewed beta deployment. It starts with processing stopped. The user can reconnect, reconfigure and explicitly Start after checking access and any uncertainty about the earlier request. Restore/backups may contain old token records and need their own deletion policy.

This procedure cannot undo Gmail operations already in flight or guarantee exactly-once processing. If the Google grant cannot be confirmed revoked, keep the connection blocked and investigate rather than clearing the fence.
