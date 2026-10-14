---
step: baseline-payloads
---

Record the second part of **before**: Nginx's signature blocking. `payloads` sends a set of public WAF test payloads (SQL injection and its URL-encoded / double-encoded / case-and-comment variants, directory traversal, XSS, a Log4Shell probe string in a request header, and scanner User-Agents).

```bash {runsOn=workstation}
npm run exp -- waf --label before --scenario payloads --param target=direct
```

Notice that Nginx's few regexes **miss** double-encoded, case and comment variants — that is exactly its limitation, and step 7 compares it with the AWS managed rule groups.
