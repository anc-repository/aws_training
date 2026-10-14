---
section: cleanup
---

- Automatic reclaim disables and then deletes the distribution (this takes a few minutes, and reclaim progress is shown separately), then deletes the cache policy, response headers policy, OAC and CloudFront Function.
- The media bucket is emptied and deleted together with storage; before reclaim, the bucket policy statement cdn injected is removed with the storage stack update.
- This card does not turn on HSTS; if you turned it on by hand while practicing, browsers will remember it, so always use a very small `max-age`.
