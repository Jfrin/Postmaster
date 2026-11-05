# Beta application email notifications

This feature is optional and requires the reviewed code, a separate sender grant and a private credential mount. The current beta has notifications enabled; the owner confirmed controlled approval and denial emails arrived. Application-alert inbox receipt still needs explicit confirmation.

## Authorization

1. In the existing Gmail project **`postmaster-513311`**, create a separate OAuth **Desktop app** client for the operator's notifications. Confirm the Gmail API is enabled and configure the project's consent screen and test users as required. Review Google's current requirements for `gmail.send` and how adding this scope affects the project's verification; Testing-mode refresh tokens can expire after seven days. Do not add the send scope to the applicant's Gmail consent or reuse their token. Identity sign-in remains in its separate project.
2. Build the reviewed beta runtime image **locally** and transfer it to the VM using the established image-transfer procedure; do not build on the small VM or replace running containers yet. Privately transfer the downloaded desktop client JSON to a new, restricted directory on the VM, outside the repository and image. The runtime container's UID 1000 needs read access to the client and write access to the directory. Do not overwrite existing secrets; the output filename `notification-sender.json` must not already exist. Treat the JSON and resulting credential as sensitive.
3. From the operator's computer, open a trusted SSH session to the VM with a local-only tunnel, for example:

   ```bash
   ssh -L 127.0.0.1:3001:127.0.0.1:3001 azureuser@postmaster-demo.japaneast.cloudapp.azure.com
   ```

   Check that port 3001 is free on both machines. In that SSH session, set `NOTIFICATION_AUTH_DIR` to the absolute path of the private directory, and `BETA_IMAGE` to the locally built and transferred image. Run this one-off helper, using the actual client filename instead of `desktop-client.json`:

   ```bash
   docker run --rm -it -p 127.0.0.1:3001:3001 \
     --mount "type=bind,src=${NOTIFICATION_AUTH_DIR},dst=/private" \
     -e NOTIFICATION_AUTH_BIND=0.0.0.0 \
     -e NOTIFICATION_CLIENT_PATH=/private/desktop-client.json \
     -e NOTIFICATION_CREDENTIAL_PATH=/private/notification-sender.json \
     --entrypoint node "$BETA_IMAGE" dist/notification-auth-main.js
   ```

   Open the printed authorization URL **on the operator's computer**, sign in as **joseofrin@gmail.com**, and let the browser return to `127.0.0.1:3001` through the SSH tunnel. The helper requests `openid`, email and Gmail send-only permissions, verifies the returned account and writes the credential on the VM. It refuses to overwrite an existing file. The helper exits after the callback; close the tunnel afterwards. Do not paste the authorization URL, client secret, callback URL, refresh token or credential file into chat, logs or Git.

   The helper listens on its container interface, but Docker publishes its port on the VM's loopback only; the SSH tunnel also binds only to the operator's loopback. Do not expose port 3001 publicly. Other VM containers or Docker administrators may still reach it. Verify the actual binding and VM security boundary.

4. Keep the resulting file private, outside the image, and make it readable by the beta container's non-root UID. Place it at the intended mount path without overwriting existing secrets. VM administrators and workloads with access to the file can use the grant. Review isolation, backups and Google verification before relying on it.

## Enabling and operating

The optional `config/docker-compose.beta-notifications.example.yml` illustrates a read-only credential mount and `BETA_NOTIFICATION_CREDENTIAL_PATH`. Resolve paths relative to the first Compose file; adapt it to the existing beta deployment without overwriting live Compose files or secrets. The configured beta administrator email must match the authorized sender. Build and review the image locally. Before a deployment or restart, check actual processing state and preserve data; restarting beta stops processing and users must explicitly Start again. Do not restart the separate demo.

After enabling, a new application queues an alert to the operator; a changed application decision queues a notice to the submitted address. Duplicate applications and unchanged decisions do not trigger another email. Previously submitted applications are not automatically backfilled. Application addresses are not verified by the form. Google Testing mode may still require separately enrolling approved users in both sign-in and Gmail projects.

Inbox verification was removed from the live form at the owner's request. New applications do not require a code. The deployed worker does not send old verification messages and removes expired verification records during queue processing; backups may retain them. Denied applicants can reapply after 24 hours for a new review; legacy denials start that cooldown at migration. Inbox control is not checked by the application form. Google sign-in remains separate. Public submissions are globally rate-limited but can still be abused; the limit is not comprehensive anti-spam protection.

The admin page shows pending and failed delivery counts and lets the administrator retry failures. Sends are retried with backoff up to five attempts, then require manual retry. A send can succeed at Google but appear to fail locally, so duplicates are possible; a decision already in flight cannot be recalled. Superseded queued decisions and expired approvals are discarded. Gmail outages, expired grants and restarts can delay delivery. Check the queue and test with addresses you control; do not assume delivery from approval alone. Failed records contain applicant addresses in the beta database and are subject to its existing retention and backup limitations.

To disable future notifications, remove the override and restart only during an authorized maintenance window. Queued records are retained; disabling does not revoke the Google grant. Revoke the notification grant in the operator's Google account if no longer needed and securely handle all copies of the credential. Revocation does not erase backups.
