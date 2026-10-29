# Updates and backups

The install script puts the `gryffi` command on the server. It works on the installation in `/opt/gryffi`; set `GRYFFI_HOME` for another directory.

| Command | |
|---|---|
| `gryffi status` | Containers, version and whether Gryffi answers |
| `gryffi logs [service]` | The last log lines. Add `-f` to keep following |
| `gryffi update [version]` | Back up, then move to the latest release or the version you name |
| `gryffi backup` | Back up the database and the uploaded files |
| `gryffi restore <file>` | Put a backup back. Replaces all current data |
| `gryffi setup-code` | A new link to the setup wizard |
| `gryffi doctor` | Run the checks of the setup wizard again |
| `gryffi start`, `stop`, `restart` | |

## Updates

Admins see a notice in the dashboard when a new release is out. Read the [release notes](https://github.com/lloydstellar/gryffi/releases), then:

```bash
sudo gryffi update
```

The command makes a backup, downloads the `compose.yml` and the images of the new version, and starts them. Gryffi updates its database by itself at start. If the new version does not answer within five minutes, the command goes back to the previous version and shows the last log lines. A slow server can get more time with `GRYFFI_START_TIMEOUT=600`.

## Backups

Every night at 03:17 `gryffi backup` runs by itself and keeps the last 7 backups in `/opt/gryffi/backups`. Change the number with `GRYFFI_BACKUP_KEEP` in `.env`; `0` switches the nightly backup off. A backup contains the database and all uploaded files, in one `.tar.gz`.

A backup on the same server does not help when that server is gone. Copy the backups elsewhere, for example with a nightly `rsync` or your backup tool.

A backup does not contain `.env`. Keep a copy of it in a safe place: `OAUTH_TOKEN_KEY` in that file is needed to read the API keys and passwords stored in a backup.

## Restore

```bash
sudo gryffi restore /opt/gryffi/backups/gryffi-20261029-031700.tar.gz
```

Gryffi stops, the database and uploaded files are replaced by those in the backup, and Gryffi starts again. A backup of an older version works: Gryffi updates the database at start.

## Move to another server

1. On the old server: `sudo gryffi backup`, and copy the backup and `/opt/gryffi/.env`.
2. Point the domain to the new server.
3. On the new server: run the install script with the same domain.
4. In `/opt/gryffi/.env` on the new server, replace the value of `OAUTH_TOKEN_KEY` with the one from the old `.env`, and run `cd /opt/gryffi && sudo docker compose up -d`. Leave the other values as they are: the new database already uses them.
5. `sudo gryffi restore <backup>`.

## Remove Gryffi

```bash
cd /opt/gryffi && sudo docker compose down --volumes
sudo rm -rf /opt/gryffi /usr/local/bin/gryffi /etc/cron.d/gryffi
```

`--volumes` deletes all data, including the database. Make a backup first if you may need it.
