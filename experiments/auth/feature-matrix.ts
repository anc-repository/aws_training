/**
 * auth/feature-matrix —— 功能矩阵（02#auth 第 5 节步骤 1）。
 *
 *   npm run exp -- auth --label before --scenario feature-matrix
 *
 * 读取 /api/capabilities：auth 模块的公开配置（MFA、托管登录域名、密码策略）与 F1～F4、F12 子功能（enabled / via / reason），
 * 打印为对照表并写入 findings。两次（before / after）的结果用 exp:report 对比即可看到“白送”的能力。
 */
import { defineScenario } from '../_lib/scenario.js';
import { authDriver } from './accounts.js';

export default defineScenario({
  warmupWithRun: false,
  async run(ctx) {
    const caps = ctx.capabilities;
    const auth = caps.modules?.auth;
    const pub = (auth?.public ?? {}) as Record<string, unknown>;
    const features: Record<string, { enabled: boolean; via?: string[]; reason?: string }> = {};
    for (const [id, f] of Object.entries(caps.features ?? {})) {
      if (!/^F(1|2|3|4|12)\./.test(id)) continue;
      features[id] = { enabled: f.enabled, ...(f.via ? { via: f.via } : {}), ...(f.reason ? { reason: f.reason } : {}) };
    }
    const matrix = {
      driver: authDriver(ctx),
      status: auth?.status,
      mfa: pub.mfa ?? null,
      hostedLogin: Boolean(pub.hostedUiDomain),
      passwordPolicy: pub.passwordPolicy ?? null,
      passwordHashesOnEc2: authDriver(ctx) === 'local',
      tokenSigning: authDriver(ctx) === 'local' ? 'ES256（自己的密钥 + /.well-known/jwks.json）' : 'RS256（User Pool JWKS）',
    };
    ctx.finding('matrix', matrix);
    ctx.finding('features', features);
    ctx.finding('enabledFeatures', Object.values(features).filter((f) => f.enabled).length);
    for (const [k, v] of Object.entries(matrix)) ctx.log(`${k.padEnd(20)} ${JSON.stringify(v)}`);
    for (const [id, f] of Object.entries(features)) ctx.log(`${id.padEnd(20)} ${f.enabled ? '启用' : '未启用'} ${f.via?.join(',') ?? ''} ${f.reason ?? ''}`);
  },
});
