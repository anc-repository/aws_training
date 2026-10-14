---
section: cleanup
---

- When you end the lab, the platform deletes every resource of this session. A CloudFront distribution must be disabled and finish deploying before it can be deleted, so reclaiming this card takes longer than for other cards.
- The cache policy and the response headers policy can only be deleted after the distribution is gone; the reclaimer handles them in that order.
- Keep invalidation paths to a minimum: paths beyond the monthly free allowance are charged.
- You do not need to — and should not — add tags starting with `atl:` to resources by hand: the platform claims resources from this session's module stacks and the creation records in CloudTrail.
