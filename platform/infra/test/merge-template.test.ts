import { describe, expect, it } from 'vitest';
import { parseCfnYaml } from '../build/cfn-yaml.js';
import { mergeFragments } from '../build/merge-template.js';

describe('CloudFormation YAML fragments', () => {
  it('turns short tags into intrinsic functions', () => {
    const doc = parseCfnYaml(`
Resources:
  Table:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: !Sub 'atl-main'
      Arn: !GetAtt Other.Arn
      List: !GetAtt [Other, Arn]
      Cond: !If [IsOn, !Ref A, !Ref 'AWS::NoValue']
      Joined: !Join ['', ['a', !Ref B]]
      Mode: on
`);
    expect(doc.Resources).toEqual({
      Table: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: { 'Fn::Sub': 'atl-main' },
          Arn: { 'Fn::GetAtt': ['Other', 'Arn'] },
          List: { 'Fn::GetAtt': ['Other', 'Arn'] },
          Cond: { 'Fn::If': ['IsOn', { Ref: 'A' }, { Ref: 'AWS::NoValue' }] },
          Joined: { 'Fn::Join': ['', ['a', { Ref: 'B' }]] },
          Mode: 'on', // YAML 1.2: on/off stay strings
        },
      },
    });
  });

  it('merges sections in file order and rejects duplicates', () => {
    const { template, fragments } = mergeFragments(
      [
        { name: '10-data.yaml', text: 'Resources:\n  A: { Type: X }\nOutputs:\n  O: { Value: 1 }\n' },
        { name: '00-meta.yaml', text: 'Parameters:\n  LearnerEmail: { Type: String }\n' },
      ],
      '0.1.0',
    );
    expect(fragments).toEqual(['00-meta.yaml', '10-data.yaml']);
    expect(template).toMatchObject({
      AWSTemplateFormatVersion: '2010-09-09',
      Metadata: { AtlPlatformVersion: '0.1.0' },
      Parameters: { LearnerEmail: { Type: 'String' } },
      Resources: { A: { Type: 'X' } },
    });
    expect(() =>
      mergeFragments(
        [
          { name: '10-a.yaml', text: 'Resources:\n  A: { Type: X }\n' },
          { name: '20-b.yaml', text: 'Resources:\n  A: { Type: Y }\n' },
        ],
        '0.1.0',
      ),
    ).toThrow(/duplicate Resources.A/);
    expect(() => mergeFragments([{ name: '10-a.yaml', text: 'Bogus: {}\n' }], '0.1.0')).toThrow(/unknown top-level section/);
  });
});
