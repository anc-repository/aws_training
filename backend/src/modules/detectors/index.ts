// backend/src/modules/detectors/index.ts —— 感知器登记表
//
// 纯基础设施型模块与参数型模块的被动感知都在这里登记（总纲 3.3、§11）。CapabilityRegistry 的规则：
//   - ec2（base）的感知器始终运行，结果就是 ec2 的 status；
//   - 其他模块的感知器只在模块启用（开关取 AWS 值）时运行；未启用时 status=off、localHealth=ok；
//   - 同一模块同时有适配器（端口）与感知器时，状态取适配器的 probe()（例如 waf 的 BlocklistPort），感知器只提供
//     observe() / observations()（运行期规则的输入）。
// MVP 登记 ec2、cdn、iam；第 1 波（wave1-prep）登记 dns、tls、waf、shell-access、cost（桩文件由各模块实现者填充）。
// 其余感知器（network、load-balancer、autoscaling、identity-pool、social-api、backup、audit、threat-detection、compliance、
// vuln-scan、ami）在后续版本按 detectors/<id>.ts 追加。
import { cdnDetector } from './cdn.js';
import { costDetector } from './cost.js';
import { dnsDetector } from './dns.js';
import { ec2Detector } from './ec2.js';
import { iamDetector } from './iam.js';
import { shellAccessDetector } from './shell-access.js';
import { tlsDetector } from './tls.js';
import type { DetectorFactory } from './types.js';
import { wafDetector } from './waf.js';

export const DETECTORS: readonly DetectorFactory[] = [
  ec2Detector, cdnDetector, iamDetector,
  dnsDetector, tlsDetector, wafDetector, shellAccessDetector, costDetector,
];

export type { Detector, DetectorContext, DetectorFactory } from './types.js';
