// [SUPPORT-QUEUE-1] Queues carry IDs, never content.
//
// Cloudflare Queues reject a message over 128 KB. We refuse anything over 16 KB
// long before that, so a producer that starts stuffing HTML, base64 attachments
// or a transcript into a queue message fails loudly in tests/dev instead of
// silently once a customer's receipt happens to be big.

export const QUEUE_MAX_BODY_BYTES = 16 * 1024;

export class QueueMessageTooLargeError extends Error {
  readonly bytes: number;
  constructor(bytes: number, limit: number) {
    super(`queue message is ${bytes} bytes (limit ${limit}); store the content and queue its id instead`);
    this.name = "QueueMessageTooLargeError";
    this.bytes = bytes;
  }
}

/** UTF-8 size of the JSON the queue would carry. */
export function queueBodyBytes(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body) ?? "").length;
}

/** `queue.send(body)` that throws QueueMessageTooLargeError when the JSON body is over 16 KB. */
export async function safeQueueSend(queue: Pick<Queue, "send">, body: unknown, opts?: QueueSendOptions): Promise<void> {
  const bytes = queueBodyBytes(body);
  if (bytes > QUEUE_MAX_BODY_BYTES) throw new QueueMessageTooLargeError(bytes, QUEUE_MAX_BODY_BYTES);
  if (opts) await queue.send(body, opts);
  else await queue.send(body);
}
