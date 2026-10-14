---
section: overview
---

## Background

CloudAlbum's L0 is a single EC2 instance: Nginx, api, worker, SQLite and the uploaded files all live on it, and the app loads no AWS SDK and calls no AWS API.
Its biggest difference from a traditional single-server deployment is that data, secrets and local configuration all sit on a **separate data volume** (`/etc/cloudalbum → /var/lib/cloudalbum/etc`),
so the root volume can be rebuilt at any time. But it is still a single point of failure — stop the instance and the whole site goes down.

:::why
This card has no "enable a module" step: ec2 is the base module. Your job is to see L0 clearly — what disappears with the instance, what does not,
and where the security baseline is — because every later card replaces one part of it.
:::

## Comparison experiments

ec2 has no with/without comparison experiment: this card verifies L0's properties by putting the traditional single-server approach next to L0's.

- **Public address**: without an EIP, the public IPv4 changes after a stop and start; L0 uses an EIP, so the address stays the same (you test it in step 5).
- **Where data and secrets live**: on the root volume, rebuilding the instance loses data and regenerates keys; L0 keeps them on a separate data volume (inspected in step 3).
- **Instance metadata**: with IMDSv1 any GET request can read the metadata; L0 enforces IMDSv2, and requests without a token get 401 (step 4).
- **Single point of failure**: stopping the instance means the whole site is down — L0 is a single point of failure too, which is exactly what the load balancing, auto scaling and backup cards solve.

## Platform mode notes

The lab instance carries the platform's management role (only for the SSM management channel); the app itself has no AWS identity. While the instance is stopped in step 5, the lab instance terminal and local checks show "expected outage".
