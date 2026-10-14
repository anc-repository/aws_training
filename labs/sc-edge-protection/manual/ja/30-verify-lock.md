---
step: verify-lock
---

オリジンがロックされたことを証明します。攻撃者が使える経路は 3 つあります。Elastic IP の 80/443 への直接アクセス、8080 への直接アクセス、そして「CloudFront から来た」リクエストの偽造です。それぞれが何で止められるかを 1 つずつ見ていきます。

**1. ラボ用インスタンスのセキュリティグループ**：80/443 は管理者 IP だけが残っています。

```bash {runsOn=workstation}
aws ec2 describe-security-group-rules --filters Name=group-id,Values={{ target.sgId }} --query "SecurityGroupRules[?IsEgress==\`false\`].[FromPort,ToPort,CidrIpv4,CidrIpv6]" --output table
```

**2. オリジンのセキュリティグループ**：8080 は CloudFront のマネージドプレフィックスリスト（`com.amazonaws.global.cloudfront.origin-facing`）だけを参照しています。ワークベンチから 8080 にリクエストするとタイムアウトします。

```bash {runsOn=workstation}
aws ec2 describe-security-group-rules --filters Name=group-id,Values={{ var.originSgId }} --query "SecurityGroupRules[?IsEgress==\`false\`].[FromPort,PrefixListId]" --output table
curl -s -o /dev/null -m 8 -w "8080 from workstation: %{http_code}\n" "http://{{ target.publicIp }}:8080/api/health/live" || echo "8080 from workstation: timeout"
```

::console-link[ラボ用インスタンスのセキュリティグループを開く]{link=ec2.securityGroup sgId="{{ target.sgId }}"}

**3. プレフィックスリストの先にある 2 つ目の鍵**：他人の CloudFront ディストリビューションも同じアドレス範囲から来るため、Nginx は `X-Origin-Verify` も検証します。セキュリティグループが前で止めているので、
この層はラボ用インスタンス自身からしか確かめられません。検証ヘッダーなしで 8080 にリクエストします。

```bash {runsOn=lab}
curl -s -o /dev/null -w "8080 without X-Origin-Verify: %{http_code}\n" http://127.0.0.1:8080/api/health/live
```

**4. 攻撃者の視点**：管理者 IP **ではない**場所からラボ用インスタンスに直接アクセスします。CloudShell を開きます（送信元のアドレスは AWS のもので、セキュリティグループの許可リストには入っていません）。

::console-link[CloudShell を開く]{link=cloudshell.home}

```bash {runsOn=cloudshell}
curl -s -o /dev/null -m 8 -w "%{http_code}\n" "http://{{ target.publicIp }}/api/health/live" || echo timeout
curl -s -o /dev/null -m 8 -w "%{http_code}\n" "https://{{ var.cdnDomain }}/api/health/live"
```

:::expected
1 つ目は `{{ workstation.publicIp }}/32` の 80 と 443 だけです。2 つ目は 8080 + `pl-…` のルールが 1 つだけで、ワークベンチからの 8080 へのリクエストはタイムアウトします。
3 つ目は **403** を返します。4 つ目は直接アクセスがタイムアウトし、ディストリビューション経由では 200 を返します。
:::

:::why
**なぜ `waf/bypass` の実験をそのまま実行しないのでしょうか？** ワークベンチのパブリックな送信元は管理者 IP そのものなので、ワークベンチから 80 番ポートを調べれば必ず到達でき、実験は「ロックされていない」と報告してしまいます。
「攻撃者が迂回できるか」は攻撃者の位置（CloudShell）に立って判断し、「ルールが実際にどうなっているか」はクライアントが見たレスポンスではなく、サーバー側のセキュリティグループの設定で判断します。
:::

::checks
