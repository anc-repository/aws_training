/**
 * 步骤相关服务（09 I6 e“每个步骤顶部显示与本步相关的服务图标”）：从步骤自己的数据推出与本步相关的模块（registry 的 40 个模块 id），
 * 供步骤卡顶部的服务图标行使用。纯函数，不读界面语言。
 *
 * 来源（按这个顺序排列、去重，最多 `max` 个）：
 *   1. 本步接入的目标模块（`targetModules[].wireStep === step.id`）；
 *   2. 本步的对比实验模块（`step.experiment.module`）；
 *   3. 手册与检查复现命令中的 `scripts/module <动作> <模块>`；
 *   4. 本步检查的 `module`（capability / experiment）、`service`（aws-readonly）、`target`（http-header 的目标是模块时）；
 *   5. 手册中的控制台深链（`::console-link{link=s3.bucket}` → s3 → storage）；
 *   6. 手册命令中的 `aws <service> …`（CLI 名称 → 模块，见 CLI_MODULE）；
 *   7. 计费提示的价格键（`cloudfront.requests.https` → cdn）。
 * 认不出的名称一律忽略（不猜），所以图标行只会少、不会错。
 */
import { resolveModuleId } from '../../ui/glyphs/data';
import { checkLocalId, stepManual, type LabDoc, type LabStep, type MdNode } from './lab';

/** AWS CLI 的服务名 → 模块 id（与 taxonomy 服务 id 相同的名称由 resolveModuleId 处理，这里只列不同的）。 */
const CLI_MODULE: Readonly<Record<string, string>> = {
  s3api: 'storage',
  s3control: 'storage',
  elbv2: 'load-balancer',
  wafv2: 'waf',
  'cognito-idp': 'auth',
  'cognito-identity': 'identity-pool',
  sesv2: 'email',
  events: 'scheduler',
  apigatewayv2: 'social-api',
  logs: 'logging',
  configservice: 'compliance',
  inspector2: 'vuln-scan',
  ce: 'cost',
  'rds-data': 'database',
  'elasticache-serverless': 'cache',
};

/** `aws ssm` 的参数类子命令属于 Parameter Store（config），其余（start-session、send-command…）属于 Session Manager。 */
const SSM_PARAMETER = /^(get|put|delete|describe|label)-parameter/;

const AWS_CLI = /(?:^|[\s;|&(`$])aws\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/g;
const MODULE_SCRIPT = /scripts\/module\s+[a-z][a-z-]*\s+([a-z][a-z0-9-]*)/g;

/** CLI 服务名（与子命令）→ 模块 id；认不出时为 null。 */
export function moduleOfCli(service: string, sub?: string | null): string | null {
  if (service === 'ssm') return sub && SSM_PARAMETER.test(sub) ? 'config' : 'shell-access';
  if (service === 'configure' || service === 'help') return null;
  return CLI_MODULE[service] ?? resolveModuleId(service);
}

/** 文本中 `aws <service> <sub>` 与 `scripts/module <动作> <模块>` 提到的模块（按出现顺序）。 */
export function modulesInCommand(text: string): { script: string[]; cli: string[] } {
  const script: string[] = [];
  const cli: string[] = [];
  for (const m of text.matchAll(MODULE_SCRIPT)) {
    const id = resolveModuleId(m[1]);
    if (id) script.push(id);
  }
  for (const m of text.matchAll(AWS_CLI)) {
    const id = moduleOfCli(m[1]!, m[2]);
    if (id) cli.push(id);
  }
  return { script, cli };
}

/** 控制台深链 id（`s3.bucket`、`cloudfront.distribution`）→ 模块 id。 */
export function moduleOfConsoleLink(linkId: string): string | null {
  const head = linkId.split('.')[0] ?? '';
  return CLI_MODULE[head] ?? resolveModuleId(head);
}

function walk(n: MdNode | null | undefined, visit: (n: MdNode) => void): void {
  if (!n) return;
  visit(n);
  for (const c of n.children ?? []) walk(c, visit);
}

/** 与本步相关的模块 id（去重、按来源顺序，最多 max 个）。 */
export function stepModules(lab: LabDoc | null | undefined, step: LabStep, max = 6): string[] {
  if (!lab) return [];
  const out: string[] = [];
  const add = (id: string | null | undefined) => {
    const m = resolveModuleId(id ?? null);
    if (m && !out.includes(m)) out.push(m);
  };
  const lists = { script: [] as string[], cli: [] as string[], links: [] as string[] };
  const scan = (text: string | undefined) => {
    if (!text) return;
    const r = modulesInCommand(text);
    lists.script.push(...r.script);
    lists.cli.push(...r.cli);
  };
  walk(stepManual(lab, step)?.ast, (n) => {
    if (n.type === 'code' || n.type === 'inlineCode') scan(n.value);
    if (n.type === 'leafDirective' && n.name === 'console-link') {
      const link = n.attributes?.link;
      if (typeof link === 'string') lists.links.push(moduleOfConsoleLink(link) ?? '');
    }
  });
  const checks = (step.checks ?? []).map((ref) => lab.checks?.[checkLocalId(ref)]).filter((c): c is NonNullable<typeof c> => !!c);
  for (const c of checks) scan(c.reproduce?.run);

  for (const t of lab.targetModules ?? []) if (t.wireStep === step.id) add(t.id);
  add(step.experiment?.module);
  for (const id of lists.script) add(id);
  for (const c of checks) {
    add(c.module);
    if (c.service) add(moduleOfCli(c.service));
    if (c.target) add(c.target);
  }
  for (const id of lists.links) add(id);
  for (const id of lists.cli) add(id);
  for (const key of step.startsBilling?.pricingKeys ?? []) add(moduleOfConsoleLink(key));
  return out.slice(0, max);
}
