/**
 * Derived resources (02 §7.4) that can be named from a known resource without extra API calls. Rules that need the
 * resource's live configuration (a NAT gateway's Elastic IP, an instance's data volumes, VPC Lambda ENIs, RDS
 * automated backups) are handled inside the production delete handlers, which see the configuration.
 */
import type { SessionResourceRecord } from '../../lifecycle/store/model.js';

export interface DerivedRef {
  type: string;
  id: string;
  region: string;
  name?: string | null;
}

export function deriveFrom(r: Pick<SessionResourceRecord, 'resourceType' | 'id' | 'name' | 'region' | 'meta'>): DerivedRef[] {
  switch (r.resourceType) {
    case 'AWS::Lambda::Function': {
      const fn = r.name ?? r.id.split(':').pop() ?? r.id;
      return [{ type: 'AWS::Logs::LogGroup', id: `/aws/lambda/${fn}`, region: r.region, name: `/aws/lambda/${fn}` }];
    }
    case 'AWS::CodeBuild::Project':
      return [{ type: 'AWS::Logs::LogGroup', id: `/aws/codebuild/${r.id}`, region: r.region }];
    case 'AWS::WAFv2::WebACL': {
      const logGroup = r.meta?.loggingLogGroup;
      return typeof logGroup === 'string' ? [{ type: 'AWS::Logs::LogGroup', id: logGroup, region: r.region }] : [];
    }
    default:
      return [];
  }
}
