/** Errors the publishing stage raises. All carry enough detail for the UI to act. */

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** True when retrying the identical request could plausibly succeed. */
    readonly retryable = false,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

/**
 * The connector cannot do this on this platform. Not a failure — the caller
 * falls through to Cloudflare, or to a manual instruction card.
 */
export class UnsupportedOperation extends ConnectorError {
  constructor(
    readonly method: string,
    readonly platform: string,
    reason: string,
  ) {
    super(`${platform} cannot ${method}: ${reason}`, 'UNSUPPORTED', false, { method, platform });
    this.name = 'UnsupportedOperation';
  }
}

/** Credentials are wrong, expired, or stripped in transit. */
export class AuthError extends ConnectorError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super(message, 'AUTH', false, detail);
    this.name = 'AuthError';
  }
}

/**
 * Applying would damage the site — e.g. writing body content that is really
 * page-builder data. Always refuse rather than proceed.
 */
export class UnsafeWrite extends ConnectorError {
  constructor(message: string, detail?: Record<string, unknown>) {
    super(message, 'UNSAFE_WRITE', false, detail);
    this.name = 'UnsafeWrite';
  }
}
