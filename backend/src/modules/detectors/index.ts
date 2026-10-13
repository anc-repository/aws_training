// backend/src/modules/detectors/index.ts —— 感知器登记表
//
// 纯基础设施型模块与参数型模块的被动感知都在这里登记（总纲 3.3、§11）。CapabilityRegistry 的规则：
//   - ec2（base）的感知器始终运行，结果就是 ec2 的 status；
//   - 其他模块的感知器只在模块启用（开关取 AWS 值）时运行；未启用时 status=off、localHealth=ok。
// 本轮（MVP）登记 ec2、cdn、iam；其余感知器（network、dns、tls、waf、load-balancer、autoscaling、identity-pool、social-api、
// backup、shell-access、audit、threat-detection、compliance、vuln-scan、cost、ami）在后续版本按 detectors/<id>.ts 追加。
import { cdnDetector } from './cdn.js';
import { ec2Detector } from './ec2.js';
import { iamDetector } from './iam.js';
import type { DetectorFactory } from './types.js';

export const DETECTORS: readonly DetectorFactory[] = [ec2Detector, cdnDetector, iamDetector];

export type { Detector, DetectorContext, DetectorFactory } from './types.js';
