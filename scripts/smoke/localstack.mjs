#!/usr/bin/env node
// scripts/smoke/localstack.mjs —— npm run smoke:localstack：STORAGE_DRIVER=s3 与 QUEUE_DRIVER=sqs 的直传与消费流程（本机模拟端点）
//
// 档位：MODULE_IAM=on（IAM_CREDENTIALS=keys，模拟端点的测试密钥）+ storage=s3 + queue=sqs + IMAGE_PROCESSOR=worker，
// 所有 AWS SDK 客户端经 AWS_ENDPOINT_URL 指向本机模拟端点。验证：浏览器式的 S3 预签名 PUT 直传（字节不经 EC2）、
// complete 后 image.process 进 SQS、由 worker 进程长轮询消费并生成缩略图、DeleteMessage、S3 预签名 GET 读取衍生图、
// F14 经 parts:sign 的分片直传，以及 L0 的其余流程。
//
// 模拟端点的选择（--emulator auto|localstack|minicloud，默认 auto）：
//   localstack：本机已有 localstack/localstack 镜像时用 docker-compose.test.yml 的 localstack 服务（127.0.0.1:4566）；
//   minicloud ：没有 LocalStack 镜像时，用本机已有的 MinIO 镜像提供 S3，由 minicloud.mjs 在同一端点上提供 SQS / STS / IAM 的最小实现。
// 本脚本不拉取任何镜像，也不访问任何真实 AWS 端点（凭证是模拟端点的测试值）。
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command, S3Client,
} from '@aws-sdk/client-s3';
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MiniCloud } from './minicloud.mjs';
import {
  argFlag, argValue, check, docker, dockerAvailable, freePort, imagePresent, Reporter, requireBuild, ROOT, sleep, waitTcp,
} from './lib.mjs';
import { runVariant } from './run.mjs';

const REGION = 'ap-northeast-1';
const COMPOSE = ['compose', '-f', path.join(ROOT, 'docker-compose.test.yml')];

function findImage(prefixes) {
  const r = docker(['images', '--format', '{{.Repository}}:{{.Tag}}']);
  const all = r.status === 0 ? r.stdout.split('\n') : [];
  return all.find((i) => prefixes.some((p) => i.startsWith(p))) ?? null;
}

async function startMinio(t, state) {
  const image = ['minio/minio:latest', 'quay.io/minio/minio:RELEASE.2025-06-13T11-33-47Z'].find((i) => imagePresent(i)) ?? findImage(['minio/minio:', 'quay.io/minio/minio:']);
  check(image, '本机既没有 localstack 镜像也没有 minio 镜像（本脚本不拉取镜像）');
  const port = await freePort();
  const user = 'cloudalbumsmoke';
  const password = randomBytes(18).toString('base64url');
  const name = `cloudalbum-smoke-minio-${Date.now()}`;
  const r = docker(['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:9000`, '-e', `MINIO_ROOT_USER=${user}`,
    '-e', `MINIO_ROOT_PASSWORD=${password}`, '-e', `MINIO_SITE_REGION=${REGION}`, image, 'server', '/data'], { timeout: 120_000 });
  check(r.status === 0, `docker run minio 失败：${r.stderr}`);
  state.container = name;
  await waitTcp('127.0.0.1', port);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/minio/health/live`)).ok) break;
    } catch { /* 启动中 */ }
    await sleep(500);
  }
  const cloud = await new MiniCloud({ s3Target: `http://127.0.0.1:${port}` }).start();
  state.cloud = cloud;
  return { image, endpoint: cloud.endpoint, accessKeyId: user, secretAccessKey: password };
}

async function startLocalstack() {
  const r = docker([...COMPOSE, 'up', '-d', '--pull', 'never', '--wait', 'localstack'], { timeout: 300_000 });
  check(r.status === 0, `compose up localstack 失败：${r.stderr || r.stdout}`);
  await waitTcp('127.0.0.1', 4566);
  return { endpoint: 'http://127.0.0.1:4566', accessKeyId: 'test', secretAccessKey: 'test' };
}

