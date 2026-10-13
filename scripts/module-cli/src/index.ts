#!/usr/bin/env node
/**
 * scripts/module-cli —— `scripts/module` 的实现（总纲 §9.2）：bootstrap | enable | disable | status | plan | profile apply
 *
 * 运行在运维机（自己的电脑或 CloudShell），使用部署者身份；本地状态 .cloudalbum/state.json。
 * 退出码：0 成功；2 依赖 / 规则不满足；3 栈部署失败；4 迁移失败（已回滚）；5 健康探针失败（已回滚）。
 *
 * 脚手架桩：命令已登记，实现由「infra 与工具实现者」填充。注册表数据从 @cloudalbum/contracts/registry 读取；
 * 计划校验复用 backend 的规则引擎（node backend/dist/cli.js check-config --env-dir <暂存目录> --plan）。
 */
import { Command } from 'commander';

export const EXIT = { ok: 0, rules: 2, stack: 3, migration: 4, health: 5 } as const;

export function buildProgram(): Command {
  const program = new Command('scripts/module').description('CloudAlbum 模块启停工具（scripts/module）');
  const todo = (name: string) => () => {
    console.error(`scripts/module ${name}：尚未实现（脚手架桩）`);
    process.exitCode = EXIT.rules;
  };
  program.command('bootstrap').description('创建工具链栈 cloudalbum-<env>-toolchain').action(todo('bootstrap'));
  program.command('enable <id>').description('启用模块（部署栈 → 写 modules.d → 重启 → 探针）').action(todo('enable'));
  program.command('disable <id>').description('禁用模块（迁回数据 → 删除 env → 删除栈）').action(todo('disable'));
  program.command('status [id]').description('模块状态（--repair 修复半启用 CFG-004）').action(todo('status'));
  program.command('plan <id>').description('只做计划校验（暂存 env + check-config --plan + preflight）').action(todo('plan'));
  const profile = program.command('profile').description('预设档位');
  profile.command('apply <name>').description('应用档位（逆拓扑禁用多余模块，再拓扑启用缺少的模块）').action(todo('profile apply'));
  return program;
}

if (process.argv[1] && /module-cli[\\/](src|dist)[\\/]index\.(ts|js)$/.test(process.argv[1])) {
  await buildProgram().parseAsync(process.argv);
}
