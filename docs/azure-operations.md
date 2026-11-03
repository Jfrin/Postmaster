# Private Azure VM operations

This is a **single-account, private VM** runbook, not a multi-user deployment. The VM, alert delivery, backup storage, and recovery test must be set up after provisioning. Do not expose the dashboard or the OAuth helper to the internet.

## Prepare the VM

1. Install Docker Engine, the Compose plugin, Python 3.9+, `age`, cron, and a syslog service on the Linux VM. Enable Docker, cron, and syslog at boot. Choose a persistent, encrypted disk and ensure the deployment directory resides on it. Restrict SSH in the Azure network security group to trusted sources, use SSH keys, and verify the host key before connecting. Do not open ports 8080 or 3000. Docker port publishing can bypass some host firewall rules; check the Azure rules and actual bindings too.
2. Clone the intended, reviewed revision into a private deployment directory, here called `/opt/postmaster`. Transfer `.env`, `config/categories.yaml`, `secrets/credentials.json`, and `secrets/token.json` over verified SSH/SFTP, not Git, an image, or chat. Run Gmail authorization on your own machine as described in the README, and transfer its token; do not publish the Compose `auth` service on the VM. Never overwrite an existing `data/` or token with stale local files during an update.
3. Set ownership and permissions for the image's non-root UID 1000. For example, as root, create `data/` and `secrets/`, set `config/`, `data/`, and `secrets/` ownership to `1000:1000`, directories to `700` and files to `600`; protect `.env` as `600` and grant the operator access as needed. Keep the repository and deployment host accessible only to trusted administrators. Protect backups, disk snapshots, logs, and the VM's SSH access too. Docker group membership grants root-equivalent access.
4. From the deployment directory run `docker compose up -d --build`. The bind mounts preserve configuration, tokens, and SQLite when containers are replaced; VM disk loss still requires an off-VM backup. Check `docker compose ps` and `docker compose logs --tail=100` without sharing sensitive log content. The poller starts **stopped** on every restart.
5. From your own computer, connect using `ssh -L 8080:127.0.0.1:8080 USER@VM_HOST`, then visit `http://localhost:8080`. Compose binds the unauthenticated UI to VM loopback; don't change it to `0.0.0.0` or expose a proxy. First run in dry run, inspect decisions, then choose whether to enable live actions. Test Start and Stop. The cap limits app model calls, not the Azure bill.

## Encrypted backups and recovery

The backup script captures `.env`, `config/`, `secrets/`, and a SQLite online snapshot of `data/state.db`, including committed WAL data. It omits transient control/status/heartbeat files. SQLite is consistent, but configuration and token files are not an atomic snapshot with the database: avoid editing settings or reauthorizing during backup. Its SQLite snapshot is briefly stored **unencrypted** in a private temporary directory on the VM; use encrypted VM storage and restrict host access. Backups contain Gmail access and mail metadata even when encrypted.

1. On a separate trusted recovery machine, install `age` and generate a key: `age-keygen -o postmaster-recovery-key.txt`. Store the private key securely **off the VM**, backed up separately. Obtain its public recipient using `age-keygen -y postmaster-recovery-key.txt`. Losing the private key means losing the backups. Anyone with the public recipient can create an encrypted archive, so `age` encryption alone does not prove who created it; protect the backup storage and its provenance.
2. On the VM, after the app has created `data/state.db`, create an encrypted backup outside the application directory (replace the recipient and filename):

   ```bash
   cd /opt/postmaster
   sudo python3 scripts/backup.py backup --root /opt/postmaster --recipient 'age1PUBLIC_RECIPIENT' --output /secure-backups/postmaster-2026-11-03.age
   ```

   Create `/secure-backups` beforehand with restricted permissions and enough disk space. The script refuses to overwrite an existing file. Schedule backups at the interval your recovery objective requires, use unique filenames, and monitor backup failures and free space; scheduling is not installed automatically.
3. Copy the encrypted file off the VM to access-controlled, private storage, such as an Azure Storage container with public access disabled and least-privilege authorization. Confirm the upload and set a retention/deletion policy. A copy on the VM or its disk alone is not disaster recovery. Account for storage, logging, and backup costs.
4. Regularly restore a **copy** on the trusted recovery machine into a directory that does not already exist:

   ```bash
   python3 scripts/backup.py restore --archive /path/to/postmaster.age --identity /secure/postmaster-recovery-key.txt --destination /secure/postmaster-restore-test
   ```

   The script rejects unsafe paths and validates SQLite integrity. Check the recovered config, token and expected decisions, and test the app in an isolated environment without connecting it to the real inbox. This is a sensitive plaintext restore: protect it and remove it according to your retention policy. A successful integrity check alone is not a full recovery test.
