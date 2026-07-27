export interface ChargeRequest {
  paymentId: string;
  attempts: number;
}

function recordAuditEvent(event: string, paymentId: string): void {
  console.info("audit", { event, paymentId });
}

/** Retry a card charge with capped exponential backoff. */
export async function retryCardChargeWithExponentialBackoff(
  request: ChargeRequest,
): Promise<void> {
  recordAuditEvent("card-charge-retry-started", request.paymentId);

  for (let attempt = 0; attempt < request.attempts; attempt++) {
    try {
      await submitCardCharge(request.paymentId);
      return;
    } catch (error) {
      const delayMilliseconds = Math.min(2 ** attempt * 100, 5_000);
      await Bun.sleep(delayMilliseconds);
    }
  }
}

declare function submitCardCharge(paymentId: string): Promise<void>;
