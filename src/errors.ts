/**
 * Errors the service raises on its own behalf, each carrying the HTTP status and a stable
 * machine-readable code. Route handlers map these to responses; anything that is not a
 * PaymasterError is treated as an unexpected failure and reported as 500 without leaking
 * its message to the caller.
 */

export class PaymasterError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly txHash?: string;

  constructor(message: string, status: number, code: string, retryable = false, txHash?: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    if (txHash !== undefined) this.txHash = txHash;
  }
}

export class ValidationError extends PaymasterError {
  constructor(message: string) {
    super(message, 400, "validation_error");
  }
}

export class UnauthorizedError extends PaymasterError {
  constructor(message: string) {
    super(message, 401, "unauthorized");
  }
}

export class NetworkMismatchError extends PaymasterError {
  constructor(message: string) {
    super(message, 400, "network_mismatch");
  }
}

export class RecipientNotReadyError extends PaymasterError {
  constructor(message: string) {
    super(message, 422, "recipient_not_ready");
  }
}

/**
 * The burn is real but Circle has not attested it yet. This is a normal, expected state
 * shortly after a burn, not a failure, so it is surfaced as retryable rather than as an
 * error the caller should stop on.
 */
export class AttestationPendingError extends PaymasterError {
  constructor(message: string) {
    super(message, 409, "attestation_pending", true);
  }
}

export class RateLimitedError extends PaymasterError {
  constructor(message: string) {
    super(message, 429, "rate_limited", true);
  }
}

/**
 * Another request for the same burn is already being submitted. Distinct from
 * AttestationPendingError because the caller is not waiting on Circle here, it is waiting
 * on this service's own in-flight submission.
 */
export class MintInProgressError extends PaymasterError {
  constructor(message: string) {
    super(message, 409, "mint_in_progress", true);
  }
}

export class SpendCapExceededError extends PaymasterError {
  constructor(message: string) {
    super(message, 429, "spend_cap_exceeded");
  }
}

export class BalanceHaltError extends PaymasterError {
  constructor(message: string) {
    super(message, 503, "insufficient_service_balance", true);
  }
}

/**
 * A direction this service knows how to complete, on a deployment that was not given the
 * account which pays for it. Deliberately not a validation error, since the request was
 * well formed and the caller did nothing wrong: the same request would be served by a
 * deployment holding a second funded key.
 */
export class DirectionUnavailableError extends PaymasterError {
  constructor(message: string) {
    super(message, 501, "direction_unavailable");
  }
}

export class UpstreamError extends PaymasterError {
  constructor(message: string, txHash?: string) {
    super(message, 502, "upstream_error", true, txHash);
  }
}
