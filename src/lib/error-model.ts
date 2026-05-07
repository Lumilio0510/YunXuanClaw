export type AppErrorCode =
  | 'AUTH_INVALID'
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'PERMISSION'
  | 'CHANNEL_UNAVAILABLE'
  | 'NETWORK'
  | 'CONFIG'
  | 'GATEWAY'
  | 'UNKNOWN';

export class AppError extends Error {
  code: AppErrorCode;
  cause?: unknown;
  details?: Record<string, unknown>;
  retryable: boolean;

  constructor(
    code: AppErrorCode,
    message: string,
    cause?: unknown,
    details?: Record<string, unknown>,
    retryable?: boolean
  ) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.details = details;
    this.retryable = retryable ?? isRetryableCode(code);
  }
}

/**
 * Determine if an error code is retryable
 */
function isRetryableCode(code: AppErrorCode): boolean {
  return code === 'TIMEOUT' || code === 'NETWORK' || code === 'RATE_LIMIT' || code === 'GATEWAY';
}

export function mapBackendErrorCode(code?: string): AppErrorCode {
  switch (code) {
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'PERMISSION':
      return 'PERMISSION';
    case 'GATEWAY':
      return 'GATEWAY';
    case 'VALIDATION':
      return 'CONFIG';
    case 'UNSUPPORTED':
      return 'CHANNEL_UNAVAILABLE';
    default:
      return 'UNKNOWN';
  }
}

function classifyMessage(message: string): AppErrorCode {
  const lower = message.toLowerCase();

  if (
    lower.includes('invalid ipc channel')
    || lower.includes('no handler registered')
    || lower.includes('window is not defined')
    || lower.includes('unsupported')
  ) {
    return 'CHANNEL_UNAVAILABLE';
  }
  if (
    lower.includes('invalid authentication')
    || lower.includes('unauthorized')
    || lower.includes('auth failed')
    || lower.includes('401')
  ) {
    return 'AUTH_INVALID';
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('abort')) {
    return 'TIMEOUT';
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return 'RATE_LIMIT';
  }
  if (
    lower.includes('permission')
    || lower.includes('forbidden')
    || lower.includes('denied')
    || lower.includes('403')
  ) {
    return 'PERMISSION';
  }
  if (
    lower.includes('network')
    || lower.includes('fetch')
    || lower.includes('econnrefused')
    || lower.includes('econnreset')
    || lower.includes('enotfound')
  ) {
    return 'NETWORK';
  }
  if (lower.includes('gateway')) {
    return 'GATEWAY';
  }
  if (lower.includes('config') || lower.includes('invalid') || lower.includes('validation') || lower.includes('400')) {
    return 'CONFIG';
  }

  return 'UNKNOWN';
}

export function normalizeAppError(err: unknown, details?: Record<string, unknown>): AppError {
  if (err instanceof AppError) {
    return new AppError(err.code, err.message, err.cause ?? err, { ...(err.details ?? {}), ...(details ?? {}) }, err.retryable);
  }

  const message = err instanceof Error ? err.message : String(err);
  const code = classifyMessage(message);
  return new AppError(code, message, err, details);
}

/**
 * Get user-friendly error message
 */
export function getUserFriendlyErrorMessage(error: AppError): string {
  switch (error.code) {
    case 'AUTH_INVALID':
      return 'Authentication failed. Please check your API key or login session and try again.';
    case 'TIMEOUT':
      return 'Request timed out. Please check your network connection and retry.';
    case 'RATE_LIMIT':
      return 'Rate limit exceeded. Please wait a moment before trying again.';
    case 'PERMISSION':
      return 'Permission denied. Please check your access rights or contact support.';
    case 'CHANNEL_UNAVAILABLE':
      return 'The requested channel is unavailable. Please check your configuration.';
    case 'NETWORK':
      return 'Network error. Please check your internet connection and try again.';
    case 'CONFIG':
      return 'Configuration error. Please verify your settings.';
    case 'GATEWAY':
      return 'Gateway is unavailable. Please start or restart the gateway.';
    case 'UNKNOWN':
    default:
      return error.message || 'An unexpected error occurred. Please try again.';
  }
}

/**
 * Get suggested action for error
 */
export function getErrorAction(error: AppError): { label: string; action: 'retry' | 'settings' | 'gateway' | 'none' } {
  switch (error.code) {
    case 'TIMEOUT':
    case 'NETWORK':
    case 'RATE_LIMIT':
      return { label: 'Retry', action: 'retry' };
    case 'AUTH_INVALID':
    case 'CONFIG':
      return { label: 'Open Settings', action: 'settings' };
    case 'GATEWAY':
      return { label: 'Start Gateway', action: 'gateway' };
    default:
      return { label: '', action: 'none' };
  }
}