async function main() {
  requireBuild();
  const keep = argFlag('keep');
  const want = argValue('emulator', 'auto');
  const t = new Reporter('smoke:localstack');
  const state = {};
  t.section('模拟端点');
  let em;
  const stamp = Date.now().toString(36);
  const raw = `cloudalbum-smoke-raw-${stamp}`;
  const media = `cloudalbum-smoke-media-${stamp}`;
  const ok = await t.step('选择并启动本机模拟端点（不拉取镜像）', async () => {
    check(dockerAvailable(), 'docker 不可用');
    const ls = findImage(['localstack/localstack:']);
    state.mode = want === 'auto' ? (ls ? 'localstack' : 'minicloud') : want;
    if (state.mode === 'localstack') {
      check(ls, '本机没有 localstack/localstack 镜像（docker pull localstack/localstack:4 后重试，或用 --emulator minicloud）');
      em = await startLocalstack();
      return `LocalStack（${ls}）@ ${em.endpoint}`;
    }
    em = await startMinio(t, state);
    return `LocalStack 镜像不在本机 → MinIO（${em.image}）提供 S3 + minicloud 提供 SQS / STS / IAM @ ${em.endpoint}`;
  });
  if (!ok) {
    process.exitCode = t.finish(path.join(ROOT, '.cloudalbum', 'smoke', 'last-localstack.json'));
    return;
  }
  const creds = { accessKeyId: em.accessKeyId, secretAccessKey: em.secretAccessKey };
  const s3 = new S3Client({ region: REGION, endpoint: em.endpoint, forcePathStyle: true, credentials: creds });
  const sqs = new SQSClient({ region: REGION, endpoint: em.endpoint, credentials: creds });
  let queueUrl;
  let dlqUrl;
  await t.step(`建桶 ${raw} / ${media}，建队列（主队列 + DLQ，maxReceiveCount=3）`, async () => {
    for (const b of [raw, media]) await s3.send(new CreateBucketCommand({ Bucket: b, CreateBucketConfiguration: { LocationConstraint: REGION } }));
    if (state.mode === 'localstack') {
      dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: `cloudalbum-smoke-jobs-dlq-${stamp}` }))).QueueUrl;
      const dlqArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))).Attributes.QueueArn;
      queueUrl = (await sqs.send(new CreateQueueCommand({
        QueueName: `cloudalbum-smoke-jobs-${stamp}`,
        Attributes: { VisibilityTimeout: '30', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 3 }) },
      }))).QueueUrl;
    } else {
      const dlq = state.cloud.createQueue(`cloudalbum-smoke-jobs-dlq-${stamp}`);
      queueUrl = state.cloud.createQueue(`cloudalbum-smoke-jobs-${stamp}`, { dlq, maxReceiveCount: 3 }).url;
      dlqUrl = dlq.url;
    }
    return `${queueUrl}`;
  });

  const listKeys = async (bucket) => {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    return (r.Contents ?? []).map((o) => o.Key);
  };

  const variant = {
    modules: {
      iam: { MODULE_IAM: 'on', IAM_CREDENTIALS: 'keys' },
      storage: { MODULE_STORAGE: 'on', STORAGE_DRIVER: 's3', STORAGE_S3_RAW_BUCKET: raw, STORAGE_S3_MEDIA_BUCKET: media },
      queue: { MODULE_QUEUE: 'on', QUEUE_DRIVER: 'sqs', SQS_QUEUE_URL: queueUrl, SQS_DLQ_URL: dlqUrl, SQS_WAIT_TIME_SEC: '2' },
      'image-processing': { IMAGE_PROCESSOR: 'worker' },
    },
    profile: {
      name: `${state.mode === 'localstack' ? 'LocalStack' : 'MinIO + minicloud'}：storage=s3 + queue=sqs + worker`,
      storage: 's3', imageAsync: true, imageDriver: 'worker', cacheDriver: 'none', dbDriver: 'sqlite', expectNoAwsSdk: false, f14: true,
      expectModules: {
        ec2: { allow: ['ok', 'degraded'] },
        iam: { driver: 'keys', allow: ['degraded'] },                   // keys 模式始终至少 degraded（CRED-002）
        storage: { driver: 's3', allow: ['ok', 'degraded'] },           // 模拟端点没有 SSE 配置时深度项 degraded
        queue: { driver: 'sqs', allow: ['ok'] },
        'image-processing': { driver: 'worker' },
      },
    },
    async after(tt, _env, s) {
      await tt.step('S3：原图在原图桶 raw/，衍生图在展示桶 variants/（字节没有落在 EC2 本地盘）', async () => {
        const rawKeys = await listKeys(raw);
        const mediaKeys = await listKeys(media);
        check(rawKeys.some((k) => k.startsWith(`raw/${s.aId}/`)), `原图桶中没有 raw/${s.aId}/…：${rawKeys.join(', ')}`);
        check(mediaKeys.some((k) => k.startsWith('variants/') && k.endsWith('thumb_200.webp')), `展示桶中没有缩略图：${mediaKeys.join(', ')}`);
        check(mediaKeys.some((k) => k.startsWith('reports/daily/')), `展示桶中没有日报：${mediaKeys.join(', ')}`);
        return `raw ${rawKeys.length} 个 · media ${mediaKeys.length} 个`;
      });
      await tt.step('SQS：api 入队、worker 长轮询消费并删除，主队列与 DLQ 清空', async () => {
        let depth;
        for (let i = 0; i < 40; i++) {
          const a = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }))).Attributes;
          depth = Number(a.ApproximateNumberOfMessages) + Number(a.ApproximateNumberOfMessagesNotVisible);
          if (depth === 0) break;
          await sleep(500);
        }
        const dlqDepth = Number((await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] }))).Attributes.ApproximateNumberOfMessages);
        check(depth === 0 && dlqDepth === 0, `队列未清空：主队列 ${depth}，DLQ ${dlqDepth}`);
        if (state.cloud) {
          const st = state.cloud.stats.sqs;
          check((st.SendMessage ?? 0) + (st.SendMessageBatch ?? 0) > 0 && (st.ReceiveMessage ?? 0) > 0, `没有收发记录：${JSON.stringify(st)}`);
          check((st.DeleteMessage ?? 0) + (st.DeleteMessageBatch ?? 0) > 0, `没有删除记录：${JSON.stringify(st)}`);
          return `SQS 调用 ${JSON.stringify(st)} · STS ${state.cloud.stats.sts} · S3 转发 ${state.cloud.stats.s3Proxied}`;
        }
        return '主队列 0 · DLQ 0';
      });
      await tt.step('缩略图由 worker 进程（SQS 消费者）生成，不是 api 进程', async () => {
        const p = (await s.a.get(`/api/photos/${s.photoId}`)).body;
        const steps = (await s.a.get(`/api/photos/${s.photoId}/pipeline`)).body;
        check(p.processedBy?.driver === 'worker', `processedBy.driver=${p.processedBy?.driver}`);
        return `processedBy=${JSON.stringify(p.processedBy)} · 步骤 ${(steps.steps ?? steps.items ?? []).map((x) => x.name ?? x.step).join(' → ')}`;
      });
    },
  };

  try {
    await runVariant(t, 'localstack', variant, {
      keep, base: { AWS_ENDPOINT_URL: em.endpoint }, secrets: { IAM_KEYS_ACCESS_KEY_ID: em.accessKeyId, IAM_KEYS_SECRET_ACCESS_KEY: em.secretAccessKey },
    });
  } finally {
    if (!keep) {
      for (const b of [raw, media]) {
        try {
          const keys = await listKeys(b);
          if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: b, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
          await s3.send(new DeleteBucketCommand({ Bucket: b }));
        } catch { /* 容器即将删除 */ }
      }
      if (state.mode === 'localstack') {
        for (const u of [queueUrl, dlqUrl]) if (u) await sqs.send(new DeleteQueueCommand({ QueueUrl: u })).catch(() => undefined);
      }
    }
    s3.destroy();
    sqs.destroy();
    await state.cloud?.stop();
    if (state.container) docker(['rm', '-f', state.container]);
  }
  process.exitCode = t.finish(path.join(ROOT, '.cloudalbum', 'smoke', 'last-localstack.json'));
}

await main();
