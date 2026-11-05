# Allowlisted Google login for the synthetic demo

This describes the earlier allowlisted setup. The owner subsequently made the synthetic demo public through narrowly scoped Caddy routes; see `docs/plan.md` for the live configuration and remaining abuse-control work. The auth proxy remains in place for other routes.

This separate demo has no Gmail client, poller, admin API, Azure model, or persistent message store. Do not connect it to real inboxes or add Gmail scopes. It is not the multi-user product described in `docs/plan.md`.

**Do not expose it yet:** the proxy configuration and a real Google login must be tested end to end, including denied accounts and spoofed headers. This repository does not create Google credentials, authorize testers, provision HTTPS or modify Azure firewall rules automatically.

## Google Cloud

1. In Google Cloud Console, select the project intended to own the demo or create a separate one. Configure its Google Auth Platform consent screen for an external app in Testing mode. Use only `openid`, `email`, and `profile`; do not request Gmail permissions. Add each approved Google account to Google's test users. Testing and verification/domain ownership requirements may change; follow the current console guidance.
2. Create an **OAuth client ID → Web application**. For this VM, use the exact redirect URI:

   `https://postmaster-demo.japaneast.cloudapp.azure.com/oauth2/callback`

   If Google asks for an authorized JavaScript origin, use `https://postmaster-demo.japaneast.cloudapp.azure.com`. If Google rejects the Azure-owned domain or later requires verified ownership, use an appropriately verified domain instead and update `DEMO_HOST` and the redirect URI together. Never paste the client secret into chat or commit it.
3. Google Testing mode's test-user list and the proxy's own email allowlist are separate. Both must include a user. This demo is intended for a few explicitly approved accounts, not arbitrary sign-ups.

## Deployment preparation

Deployment requires the new `src/demo/`, `src/demo-main.ts`, `Dockerfile`, `docker-compose.demo.yml`, and `config/Caddyfile.demo` on the VM; uncommitted local changes are not included in a Git clone. Do not overwrite the existing VM's `.env`, `config/`, `data/`, or `secrets/` while transferring updates. Use a separate deployment directory and review the revision before deploying. The private dashboard can remain on loopback; do not proxy it.

The demo's Compose file uses two private Docker networks, with only Caddy publishing ports 80 and 443. Caddy obtains and renews a certificate; this requires the DNS name to point to the VM and public TCP ports 80 and 443 to reach Caddy. Keep 8080 and 4180 closed externally. The 1 GiB VM may struggle to build or run the additional containers; monitor memory, disk, and cost.

1. Under the new demo deployment directory, create `secrets/demo-oauth.env` readable only by its administrator, containing the Google client ID and secret and an independently generated random cookie secret:

   ```text
   OAUTH2_PROXY_CLIENT_ID=the-client-id.apps.googleusercontent.com
   OAUTH2_PROXY_CLIENT_SECRET=the-client-secret
   OAUTH2_PROXY_COOKIE_SECRET=the-generated-secret
   ```

   Generate the cookie secret on the VM using `python3 -c 'import os,base64; print(base64.urlsafe_b64encode(os.urandom(32)).decode())'`. Protect the secret file (`chmod 600`) and its parent directory (`chmod 700`). Treat anyone with Docker access as a root-equivalent administrator.
2. Create `secrets/demo-allowed-emails` with one approved Google email address per line. The auth container must be able to read this file: keep its parent directory private (`700`) and use file mode `644`, or grant the container's UID explicit read access. Don't configure `--email-domain=*`: email-domain matching can bypass the intended explicit list. On removal, restart the auth container and test that the removed user is denied; cookie sessions otherwise expire after one hour.
3. Set `DEMO_HOST=postmaster-demo.japaneast.cloudapp.azure.com` in the deployment shell. Before opening the firewall, validate the Compose configuration and auth proxy configuration with synthetic credentials. Then create tightly scoped Azure NSG rules for TCP 80 and 443, deploy using `docker compose -p postmaster-demo -f docker-compose.demo.yml up -d --build`, and verify that the certificate is valid. No other demo service should publish a host port.
4. Before sharing the link, test from an external network: unauthenticated requests to `/` and `/api/try` must not reach the demo; approved Google login works; a Google test user not in the proxy allowlist is rejected; a Google account not in Google's test list is rejected; logout works; forged forwarding/authentication headers cannot bypass login; admin and Gmail routes remain inaccessible. Check ports 8080 and 4180 from outside the VM. If any test fails, close 80/443 and investigate. Test account removal and expiry as well.

Only HTTPS protects this sign-in flow. The backend assumes that **only the auth proxy can reach it**, so don't publish its port or add untrusted containers to its internal network. Azure VM admins and Docker administrators can bypass these boundaries. Budget for the VM, public IP, storage, logs and TLS-related traffic. Monitor for abuse and keep the proxy images updated. Revisit rate limiting and resilience before broad public use.
