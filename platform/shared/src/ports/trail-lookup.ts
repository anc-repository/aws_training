/** CloudTrail event history `LookupEvents` (no trail needed). Production: `@aws-sdk/client-cloudtrail`. Dev: injectable fake events. */
export type LookupAttributeKey =
  | 'EventId'
  | 'EventName'
  | 'ReadOnly'
  | 'Username'
  | 'ResourceType'
  | 'ResourceName'
  | 'EventSource'
  | 'AccessKeyId';

export interface TrailLookupRequest {
  /** Regional resources: their region; global services: us-east-1 (01 §3.12). */
  region: string;
  /** Exactly one lookup attribute per call (CloudTrail limitation). */
  attribute: { key: LookupAttributeKey; value: string };
  startTime: Date;
  endTime: Date;
  nextToken?: string;
  maxResults?: number;
}

export interface TrailEvent {
  eventId: string;
  eventName: string;
  eventTime: string;
  eventSource: string;
  region: string;
  username?: string;
  readOnly?: boolean;
  accessKeyId?: string;
  resources: { resourceType?: string; resourceName?: string }[];
  /** Raw `CloudTrailEvent` JSON (contains `errorCode`, `userIdentity.arn`, …). */
  cloudTrailEvent?: string;
}

export interface TrailLookupPort {
  lookupEvents(req: TrailLookupRequest): Promise<{ events: TrailEvent[]; nextToken?: string }>;
}
