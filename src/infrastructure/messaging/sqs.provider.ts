import { SQSClient } from '@aws-sdk/client-sqs';
import type { Env } from '../../config/env';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

/** Credentials come from the SDK's default provider chain: environment locally, a role on AWS. */
export function createSqsClient(env: Pick<Env, 'AWS_REGION' | 'AWS_ENDPOINT_URL'>): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
  });
}
