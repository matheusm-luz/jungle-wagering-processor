#!/usr/bin/env bash
# Runs inside LocalStack once it is ready (mounted at /etc/localstack/init/ready.d).
# Local emulator only: on AWS these resources would come from infrastructure as code, and the
# subscriber queue would also need a queue policy allowing the topic to send to it, which
# LocalStack does not enforce.
set -euo pipefail

queue_arn() {
  awslocal sqs get-queue-attributes --queue-url "$1" --attribute-names QueueArn \
    --query 'Attributes.QueueArn' --output text
}

# Inbound transactions. A message received 5 times without an ack moves to the DLQ (ADR-05).
dlq_url=$(awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true --query QueueUrl --output text)
dlq_arn=$(queue_arn "$dlq_url")

cat > /tmp/wager-transactions.json <<JSON
{
  "FifoQueue": "true",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${dlq_arn}\",\"maxReceiveCount\":\"5\"}"
}
JSON
awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes file:///tmp/wager-transactions.json

# Outbound events: SNS FIFO topic fanned out to SQS FIFO subscriptions with raw delivery (ADR-11).
# Content-based deduplication stays off: the publisher sends the event id as deduplication id.
topic_arn=$(awslocal sns create-topic --name wager-events.fifo \
  --attributes FifoTopic=true --query TopicArn --output text)
subscriber_url=$(awslocal sqs create-queue --queue-name wager-events-subscriber.fifo \
  --attributes FifoQueue=true --query QueueUrl --output text)
awslocal sns subscribe --topic-arn "$topic_arn" --protocol sqs \
  --notification-endpoint "$(queue_arn "$subscriber_url")" \
  --attributes RawMessageDelivery=true

echo "messaging resources ready"
