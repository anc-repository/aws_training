---
step: inspect
---

同じキャッシュのエンドポイントに、ラボ用インスタンスとワークベンチの 2 か所から接続してみます。どちらもデフォルト VPC にあり、エンドポイントもプライベートアドレスにしか解決されません。

**ラボ用インスタンスのターミナル**で、TLS を使って PING を 1 回送ります（Valkey は転送時の暗号化が有効なので、TLS が必須です）。

```bash {runsOn=lab}
printf 'PING\r\n' | timeout 5 openssl s_client -connect "{{ var.redisUrl | host }}:6379" -quiet 2>/dev/null | head -1
```

**ワークベンチのターミナル**では、TCP 接続が確立できるかだけをテストします（ワークベンチには Redis クライアントがありません）。

```bash {runsOn=workstation}
timeout 5 bash -c 'exec 3<>/dev/tcp/{{ var.redisUrl | host }}/6379' && echo open || echo blocked
```

次に、キャッシュノードのセキュリティグループを見ます。

```bash {runsOn=workstation}
aws elasticache describe-cache-clusters --cache-cluster-id "{{ var.replicationGroupId }}-001" --query "CacheClusters[0].SecurityGroups"
```

:::expected
ラボ用インスタンスでは `+PONG` が返り、ワークベンチでは `blocked` と表示されます。ワークベンチをブロックしているのは `sg-cache` です。6379 のインバウンドルールはラボ用インスタンスのセキュリティグループ `{{ target.sgId }}` だけを許可しています。
:::

:::why
ElastiCache にはパブリックエンドポイントがなく、VPC 内からしかアクセスできません。セキュリティグループのソースに別のセキュリティグループを指定すると、IP の範囲を書くより堅牢です。インスタンスの IP が変わっても、複数台に増えても、ルールを変える必要がありません。
:::

::checks
