// backend/src/lab/seeds/index.ts —— 测试数据种子登记表（06 PM-43）
//
// 新增种子须先在 06 §11 的表与这里登记，再在卡片中以 `kind: seed` 引用（04 的 lint 检查 item 属于本表）。
// 执行：运行器在 profile apply 成功后按档位 PROFILE_SEEDS 的顺序执行 `scripts/module seed <id> --platform`；
// scripts/module 负责平台侧步骤（生成密码、写 SSM 参数），实验机上的步骤经 SSM 调用 `cloudalbum seed <id> …`。
import { SEED_IDS, type SeedId } from '@cloudalbum/contracts';

export interface SeedDef {
  id: SeedId;
  title: string;
  /** 依赖的种子（gps-sample-photos 的照片属于 atl-test-1，必须排在 cognito-test-users 之后） */
  after: SeedId[];
  /** 实验机部分的 CLI 参数 */
  instanceArgs: string;
  /** 需要学员身份执行的部分（PM-36 钩子） */
  learnerHook?: string;
}

export const SEEDS: Readonly<Record<SeedId, SeedDef>> = {
  'cognito-test-users': {
    id: 'cognito-test-users', title: '3 个已确认、密码已知的测试用户 atl-test-1～atl-test-3', after: [],
    instanceArgs: '--users-b64 <base64url([{username,email,passwordHash}])>', learnerHook: 'cognito-passwords',
  },
  'gps-sample-photos': {
    id: 'gps-sample-photos', title: '3 张带 GPS EXIF 的示例照片', after: ['cognito-test-users'],
    instanceArgs: '[--owner <username>] [--album <title>]',
  },
};

export { SEED_IDS };

/** 按依赖排序（输入中出现的种子；未知 id 抛错） */
export function orderSeeds(ids: readonly string[]): SeedId[] {
  for (const id of ids) if (!(SEED_IDS as readonly string[]).includes(id)) throw new Error(`unknown seed ${id}`);
  const want = new Set(ids as SeedId[]);
  const out: SeedId[] = [];
  const visit = (id: SeedId) => {
    if (out.includes(id)) return;
    for (const dep of SEEDS[id].after) if (want.has(dep)) visit(dep);
    out.push(id);
  };
  for (const id of ids as SeedId[]) visit(id);
  return out;
}
