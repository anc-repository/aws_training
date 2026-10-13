/**
 * SDK operation → IAM action (04 §5.7). `labs:policy` turns the content's `service:action` pairs into the generated
 * `ATLVerifierRole` read-only policy with this map; every allowlisted operation must map (tested). The default is
 * `<service>:<Action>`; the listed exceptions follow the Service Authorization Reference (以官方文档为准).
 */
import { BASE_ALLOWLIST } from './allowlist.js';

export const IAM_ACTION_EXCEPTIONS: Readonly<Record<string, string | string[]>> = {
  's3:GetPublicAccessBlock': 's3:GetBucketPublicAccessBlock',
  's3control:GetPublicAccessBlock': 's3:GetAccountPublicAccessBlock',
  's3:GetBucketNotificationConfiguration': 's3:GetBucketNotification',
  's3:GetBucketEncryption': 's3:GetEncryptionConfiguration',
  's3:GetBucketLifecycleConfiguration': 's3:GetLifecycleConfiguration',
  's3:GetBucketReplication': 's3:GetReplicationConfiguration',
  's3:GetBucketCors': 's3:GetBucketCORS',
  's3:ListBuckets': 's3:ListAllMyBuckets',
  'budgets:DescribeBudgets': 'budgets:ViewBudget',
  'budgets:DescribeNotificationsForBudget': 'budgets:ViewBudget',
  'budgets:DescribeBudgetActionsForBudget': 'budgets:ViewBudget',
  'apigateway:GetApis': 'apigateway:GET',
  'apigateway:GetApi': 'apigateway:GET',
  'ses:GetAccount': 'ses:GetAccount',
  'cloudwatch:GetMetricData': 'cloudwatch:GetMetricData',
};

/** IAM resource hint for actions that are not resource-level wildcards (consumed by the policy generator). */
export const IAM_RESOURCE_HINTS: Readonly<Record<string, string[]>> = {
  'apigateway:GetApis': ['arn:aws:apigateway:${Region}::/apis'],
  'apigateway:GetApi': ['arn:aws:apigateway:${Region}::/apis/*'],
  'iam:GetInstanceProfile': ['arn:aws:iam::${AccountId}:instance-profile/CloudAlbum*', 'arn:aws:iam::${AccountId}:instance-profile/cloudalbum-*'],
  'iam:GetRole': ['arn:aws:iam::${AccountId}:role/CloudAlbum*', 'arn:aws:iam::${AccountId}:role/cloudalbum-*'],
  'iam:ListAttachedRolePolicies': ['arn:aws:iam::${AccountId}:role/CloudAlbum*', 'arn:aws:iam::${AccountId}:role/cloudalbum-*'],
  'iam:ListRolePolicies': ['arn:aws:iam::${AccountId}:role/CloudAlbum*', 'arn:aws:iam::${AccountId}:role/cloudalbum-*'],
  'iam:ListAccessKeys': ['arn:aws:iam::${AccountId}:user/cloudalbum/cloudalbum-*-demo-keys'],
};

export function iamActionsOf(service: string, action: string): string[] {
  const ex = IAM_ACTION_EXCEPTIONS[`${service}:${action}`];
  if (ex) return Array.isArray(ex) ? ex : [ex];
  return [`${service}:${action}`];
}

/** IAM actions of the whole allowlist (deduplicated, sorted). */
export function verifierIamActions(allowlist: Readonly<Record<string, readonly string[]>> = BASE_ALLOWLIST): string[] {
  const out = new Set<string>();
  for (const [s, actions] of Object.entries(allowlist)) for (const a of actions) for (const x of iamActionsOf(s, a)) out.add(x);
  return [...out].sort();
}
