---
section: overview
---

## Background

Your album runs on a single EC2 instance in Tokyo: every thumbnail and every JS file is sent by Nginx on that machine. When users overseas open the album, every byte crosses the ocean and back.
As traffic grows, so do the load on the instance's network and its data transfer out costs. This card puts Amazon CloudFront in front of EC2 so that the same content is served from the edge location closest to the user.
A cache hit never goes back to the origin at all.

:::why
A CloudFront custom origin only accepts a domain name, so the distribution uses the lab instance's public DNS name as its origin. To make sure that only your distribution can reach the origin, the module opens an 8080 listener on the lab instance that is reserved for CloudFront: the security group only allows CloudFront's managed prefix list, and Nginx also checks an `X-Origin-Verify` request header that only you know.
:::

## Comparison experiments

### Origin load (cdn/media-load, required)

- **Without CloudFront (served directly by EC2)**: the workbench keeps loading the album and its thumbnails, and every request reaches Nginx on EC2.
- **With CloudFront**: the same load goes through the distribution. Cache hits no longer reach the origin, and EC2 only handles the misses.
- **Where you will see it**: in the comparison report, origin requests (`server.origin`) and EC2 bytes sent (`host.net_tx_bytes`) go down; the `X-Cache` response header goes from absent to
  `Hit from cloudfront`; the `entry` of `X-CloudAlbum-Path` changes from `nginx` to `cloudfront>nginx`.
- **If the results are not what you expect**: first check that the after run had `--param target=cdn`, then check that the distribution status is Deployed.

### Time to first byte and compression (cdn/ttfb, cdn/compression, optional)

The workbench and the lab instance are both in Tokyo, so the difference in time to first byte is small and only for reference. The compression experiment looks at `Content-Encoding: br` on JS and CSS served through CloudFront.

## Platform mode notes

This card creates the distribution in one go with `scripts/module enable cdn` (route S). The platform uses this session's cdn module stack to confirm that the distribution is yours. When checking, the platform requests the distribution domain itself,
verifies that the peer IP belongs to CloudFront's address ranges, and counts the requests in the origin log. The response headers you see in the browser are therefore for observation only and do not count as evidence of completion.
