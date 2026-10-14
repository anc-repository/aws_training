---
section: overview
---

## Background

Your album has a single EC2 instance: every original image flows through Nginx into the Node process and is then written to a 20 GiB data volume, which also holds SQLite, logs and local backups.
When many users upload large images at once, the instance's network card and CPU are saturated by uploads and browsing the timeline slows down too; when the disk fills up, even posting a comment (a SQLite write) fails.
This card hands "storing photos" to Amazon S3: the browser gets a presigned URL and sends the file straight to S3, and EC2 only signs.

:::why
A presigned URL is a URL the app signs with its own credentials for one object key, one operation and one validity period. The browser uses it to PUT directly to S3, and the bytes never pass through the application server;
S3 checks the signature before accepting the object. A presigned PUT cannot limit the file size, so the app verifies the object again with `HeadObject` at "upload complete".
:::

## Comparison experiments

### Burst upload (storage/upload-burst, required)

- **Without S3 (EBS + Node writes to disk)**: 10 concurrent clients keep uploading 5 MB images, and every byte flows through the lab instance's network card and the Node process.
- **With S3**: the same load test, but the browser (the runner) uploads directly to S3 and the lab instance only issues URLs.
- **Where you see it**: in the comparison report, the lab instance's received network bytes (`host.net_rx_bytes`) no longer grow with the upload volume; the p95 of `GET /api/feed` in the same period barely changes;
  the path header changes from `storage=local:write` to `storage=s3:presign`.
- **If the results are not what you expect**: first confirm that storage's driver is s3 at after; then confirm that both load tests used the same parameters (`--param fileMb=5`, `--duration 60s`).
