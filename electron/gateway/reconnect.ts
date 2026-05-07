/**
 * Gateway Reconnection Logic
 * Handles reconnection scheduling with exponential backoff
 */
import { logger } from '../utils/logger';
import {
  getReconnectScheduleDecision,
  getReconnectSkipReason,
  type ReconnectConfig,
} from './process-policy';
import { trackMetric } from '../utils/telemetry';

export type ReconnectContext = {
  shouldReconnect: boolean;
  reconnectAttempts: number;
  reconnectConfig: ReconnectConfig;
  lastRestartAt: number;
  getCurrentEpoch: () => number;
  setStatus: (update: { state: 'reconnecting'; reconnectAttempts: number }) => void;
  onReconnectAttempt: () => void;
  onReconnectSuccess: (attemptNo: number, maxAttempts: number, delayMs: number) => void;
  onReconnectFailure: (attemptNo: number, maxAttempts: number, delayMs: number, error: string) => void;
  executeStart: () => Promise<void>;
};

export class GatewayReconnector {
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private reconnectAttemptsTotal = 0;
  private reconnectSuccessTotal = 0;
  private isAutoReconnectStart = false;

  static readonly RESTART_COOLDOWN_MS = 5_000;

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  setReconnectAttempts(attempts: number): void {
    this.reconnectAttempts = attempts;
  }

  getReconnectTimer(): NodeJS.Timeout | null {
    return this.reconnectTimer;
  }

  isAutoReconnect(): boolean {
    return this.isAutoReconnectStart;
  }

  setAutoReconnect(value: boolean): void {
    this.isAutoReconnectStart = value;
  }

  resetAttempts(): void {
    this.reconnectAttempts = 0;
  }

  clearTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  shouldScheduleReconnect(ctx: ReconnectContext): boolean {
    return ctx.shouldReconnect && this.reconnectTimer === null;
  }

  schedule(ctx: ReconnectContext): void {
    const decision = getReconnectScheduleDecision({
      shouldReconnect: ctx.shouldReconnect,
      hasReconnectTimer: this.reconnectTimer !== null,
      reconnectAttempts: this.reconnectAttempts,
      maxAttempts: ctx.reconnectConfig.maxAttempts,
      baseDelay: ctx.reconnectConfig.baseDelay,
      maxDelay: ctx.reconnectConfig.maxDelay,
    });

    if (decision.action === 'skip') {
      logger.debug(`Gateway reconnect skipped (${decision.reason})`);
      return;
    }

    if (decision.action === 'already-scheduled') {
      return;
    }

    if (decision.action === 'fail') {
      logger.error(`Gateway reconnect failed: max attempts reached (${decision.maxAttempts})`);
      ctx.setStatus({
        state: 'reconnecting',
        reconnectAttempts: this.reconnectAttempts,
      });
      return;
    }

    const cooldownRemaining = Math.max(
      0,
      GatewayReconnector.RESTART_COOLDOWN_MS - (Date.now() - ctx.lastRestartAt)
    );
    const { delay, nextAttempt, maxAttempts } = decision;
    const effectiveDelay = Math.max(delay, cooldownRemaining);
    this.reconnectAttempts = nextAttempt;
    logger.warn(
      `Scheduling Gateway reconnect attempt ${nextAttempt}/${maxAttempts} in ${effectiveDelay}ms`
    );

    ctx.setStatus({
      state: 'reconnecting',
      reconnectAttempts: this.reconnectAttempts,
    });

    const scheduledEpoch = ctx.getCurrentEpoch();

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      const skipReason = getReconnectSkipReason({
        scheduledEpoch,
        currentEpoch: ctx.getCurrentEpoch(),
        shouldReconnect: ctx.shouldReconnect,
      });
      if (skipReason) {
        logger.debug(`Skipping reconnect attempt: ${skipReason}`);
        return;
      }

      const attemptNo = this.reconnectAttempts;
      this.reconnectAttemptsTotal += 1;

      try {
        this.isAutoReconnectStart = true;
        await ctx.executeStart();
        this.reconnectSuccessTotal += 1;
        this.emitReconnectMetric('success', {
          attemptNo,
          maxAttempts,
          delayMs: effectiveDelay,
        });
        this.reconnectAttempts = 0;
      } catch (error) {
        logger.error('Gateway reconnection attempt failed:', error);
        this.emitReconnectMetric('failure', {
          attemptNo,
          maxAttempts,
          delayMs: effectiveDelay,
          error: error instanceof Error ? error.message : String(error),
        });
        // Re-schedule with updated context
        ctx.onReconnectFailure(attemptNo, maxAttempts, effectiveDelay, error instanceof Error ? error.message : String(error));
      }
    }, effectiveDelay);
  }

  private emitReconnectMetric(
    outcome: 'success' | 'failure',
    payload: {
      attemptNo: number;
      maxAttempts: number;
      delayMs: number;
      error?: string;
    }
  ): void {
    const successRate =
      this.reconnectAttemptsTotal > 0
        ? this.reconnectSuccessTotal / this.reconnectAttemptsTotal
        : 0;

    const properties = {
      outcome,
      attemptNo: payload.attemptNo,
      maxAttempts: payload.maxAttempts,
      delayMs: payload.delayMs,
      gateway_reconnect_success_count: this.reconnectSuccessTotal,
      gateway_reconnect_attempt_count: this.reconnectAttemptsTotal,
      gateway_reconnect_success_rate: Number(successRate.toFixed(4)),
      ...(payload.error ? { error: payload.error } : {}),
    };

    trackMetric('gateway.reconnect', properties);
  }

  getMetrics(): {
    attemptsTotal: number;
    successTotal: number;
  } {
    return {
      attemptsTotal: this.reconnectAttemptsTotal,
      successTotal: this.reconnectSuccessTotal,
    };
  }
}
