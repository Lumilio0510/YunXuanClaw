/**
 * Retry utilities for handling transient errors
 */
import { AppError, normalizeAppError, getUserFriendlyErrorMessage } from './error-model';

export type RetryConfig = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry?: (error: AppError) => boolean;
  onRetry?: (attempt: number, error: AppError) => void;
};

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
};

/**
 * Calculate delay with exponential backoff
 */
function calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const delay = baseDelayMs * Math.pow(2, attempt - 1);
  return Math.min(delay, maxDelayMs);
}

/**
 * Retry a function with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const finalConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  const { maxAttempts, baseDelayMs, maxDelayMs, shouldRetry, onRetry } = finalConfig;

  let lastError: AppError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = normalizeAppError(err);

      const shouldRetryThis = shouldRetry ? shouldRetry(lastError) : lastError.retryable;

      if (!shouldRetryThis || attempt >= maxAttempts) {
        throw lastError;
      }

      const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs);

      if (onRetry) {
        onRetry(attempt, lastError);
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new AppError('UNKNOWN', 'Max retry attempts reached');
}

/**
 * Create a retry wrapper with pre-configured settings
 */
export function createRetryWrapper(config: Partial<RetryConfig>) {
  return <T>(fn: () => Promise<T>) => withRetry(fn, config);
}

/**
 * Retry wrapper for API calls with user notification
 */
export async function retryWithToast<T>(
  fn: () => Promise<T>,
  toastFn: (message: string, options?: { description?: string }) => void,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  return withRetry(fn, {
    ...config,
    onRetry: (attempt, error) => {
      const message = getUserFriendlyErrorMessage(error);
      toastFn(`Retrying (${attempt}/${config.maxAttempts ?? 3})...`, {
        description: message,
      });
    },
  });
}