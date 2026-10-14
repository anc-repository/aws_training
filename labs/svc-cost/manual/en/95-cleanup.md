---
section: cleanup
---

- Reclaiming deletes the two budgets, the budget action, the canary role and the cost topic (budgets are global, so the reclaimer checks them on the us-east-1 side).
- **The cost allocation tags stay active** and are not deactivated with the card: deactivating them would leave a gap in the tag-based history in Cost Explorer.
- `cost-rates.yaml` lives on the lab instance's data volume and is deleted with it; if you want to keep the prices you copied, make your own copy before you end the lab.
- Every Cost Explorer API call is billed; this card refreshes by hand at most once — do not refresh it repeatedly.
- The platform's `atl-platform-guard` budget does not belong to this card; do not change it.
