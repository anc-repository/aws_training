---
step: before-cross
---

権限外アクセスのテストです。テストユーザー A が自分のプレフィックストークンを使って、B の元画像のキーに書き込み、B の写真を削除しようとします（storage=local のときは、B のパートの一覧表示も試します）。

```bash {runsOn=workstation}
npm run exp -- identity-pool --label before --scenario cross-prefix --upload
```

::experiment{module=identity-pool id=cross-prefix label=before}

:::expected
`attempts` の `write-own` は allowed、`write-other` は 403 `UPLOAD_PREFIX_DENIED` で `deniedBy: application` です。
`deniedByApplication` ≥ 2、`unexpected` = 0 です。サーバー側の証拠 `otherPhotoStatus` は `UPLOADING` で、B の写真には書き込まれていません。
:::

:::why
拒否のロジックは `backend/src/adapters/identity-pool/none.ts` にあります。キーは「トークンのプレフィックスの範囲内にある」ことと「トークンの持ち主の写真で、状態がアップロード中である」ことの 2 つを同時に満たす必要があります。
これはアプリのコードの責任です。1 行書き間違えるだけで権限外アクセスが成立してしまいます。次のステップでは、この仕事を IAM に任せます。
:::

::checks
