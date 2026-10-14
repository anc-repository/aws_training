---
section: cleanup
---

- The platform deletes the records and the (optional) health check in the dns stack, along with any hosted zone this session created — unless you choose to keep it in the end dialog (it is billed monthly).
- **Remove the NS delegation you added at your registrar or parent domain.** Once the hosted zone is deleted, the delegation points at name servers that no longer exist, and such a dangling delegation can let someone else take over the subdomain.
- Delete the `www` Alias record you created by hand in step 5 yourself; when you use an existing hosted zone, the platform only deletes the records the dns stack created.
- If an IP change drill failed halfway, check in the EC2 console that the lab instance still has its original EIP, and release the temporary EIP tagged `Purpose=dns-ip-change-drill`.
- You do not need to — and should not — add tags starting with `atl:` to resources by hand: the platform claims resources from this session's module stacks and the creation records in CloudTrail.
