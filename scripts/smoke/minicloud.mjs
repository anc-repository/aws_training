// scripts/smoke/minicloud.mjs —— LocalStack 不可用时的本机替身：一个端点（与 LocalStack 的 4566 一样）上同时提供
//   - SQS（AWS JSON 1.0 协议，X-Amz-Target: AmazonSQS.*）：SendMessage(Batch)、ReceiveMessage（长轮询、可见性超时、
//     ApproximateReceiveCount、按 RedrivePolicy 转入 DLQ）、DeleteMessage(Batch)、ChangeMessageVisibility、GetQueueAttributes；
//   - STS GetCallerIdentity、IAM GetUser（query 协议）：让 iam=keys 的探针有回答；
//   - 其余请求原样转发给 MinIO（S3 兼容；保留 Host 头，所以经本端点签发的预签名 URL 在 MinIO 端校验通过）。
// 只在本机 127.0.0.1 上监听，只为 npm run smoke:localstack 服务；不是任何 AWS 服务的实现。
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';

const ACCOUNT = '000000000000';

function md5(s) {
  return createHash('md5').update(s, 'utf8').digest('hex');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

class Queue {
  constructor(name, url) {
    this.name = name;
    this.url = url;
    this.arn = `arn:aws:sqs:ap-northeast-1:${ACCOUNT}:${name}`;
    this.messages = [];               // { id, body, attrs, receiveCount, visibleAt, handle, sentAt, firstReceiveAt }
    this.visibilityTimeout = 30;
    this.redrive = null;              // { dlq: Queue, maxReceiveCount }
    this.waiters = new Set();
  }

  notify() {
    for (const w of this.waiters) w();
  }
}

export class MiniCloud {
  constructor({ s3Target, port = 0 }) {
    this.s3Target = new URL(s3Target);
    this.port = port;
    this.queues = new Map();
    this.stats = { sqs: {}, sts: 0, iam: 0, s3Proxied: 0 };
  }

  get endpoint() {
    return `http://127.0.0.1:${this.port}`;
  }

  createQueue(name, { dlq, maxReceiveCount = 3, visibilityTimeout = 30 } = {}) {
    const q = new Queue(name, `${this.endpoint}/${ACCOUNT}/${name}`);
    q.visibilityTimeout = visibilityTimeout;
    if (dlq) q.redrive = { dlq, maxReceiveCount };
    this.queues.set(q.url, q);
    return q;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(e?.stack ?? e));
      });
    });
    this.server.keepAliveTimeout = 1000;
    await new Promise((resolve) => this.server.listen(this.port, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this;
  }

  async stop() {
    for (const q of this.queues.values()) q.notify();
    this.server?.closeAllConnections?.();
    await new Promise((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  async handle(req, res) {
    const target = req.headers['x-amz-target'];
    if (typeof target === 'string' && target.startsWith('AmazonSQS.')) {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return this.sqs(target.slice('AmazonSQS.'.length), body, req, res);
    }
    if (req.method === 'GET' && req.url === '/_minicloud/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...this.stats, queues: [...this.queues.values()].map((q) => ({ name: q.name, depth: q.messages.length })) }));
      return undefined;
    }
    const ct = String(req.headers['content-type'] ?? '');
    if (req.method === 'POST' && (req.url === '/' || req.url === '') && ct.includes('application/x-www-form-urlencoded')) {
      const form = new URLSearchParams((await readBody(req)).toString('utf8'));
      return this.query(form, res);
    }
    return this.proxy(req, res);
  }

  // ------------------------------------------------------------------------------------------
  // STS / IAM（query 协议，XML 响应）
  // ------------------------------------------------------------------------------------------
  query(form, res) {
    const action = form.get('Action');
    const xml = (inner) => {
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>\n${inner}`);
    };
    if (action === 'GetCallerIdentity') {
      this.stats.sts += 1;
      return xml(`<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult>
<Arn>arn:aws:iam::${ACCOUNT}:user/cloudalbum-lab-demo-keys</Arn><UserId>AIDAMINICLOUD</UserId><Account>${ACCOUNT}</Account>
</GetCallerIdentityResult><ResponseMetadata><RequestId>${randomUUID()}</RequestId></ResponseMetadata></GetCallerIdentityResponse>`);
    }
    if (action === 'GetUser') {
      this.stats.iam += 1;
      const name = form.get('UserName') ?? 'cloudalbum-lab-demo-keys';
      return xml(`<GetUserResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetUserResult><User>
<Path>/</Path><UserName>${name}</UserName><UserId>AIDAMINICLOUD</UserId><Arn>arn:aws:iam::${ACCOUNT}:user/${name}</Arn>
<CreateDate>2026-10-01T00:00:00Z</CreateDate></User></GetUserResult><ResponseMetadata><RequestId>${randomUUID()}</RequestId></ResponseMetadata></GetUserResponse>`);
    }
    res.writeHead(400, { 'content-type': 'text/xml' });
    res.end(`<ErrorResponse><Error><Type>Sender</Type><Code>InvalidAction</Code><Message>minicloud: ${action} 不支持</Message></Error></ErrorResponse>`);
    return undefined;
  }

  // ------------------------------------------------------------------------------------------
  // SQS（JSON 1.0）
  // ------------------------------------------------------------------------------------------
  sqsError(res, code, message, status = 400) {
    res.writeHead(status, { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-query-error': `AWS.SimpleQueueService.${code};Sender` });
    res.end(JSON.stringify({ __type: `com.amazonaws.sqs#${code}`, message }));
  }

  json(res, obj) {
    res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
    res.end(JSON.stringify(obj));
  }

  enqueue(q, entry) {
    const now = Date.now();
    const m = {
      id: randomUUID(), body: String(entry.MessageBody ?? ''), attrs: entry.MessageAttributes ?? {}, receiveCount: 0,
      visibleAt: now + Number(entry.DelaySeconds ?? 0) * 1000, handle: null, sentAt: now, firstReceiveAt: null,
    };
    q.messages.push(m);
    q.notify();
    return m;
  }

  /** 到达最大接收次数且又可见的消息转入 DLQ（与 SQS 的 redrive 语义一致：在下一次被接收时转移） */
  redrive(q, now) {
    if (!q.redrive) return;
    for (const m of [...q.messages]) {
      if (m.visibleAt <= now && m.receiveCount >= q.redrive.maxReceiveCount) {
        q.messages.splice(q.messages.indexOf(m), 1);
        q.redrive.dlq.messages.push({ ...m, receiveCount: 0, handle: null, visibleAt: now });
      }
    }
  }

  async sqs(op, body, req, res) {
    this.stats.sqs[op] = (this.stats.sqs[op] ?? 0) + 1;
    const q = this.queues.get(body.QueueUrl);
    if (!q) return this.sqsError(res, 'NonExistentQueue', `队列不存在：${body.QueueUrl}`);
    const now = Date.now();
    switch (op) {
      case 'SendMessage': {
        const m = this.enqueue(q, body);
        return this.json(res, { MessageId: m.id, MD5OfMessageBody: md5(m.body) });
      }
      case 'SendMessageBatch': {
        const ok = (body.Entries ?? []).map((e) => {
          const m = this.enqueue(q, e);
          return { Id: e.Id, MessageId: m.id, MD5OfMessageBody: md5(m.body) };
        });
        return this.json(res, { Successful: ok, Failed: [] });
      }
      case 'ReceiveMessage': {
        const max = Math.min(Number(body.MaxNumberOfMessages ?? 1), 10);
        const wait = Math.min(Number(body.WaitTimeSeconds ?? 0), 20) * 1000;
        const vt = Number(body.VisibilityTimeout ?? q.visibilityTimeout) * 1000;
        const deadline = Date.now() + wait;
        let closed = false;
        req.on('close', () => { closed = true; q.notify(); });
        for (;;) {
          const t = Date.now();
          this.redrive(q, t);
          const ready = q.messages.filter((m) => m.visibleAt <= t).slice(0, max);
          if (ready.length || t >= deadline || closed) {
            const out = ready.map((m) => {
              m.receiveCount += 1;
              m.firstReceiveAt ??= t;
              m.handle = `${m.id}:${randomUUID()}`;
              m.visibleAt = t + vt;
              return {
                MessageId: m.id, ReceiptHandle: m.handle, MD5OfBody: md5(m.body), Body: m.body,
                Attributes: { ApproximateReceiveCount: String(m.receiveCount), SentTimestamp: String(m.sentAt), ApproximateFirstReceiveTimestamp: String(m.firstReceiveAt) },
                ...(Object.keys(m.attrs).length ? { MessageAttributes: m.attrs } : {}),
              };
            });
            if (closed) return undefined;
            return this.json(res, out.length ? { Messages: out } : {});
          }
          const nextVisible = Math.min(...q.messages.map((m) => m.visibleAt).filter((v) => v > t), deadline);
          await new Promise((resolve) => {
            const timer = setTimeout(done, Math.max(5, nextVisible - t));
            function done() { clearTimeout(timer); q.waiters.delete(done); resolve(); }
            q.waiters.add(done);
          });
        }
      }
      case 'DeleteMessage': {
        const i = q.messages.findIndex((m) => m.handle === body.ReceiptHandle);
        if (i >= 0) q.messages.splice(i, 1);
        return this.json(res, {});
      }
      case 'DeleteMessageBatch': {
        const ok = [];
        for (const e of body.Entries ?? []) {
          const i = q.messages.findIndex((m) => m.handle === e.ReceiptHandle);
          if (i >= 0) q.messages.splice(i, 1);
          ok.push({ Id: e.Id });
        }
        return this.json(res, { Successful: ok, Failed: [] });
      }
      case 'ChangeMessageVisibility': {
        const m = q.messages.find((x) => x.handle === body.ReceiptHandle);
        if (!m) return this.sqsError(res, 'ReceiptHandleIsInvalid', '接收句柄无效');
        m.visibleAt = now + Number(body.VisibilityTimeout ?? 0) * 1000;
        q.notify();
        return this.json(res, {});
      }
      case 'GetQueueAttributes': {
        const visible = q.messages.filter((m) => m.visibleAt <= now).length;
        const all = {
          ApproximateNumberOfMessages: String(visible),
          ApproximateNumberOfMessagesNotVisible: String(q.messages.filter((m) => m.visibleAt > now && m.receiveCount > 0).length),
          ApproximateNumberOfMessagesDelayed: String(q.messages.filter((m) => m.visibleAt > now && m.receiveCount === 0).length),
          QueueArn: q.arn, VisibilityTimeout: String(q.visibilityTimeout), MessageRetentionPeriod: '1209600',
          ...(q.redrive ? { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: q.redrive.dlq.arn, maxReceiveCount: q.redrive.maxReceiveCount }) } : {}),
        };
        const names = body.AttributeNames ?? ['All'];
        const Attributes = names.includes('All') ? all : Object.fromEntries(names.filter((n) => n in all).map((n) => [n, all[n]]));
        return this.json(res, { Attributes });
      }
      default:
        return this.sqsError(res, 'UnsupportedOperation', `minicloud 不支持 ${op}`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // S3 → MinIO（原样转发，保留 Host）
  // ------------------------------------------------------------------------------------------
  proxy(req, res) {
    this.stats.s3Proxied += 1;
    return new Promise((resolve) => {
      const up = http.request({
        host: this.s3Target.hostname, port: this.s3Target.port, method: req.method, path: req.url, headers: req.headers,
      }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
        r.on('end', resolve);
      });
      up.on('error', (e) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`minicloud → MinIO 失败：${e.message}`);
        resolve();
      });
      req.pipe(up);
    });
  }
}
