# Proto Hub

Dashboard for the proto automation system.

## Structure

- `hub/` — static HTML frontend served by nginx at https://proto.smartlaunchhub.com/
  - Deployed to `/var/www/proto/` on server `95.217.84.161`
- `hub-api/` — Express + Postgres API for runs counter, cron triggers, OH logs
  - PM2 process `proto-hub-api` on port 3901
  - Deployed to `/var/www/proto-hub-api/` on server `95.217.84.161`

## Related

- `serter2069/proto-viewer` — per-project prototype viewer (separate)
- `proto-smart-cron` + `oh-watcher` on server — automation cron jobs
