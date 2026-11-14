import { SNSClient } from '@aws-sdk/client-sns';
import type { Env } from '../../config/env';

export const SNS_CLIENT = Symbol('SNS_CLIENT');

/** Credentials come from the SDK's default provider chain, as for SQS. */
export function createSnsClient(env: Pick<Env, 'AWS_REGION' | 'AWS_ENDPOINT_URL'>): SNSClient {
  return new SNSClient({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
  });
}
