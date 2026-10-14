---
step: blocklist
---

（任意）IP のブロックと Shield。

管理画面 `/admin/security` で、ドキュメント用に予約されたアドレス（たとえば `192.0.2.1`）をブロックします。ローカルの `denylist.conf` がすぐに有効になり（Nginx を reload）、us-east-1 の IP セット `{{ var.ipSetName }}` にも同期されます。

```bash {runsOn=lab}
curl -s http://127.0.0.1/api/admin/security/blocklist | jq '{driver, ipSet, lastSync}'
```

**Shield Standard**（自動・無料で、ネットワーク層 / トランスポート層の DDoS を防ぐ）と **Shield Advanced**（有料で、DDoS レスポンスチームとコスト保護が付く）の違いを読んでおきましょう。複数アカウントを一元管理するには **Firewall Manager** を使います。

:::expected
管理用エンドポイントは `driver: aws` を返し、`lastSync.ok` は `true` です。ブロックがローカルの denylist から us-east-1 の IP セットに同期されました。
:::
