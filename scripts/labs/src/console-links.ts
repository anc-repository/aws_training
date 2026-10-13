/**
 * Console deep-link registry ids (03 §5.4) that `::console-link{link=…}` and `platform.consoleLinks` may reference
 * (04 §3.5 A13, 05 §8.7 C-14). The registry itself (URL templates, parameter regexes) belongs to
 * `platform/api/contracts/console-links.ts` (03 §5.4); until that file exists this transcription of the 03 table is
 * the lint source. `params` are the template parameters other than `region`.
 */
export interface ConsoleLinkSpec {
  params: readonly string[];
}

export const CONSOLE_LINKS_03: Readonly<Record<string, ConsoleLinkSpec>> = {
  'ec2.instance': { params: ['instanceId'] },
  'ec2.securityGroup': { params: ['sgId'] },
  'iam.role': { params: ['roleName'] },
  'budgets.home': { params: [] },
  'ssm.sessions': { params: [] },
  'logs.group': { params: ['logGroupEncoded'] },
  's3.bucket': { params: ['bucket'] },
  'cloudfront.distribution': { params: ['distributionId'] },
  'cloudfront.createDistribution': { params: [] },
  'wafv2.webAcls': { params: [] },
  'cognito.userPool': { params: ['userPoolId'] },
  'sqs.queue': { params: ['queueUrlEncoded'] },
  'lambda.function': { params: ['functionName'] },
  'vpc.vpc': { params: ['vpcId'] },
  'rds.database': { params: ['dbId'] },
  'dynamodb.table': { params: ['table'] },
  'ec2.loadBalancers': { params: [] },
  'cloudtrail.events': { params: [] },
  'cloudshell.home': { params: [] },
};

export function isRegisteredConsoleLink(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONSOLE_LINKS_03, id);
}
