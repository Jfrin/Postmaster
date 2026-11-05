# Beta monitoring

`scripts/beta_monitor.py` is an **offline-tested, uninstalled** probe for the multi-user beta. It emits aggregate issue codes only: container availability, beta data-disk free space, an expired or missing scheduler lease, and recent recorded processing failures. It does not send alerts, identify users, read mail, or restart processing. The single-user `scripts/monitor.py` is not a beta monitor.

On a reviewed deployment, test the probe from a trusted Linux account with read access to the beta database and Docker access (Docker access is root-equivalent):

```sh
python3 scripts/beta_monitor.py --root /path/to/postmaster-beta --container BETA_CONTAINER_NAME --stdout
```

Without `--stdout` it writes JSON to syslog with the `postmaster-beta-monitor` tag. A possible schedule is every five minutes; installation and scheduling are not automatic. The database is opened read-only and the probe does not print subjects or provider errors. `disk_low` means less than 10% free on the data filesystem. Failure codes cover only events recorded in the previous 15 minutes; a generic processing failure does not identify its provider. An intentionally stopped account is not an operational failure. A missing scheduler lease or container may be expected during planned maintenance.

## Alert setup and testing

1. Configure a protected log collection path and Azure Monitor action group with a tested recipient. Verify the actual Syslog records and resource identity before creating a scheduled alert. Alert when `issues` is nonempty, and independently alert when no probe signal is received within 20 minutes. Scope queries to this VM and tag; protect and limit log retention. Monitoring and notifications can incur costs.
2. Test delivery and recovery with synthetic container, scheduler, database, disk and recorded-failure scenarios in an isolated environment. Also test missing-signal alerts. Document acknowledgement and planned-maintenance procedures. An `issues` signal alone does not prove notification delivery.
3. Independently monitor backup creation, off-VM copy, failed uploads and missed schedules; the probe does not check backup success or recovery. Test a restore, not just file freshness. See `docs/beta-backup.md`.
4. Review privacy-preserving detection for Gmail authentication and Azure model failures: current event labels cannot reliably distinguish every provider failure. Processing failures between samples, lost event writes, outages and clock errors can be missed; the probe is not an audit log or complete coverage. Do not ingest raw provider errors or mail into monitoring.

The probe itself is not a Docker healthcheck or a substitute for VM availability, infrastructure, cost, provider-specific and backup alerts. Nothing here configures Azure, changes permissions, or deploys a service.