5. For actual recovery, stop both containers, retain the existing deployment and data for rollback, restore to a new private directory, and verify it. Install the restored files into a **new** deployment directory alongside the reviewed application revision; set the ownership and permissions described above. Bring up Compose there, verify it starts stopped, then connect privately and explicitly choose when to resume. Never extract over a live database. Reauthorization or Azure key rotation may be needed if credentials have expired or been revoked.

## Monitoring and Azure alerts

The repository does **not** create Azure resources, monitoring rules, notification recipients, or a backup schedule. After provisioning:

1. Configure an Azure Monitor action group with a tested notification recipient. Install Azure Monitor Agent on the VM, connect it to a Log Analytics workspace with a data collection rule collecting Linux Syslog `user` facility at `notice` severity, and confirm records arrive in the `Syslog` table. Limit workspace access and retention. VM monitoring, log ingestion, and alert rules may incur costs.
2. Run the health check as a trusted account with Docker access and read access to `data/`. For example, install a **root** cron entry (adjust the path):

   ```cron
   */5 * * * * cd /opt/postmaster && /usr/bin/python3 scripts/monitor.py --root /opt/postmaster
   ```

   It sends JSON to syslog tagged `postmaster-monitor`; it contains issue codes, not email, tokens, or raw errors. Run `sudo python3 scripts/monitor.py --root /opt/postmaster --stdout` to inspect it. It reports unavailable/unhealthy containers, stale or missing heartbeat, stopped processing, cycle errors, failed messages, and less than 10% free space on the `data/` filesystem. `processing_stopped` is also reported after an intentional Stop or restart; suppress or acknowledge that alert during planned pauses, without disabling other alerts.
3. Create a scheduled log alert scoped to the workspace, filtered to this VM's Azure resource ID, using the following query. Alert when **FailureCount > 0**, evaluating every 5 minutes over 10 minutes, and attach the action group. Replace the resource ID; use the actual `Computer` or resource identity observed in your records if your DCR maps it differently.

   ```kusto
   Syslog
   | where _ResourceId =~ '/subscriptions/SUBSCRIPTION/resourceGroups/GROUP/providers/Microsoft.Compute/virtualMachines/VM'
   | where ProcessName == 'postmaster-monitor'
   | extend health = parse_json(SyslogMessage)
   | where array_length(health.issues) > 0
   | summarize FailureCount = count()
   ```

4. Create a separate missing-signal alert: count the same VM/tag records in a 20-minute window and alert when the count is **0**. Test the rule with no records; absence can mean VM failure, cron/syslog/agent failure, or ingestion trouble. Also enable Azure VM availability monitoring. The script samples status, so a short-lived Gmail/Azure failure can occur between checks; `message_failures` and `cycle_error` do not identify the provider, and successful later cycles can clear the evidence. For complete Gmail authorization/Azure error alerting, configure and test privacy-reviewed application-log collection and corresponding alerts. Do not blindly ingest logs containing sender, subject, message IDs, or credentials.
5. Test each alert and delivery using synthetic failures and a planned maintenance window. Check low-disk, stopped/unhealthy processing, missing signal, Gmail authorization errors, Azure errors, and backup failures. The existing Docker healthcheck by itself sends no notification. Confirm the action group and queries actually fire before relying on them.

## Updates, rollback, and stopping

- Before an update, create and verify an off-VM backup, note the current Git revision and image, and check release/config compatibility. Use a reviewed revision, then run `docker compose up -d --build`. Recheck logs and private access; processing remains stopped until Start is pressed.
- For rollback, stop the containers and use the previously reviewed revision/image. If a database migration or corrupted state makes that unsafe, restore the verified backup into a new deployment as above. A database rollback can cause mail already modified after the backup to be revisited; inspect and reconcile before restarting. Gmail actions and SQLite commits are not atomic, so exactly-once processing is not guaranteed.
- Use Stop in the dashboard and wait for in-flight work before maintenance. `docker compose stop` stops the containers; `docker compose up -d` restarts them stopped. Do not use volume deletion or delete the persistent disk as a routine update.
