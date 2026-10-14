/**
 * 组件展示页与架构图快照测试用的卡片样本：取自 labs/_catalog/catalog.yaml（默认起始变体的 modules 与 targets，2026-10 版）。
 * 只用于开发展示与测试，不进生产包（main.tsx 不引用 dev-gallery/）。
 */
import type { ArchInput } from '../ui/diagram/model';

export interface SampleCard {
  id: string;
  input: ArchInput;
}

export const SAMPLE_CARDS: readonly SampleCard[] = [
  { id: 'svc-ec2', input: { start: [], targets: [] } },
  { id: 'svc-storage', input: { start: ['iam'], targets: [{ id: 'storage', from: 'local', to: 's3' }] } },
  { id: 'svc-cdn', input: { start: ['iam'], targets: [{ id: 'cdn', from: 'direct', to: 'cloudfront' }] } },
  { id: 'svc-database', input: { start: ['iam'], targets: [{ id: 'database', from: 'sqlite', to: 'postgres' }] } },
  {
    id: 'sc-edge-protection',
    input: { start: ['iam'], targets: [{ id: 'cdn', from: 'direct', to: 'cloudfront' }, { id: 'waf', from: 'nginx', to: 'aws' }] },
  },
  {
    id: 'sc-static-acceleration',
    input: { start: ['iam', 'storage'], targets: [{ id: 'cdn', from: 'direct', to: 'cloudfront' }], options: { CDN_MEDIA_ORIGIN: 's3' } },
  },
  { id: 'svc-identity-pool', input: { start: ['iam', 'storage', 'auth'], targets: [{ id: 'identity-pool', from: 'none', to: 'cognito' }] } },
  {
    id: 'sc-event-fanout',
    input: { start: ['iam'], targets: [{ id: 'email', from: 'outbox', to: 'ses' }, { id: 'notification', from: 'db', to: 'sns' }] },
  },
  {
    id: 'sc-user-identity',
    input: {
      start: ['iam', 'storage', 'cdn'],
      targets: [
        { id: 'auth', from: 'local', to: 'cognito' },
        { id: 'identity-pool', from: 'none', to: 'cognito' },
        { id: 'social-api', from: 'express', to: 'apigw' },
      ],
    },
  },
  {
    id: 'sc-image-pipeline',
    input: {
      start: ['iam', 'storage'],
      targets: [
        { id: 'image-processing', from: 'inline', to: 'lambda' },
        { id: 'tagging', from: 'none', to: 'rekognition' },
        { id: 'workflow', from: 'inline', to: 'stepfunctions', optional: true },
      ],
    },
  },
  { id: 'svc-load-balancer', input: { start: ['iam'], targets: [{ id: 'load-balancer', from: 'nginx', to: 'alb' }] } },
  {
    id: 'sc-ha-web',
    input: {
      start: ['iam', 'storage', 'database'],
      targets: [
        { id: 'load-balancer', from: 'nginx', to: 'alb' },
        { id: 'autoscaling', from: 'single', to: 'asg' },
        { id: 'ami', from: 'userdata', to: 'golden', optional: true },
      ],
    },
  },
  {
    id: 'sc-private-network',
    input: {
      start: ['iam', 'network', 'load-balancer'],
      targets: [
        { id: 'shell-access', from: 'ssh', to: 'ssm' },
        { id: 'network', from: 'public', to: 'private' },
      ],
    },
  },
  { id: 'svc-db-proxy', input: { start: ['iam', 'secrets', 'database'], targets: [{ id: 'db-proxy', from: 'none', to: 'rds-proxy' }] } },
  {
    id: 'sc-db-performance',
    input: {
      start: ['iam', 'secrets', 'database'],
      targets: [
        { id: 'database', from: 'postgres', to: 'postgres' },
        { id: 'cache', from: 'none', to: 'redis' },
        { id: 'db-proxy', from: 'none', to: 'rds-proxy' },
      ],
    },
  },
  {
    id: 'sc-observability',
    input: {
      start: ['iam', 'storage', 'queue'],
      targets: [
        { id: 'logging', from: 'file', to: 'cloudwatch' },
        { id: 'monitoring', from: 'local', to: 'cloudwatch' },
        { id: 'tracing', from: 'none', to: 'xray' },
      ],
    },
  },
  {
    id: 'sc-threat-compliance',
    input: {
      start: ['iam'],
      targets: [
        { id: 'audit', from: 'app', to: 'cloudtrail' },
        { id: 'threat-detection', from: 'fail2ban', to: 'guardduty' },
        { id: 'vuln-scan', from: 'dnf', to: 'inspector' },
        { id: 'compliance', from: 'local', to: 'config' },
      ],
    },
  },
];

export function sampleCard(id: string): SampleCard {
  const c = SAMPLE_CARDS.find((x) => x.id === id);
  if (!c) throw new Error(`unknown sample card ${id}`);
  return c;
}
