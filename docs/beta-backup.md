# Beta backup and restore

The beta backup tool is separate from the single-account backup. It creates an SQLite online snapshot (including committed WAL transactions) and encrypts it with `age`. The archive includes the database, beta Compose file, OAuth clients, admin subject and model configuration. It does **not** include the Key Vault secret itself, the Caddy configuration, an application image, or a copy off the VM. Backups contain sensitive credentials and mail metadata even when encrypted.

## Before using real mail

- On a separate trusted recovery machine, install `age`, generate a recovery identity with `age-keygen -o beta-recovery-key.txt`, and securely keep that private file **off the VM**, with a separate backup. Get its public recipient with `age-keygen -y beta-recovery-key.txt`. Do not paste the private key into chat, Git, or the VM. Losing it makes the archive unrecoverable.
- Protect and test recovery of the pinned Key Vault key version separately. An archive alone cannot decrypt stored Gmail tokens if that key is lost. Restore the same key version or follow a separately verified key-recovery procedure.
- Azure Key Vault's secret backup is an encrypted blob that can be restored only within the same Azure subscription and geography; it is not a standalone copy of the key. Restrict backup/restore access and test the pinned version and decryption using a separate vault and synthetic data before relying on recovery. Restored copies are independent and need their own access controls. See https://learn.microsoft.com/en-us/azure/key-vault/general/backup.
- Arrange private, access-controlled **off-VM** storage, a schedule, monitoring, retention and deletion of backups, and review costs. A local archive is not disaster recovery. Restoring an old snapshot may reintroduce removed tokens and older processing state.
- Confirm the VM storage is protected. The SQLite snapshot is briefly plaintext in Python's private temporary directory; set `TMPDIR` to a protected encrypted location or a sufficiently large private tmpfs. The final archive is encrypted. Do not edit configuration or reauthorize while a snapshot is taken; the file and database snapshots are not one atomic transaction.

## Create an encrypted backup

After the beta has created `data/beta.db`, from the deployment directory run the reviewed copy of `scripts/beta_backup.py` and its sibling `scripts/backup.py` (the current VM staging copies are under `~/postmaster-beta/backup-tools`). Replace the public recipient and destination:

```bash
python3 ~/postmaster-beta/backup-tools/beta_backup.py backup \
  --root ~/postmaster-beta --recipient 'age1PUBLIC_RECIPIENT' \
  --output /secure-backups/beta-UNIQUE-NAME.age
```

The output must be outside the deployment directory; the command refuses to overwrite existing files. It supports a database snapshot up to 1 GiB and individual configuration inputs up to 1 MiB. Copy the encrypted archive to private off-VM storage and verify the copy. `age` encryption to a public recipient does not establish archive provenance; restrict who can write backup storage.

## Upload prototype — not enabled

`scripts/beta_backup_upload.py` is an un-deployed prototype for sending an `age` archive to a private Azure blob container with the VM managed identity. It sends a transport checksum and refuses to overwrite an existing blob. Synthetic offline tests do not verify Azure permissions, network rules, or actual provider behavior. A successful HTTP response is not a restore test; verify the stored copy independently. If an upload times out, its outcome can be unknown: inspect the destination before retrying rather than overwriting it.

Do **not** schedule or grant the VM storage permissions until its managed identity is isolated from unrelated workloads and the role scope, backup deletion/retention and recovery process are reviewed. A shared VM identity may be usable by other containers; a broad blob role could let them read, modify or delete backups. The helper does not configure storage, grant roles, schedule jobs, monitor failures or remove old backups.

## Restore a copy

On the trusted recovery machine, with the recovery identity available and Python 3, `age`, and both backup scripts installed, restore to a path that does not already exist:

```bash
python3 scripts/beta_backup.py restore --archive /secure-backups/beta-UNIQUE-NAME.age \
  --identity /secure/beta-recovery-key.txt --destination /secure/beta-restore-test
```

The tool checks allowed archive paths and SQLite integrity, and restores sensitive **plaintext** files to a new private directory. It never starts the service. Check ownership and file permissions and test a restore in isolation with fake providers. Test Key Vault key recovery separately. For a real restoration, stop all beta instances, retain existing data for rollback, and restore into a new deployment; verify the correct reviewed image, proxy configuration, key version, credentials and retention state before starting. The backed-up Compose file may name an old image. Processing must remain stopped until the user explicitly starts it. Reconcile any Gmail actions performed after the snapshot; Gmail operations and database writes are not atomic.

Synthetic backup and restore checks can be run with `python3 -m unittest discover -s test -p '*_test.py'` when `age` and `age-keygen` are installed. They are not a substitute for testing the actual recovery key and off-VM storage.
