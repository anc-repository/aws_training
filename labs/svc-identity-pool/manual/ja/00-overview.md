---
section: overview
---

## 背景

CloudAlbum の F14 は「複数ファイル、再開可能、プレフィックス単位で認可する直接アップロード」です。開始状態（identity-pool の none ドライバー）では、EC2 自身が
**プレフィックス範囲のアップロードトークン**を発行します。ブラウザーはトークンを 1 つ持ち、`raw/<userId>/` の下に複数のファイルを続けてアップロードしたり、パートごとに再開したりできますが、パートごとに毎回 EC2 に問い合わせる必要があります。
このカードの開始状態では storage がすでに S3 なので、パートごとにまず `POST /api/uploads/parts:sign` で署名付きの `UploadPart` URL を受け取ります。認可のロジックはアプリのコードに書かれています。

Identity Pool を有効にすると、サインイン済みのユーザーは User Pool の ID トークンを STS の一時的な認証情報（アクセスキーは `ASIA` で始まります）と交換します。
この認証情報で書き込めるのは、モジュール付属のステージングバケットの `private/<identityId>/` だけです。ブラウザーは自分で署名してパートを S3 に直接送り、`complete` の時点でバックエンドがサイズ、種類、
ファイルヘッダー（マジックナンバー）を検証してから、サーバー側の `CopyObject` でオブジェクトを元画像の場所に取り込みます。その後のサムネイル作成やタグ付けの流れは、ほかのアップロード方法とまったく同じです。

:::why
User Pool は「あなたは誰か」に答えます（JWT を発行）。Identity Pool は「あなたは AWS で何ができるか」に答えます。User Pool のトークンを IAM ロールの一時的な認証情報に交換するのです
（ウェブ ID フェデレーションで、裏側では `sts:AssumeRoleWithWebIdentity` が動きます）。すべてのユーザーに同じロールを与えながら、各ユーザーを自分のプレフィックスに制限できるのは、
IAM ポリシー変数 `${cognito-identity.amazonaws.com:sub}` のおかげです。その値は Identity ID（`ap-northeast-1:uuid` の形式）で、User Pool の sub ではありません。
:::

## 比較実験の予告

### 一括アップロード（identity-pool/upload-bench、必須）

- **Identity Pool なし**：ファイル 1 つ＝登録 + **パートごとに 1 回**の `parts:sign` + complete で、バックエンドへのリクエスト数はパートの数に比例して増えます。
- **Identity Pool あり**：認証情報を 1 回交換した後は、ファイルごとのバックエンドへのリクエストは登録と complete の 2 回だけで、パートのリクエストはすべて S3 に直接届きます。
- **どこで確認できるか**：レポートの `backendRequestsPerFile` と、ブラウザーの DevTools です。sts モードのリクエストは
  `cloudalbum-<env>-upload-staging-<アカウント>.s3.ap-northeast-1.amazonaws.com` に直接届き、リクエストヘッダーに `x-amz-security-token` があり、Authorization の Credential は `ASIA` で始まります。

### 権限外アクセスのテスト（identity-pool/cross-prefix、必須）

ユーザー A が B のプレフィックスに書き込む、バケット全体を一覧表示する、B のオブジェクトを削除する。どちらの方式でも拒否されますが、**拒否する者が違います**。before ではアプリが 403 `UPLOAD_PREFIX_DENIED` を返し、
after では S3 が `AccessDenied` を返し、アプリのコードはまったく関与しません。

### 再開可能なアップロード（identity-pool/resume、必須）

アップロードを途中で切断してから再開します。S3 の `ListParts` がどのパートを受け取ったかをブラウザーに教え、足りないパートだけを送り直します。

## 始める前に

- 開始状態には、storage（S3）、auth（Cognito）、そして確認済みでパスワードが分かっているテストユーザー 2 人（シード `cognito-test-users`）がすでに含まれています。
  比較実験はワークベンチからそれらを読み取り（環境変数 `CLOUDALBUM_TEST_USERS_PARAM` が指す SecureString）、パスワードはローカルのプロセスのメモリ内でだけ使います。
- 想定内の警告：`DEP-013`（auth=cognito と L0 のローカル outbox が同時にある）、`DEP-030`（APP_BASE_URL が http のときは一時的な認証情報が平文で配布される。
  プラットフォームのプレビュー方式 B では、ブラウザーは `https://<EIP>` を使います）。黄色の状態は設計どおりで、チェックは想定内の警告に従って判定します。

## プラットフォームモードについて

`scripts/module` と比較実験は、ワークベンチのターミナルで受講者の ID として実行されます。Uploader ロールにはワークロード用のアクセス許可の境界（ATLWorkloadBoundary）が付いています。
ステージングバケットの CORS は `http://<EIP>` に加えて、プレビューが使う `https://<EIP>` も許可します。
