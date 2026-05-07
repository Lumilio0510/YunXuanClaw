/**
 * Gateway Process Manager
 * Manages the OpenClaw Gateway process lifecycle
 *
 * This is the main orchestrator that coordinates:
 * - Process lifecycle (spawn, terminate)
 * - WebSocket connection handling
 * - Reconnection with exponential backoff
 * - State management and events
 */
import { app } from 'electron';
import path from 'path';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { PORTS } from '../utils/config';
import { JsonRpcNotification, isNotification, isResponse } from './protocol';
import { logger } from '../utils/logger';
import { captureTelemetryEvent, trackMetric } from '../utils/telemetry';
import {
  loadOrCreateDeviceIdentity,
  type DeviceIdentity,
} from '../utils/device-identity';
import {
  DEFAULT_RECONNECT_CONFIG,
  type ReconnectConfig,
  type GatewayLifecycleState,
} from './process-policy';
import {
  clearPendingGatewayRequests,
  rejectPendingGatewayRequest,
  resolvePendingGatewayRequest,
  type PendingGatewayRequest,
} from './request-store';
import { dispatchJsonRpcNotification, dispatchProtocolEvent } from './event-dispatch';
import { GatewayStateController } from './state';
import { prepareGatewayLaunchContext } from './config-sync';
import { connectGatewaySocket, waitForGatewayReady } from './ws-client';
import {
  findExistingGatewayProcess,
  runOpenClawDoctorRepair,
  waitForPortFree,
  warmupManagedPythonReadiness,
  unloadLaunchctlGatewayService,
} from './supervisor';
import { GatewayConnectionMonitor } from './connection-monitor';
import { GatewayLifecycleController, LifecycleSupersededError } from './lifecycle-controller';
import { launchGatewayProcess } from './process-launcher';
import { GatewayRestartController } from './restart-controller';
import { GatewayRestartGovernor } from './restart-governor';
import {
  DEFAULT_GATEWAY_RELOAD_POLICY,
  loadGatewayReloadPolicy,
  type GatewayReloadPolicy,
} from './reload-policy';
import { classifyGatewayStderrMessage, recordGatewayStartupStderrLine } from './startup-stderr';
import { runGatewayStartupSequence } from './startup-orchestrator';

// Import refactored modules
import { GatewayProcessManager } from './process-manager';
import { GatewayWebSocketHandler } from './websocket-handler';
import { GatewayReconnector } from './reconnect';

export interface GatewayStatus {
  state: GatewayLifecycleState;
  port: number;
  pid?: number;
  uptime?: number;
  error?: string;
  connectedAt?: number;
  version?: string;
  reconnectAttempts?: number;
}

/**
 * Gateway Manager Events
 */
export interface GatewayManagerEvents {
  status: (status: GatewayStatus) => void;
  message: (message: unknown) => void;
  notification: (notification: JsonRpcNotification) => void;
  exit: (code: number | null) => void;
  error: (error: Error) => void;
  'channel:status': (data: { channelId: string; status: string }) => void;
  'chat:message': (data: { message: unknown }) => void;
}

/**
 * Gateway Manager
 * Handles starting, stopping, and communicating with the OpenClaw Gateway
 */
export class GatewayManager extends EventEmitter {
  // Process management
  private readonly processManager = new GatewayProcessManager();
  private readonly wsHandler = new GatewayWebSocketHandler();
  private readonly reconnector = new GatewayReconnector();

  // State controllers
  private status: GatewayStatus = { state: 'stopped', port: PORTS.OPENCLAW_GATEWAY };
  private readonly stateController: GatewayStateController;
  private readonly lifecycleController = new GatewayLifecycleController();
  private readonly restartController = new GatewayRestartController();
  private readonly restartGovernor = new GatewayRestartGovernor();
  private readonly connectionMonitor = new GatewayConnectionMonitor();

  // Configuration
  private reconnectConfig: ReconnectConfig;
  private shouldReconnect = true;
  private startLock = false;
  private deviceIdentity: DeviceIdentity | null = null;
  private restartInFlight: Promise<void> | null = null;
  private reloadDebounceTimer: NodeJS.Timeout | null = null;
  private reloadPolicy: GatewayReloadPolicy = { ...DEFAULT_GATEWAY_RELOAD_POLICY };
  private reloadPolicyLoadedAt = 0;
  private reloadPolicyRefreshPromise: Promise<void> | null = null;
  private externalShutdownSupported: boolean | null = null;
  private lastRestartAt = 0;

  // Pending requests
  private pendingRequests: Map<string, PendingGatewayRequest> = new Map();

  private static readonly RELOAD_POLICY_REFRESH_MS = 15_000;
  public static readonly RESTART_COOLDOWN_MS = 5_000;

  constructor(config?: Partial<ReconnectConfig>) {
    super();
    this.stateController = new GatewayStateController({
      emitStatus: (status) => {
        this.status = status;
        this.emit('status', status);
      },
      onTransition: (previousState, nextState) => {
        if (nextState === 'running') {
          this.restartGovernor.onRunning();
        }
        this.restartController.flushDeferredRestart(
          `status:${previousState}->${nextState}`,
          {
            state: this.status.state,
            startLock: this.startLock,
            shouldReconnect: this.shouldReconnect,
          },
          () => {
            void this.restart().catch((error) => {
              logger.warn('Deferred Gateway restart failed:', error);
            });
          }
        );
      },
    });
    this.reconnectConfig = { ...DEFAULT_RECONNECT_CONFIG, ...config };
  }

  private async initDeviceIdentity(): Promise<void> {
    if (this.deviceIdentity) return;
    try {
      const identityPath = path.join(app.getPath('userData'), 'clawx-device-identity.json');
      this.deviceIdentity = await loadOrCreateDeviceIdentity(identityPath);
      logger.debug(`Device identity loaded (deviceId=${this.deviceIdentity.deviceId})`);
    } catch (err) {
      logger.warn('Failed to load device identity, scopes will be limited:', err);
    }
  }

  private sanitizeSpawnArgs(args: string[]): string[] {
    const sanitized = [...args];
    const tokenIdx = sanitized.indexOf('--token');
    if (tokenIdx !== -1 && tokenIdx + 1 < sanitized.length) {
      sanitized[tokenIdx + 1] = '[redacted]';
    }
    return sanitized;
  }

  private isUnsupportedShutdownError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /unknown method:\s*shutdown/i.test(message);
  }

  /**
   * Get current Gateway status
   */
  getStatus(): GatewayStatus {
    return this.stateController.getStatus();
  }

  /**
   * Check if Gateway is connected and ready
   */
  isConnected(): boolean {
    return this.stateController.isConnected(this.wsHandler.isConnected());
  }

  /**
   * Start Gateway process
   */
  async start(): Promise<void> {
    if (this.startLock) {
      logger.debug('Gateway start ignored because a start flow is already in progress');
      return;
    }

    if (this.status.state === 'running') {
      logger.debug('Gateway already running, skipping start');
      return;
    }

    this.startLock = true;
    const startEpoch = this.lifecycleController.bump('start');
    logger.info(`Gateway start requested (port=${this.status.port})`);
    this.shouldReconnect = true;
    await this.refreshReloadPolicy(true);

    await this.initDeviceIdentity();

    if (this.reconnector.getReconnectTimer()) {
      this.reconnector.clearTimer();
      logger.debug('Cleared pending reconnect timer because start was requested manually');
    }

    if (!this.reconnector.isAutoReconnect()) {
      this.reconnector.resetAttempts();
    }
    this.reconnector.setAutoReconnect(false);
    this.setStatus({ state: 'starting', reconnectAttempts: this.reconnector.getReconnectAttempts() });

    warmupManagedPythonReadiness();

    try {
      await runGatewayStartupSequence({
        port: this.status.port,
        ownedPid: this.processManager.getPid(),
        shouldWaitForPortFree: process.platform === 'win32',
        hasOwnedProcess: () => this.processManager.getPid() != null && this.processManager.ownsProcessCheck(),
        resetStartupStderrLines: () => {
          this.processManager.resetStderrLines();
        },
        getStartupStderrLines: () => this.processManager.getRecentStderrLines(),
        assertLifecycle: (phase) => {
          this.lifecycleController.assert(startEpoch, phase);
        },
        findExistingGateway: async (port) => {
          return await findExistingGatewayProcess({ port, ownedPid: this.processManager.getPid() });
        },
        connect: async (port, externalToken) => {
          await this.connect(port, externalToken);
        },
        onConnectedToExistingGateway: () => {
          const isOwnProcess = this.processManager.getPid() != null && this.processManager.ownsProcessCheck();
          if (!isOwnProcess) {
            this.processManager.setOwnsProcess(false);
            this.setStatus({ pid: undefined });
          }

          if (isOwnProcess) {
            this.restartController.recordRestartCompleted();
          }

          this.startHealthCheck();
        },
        waitForPortFree: async (port) => {
          await waitForPortFree(port);
        },
        startProcess: async () => {
          await this.startProcess();
        },
        waitForReady: async (port) => {
          await waitForGatewayReady({
            port,
            getProcessExitCode: () => this.processManager.getExitCode(),
          });
        },
        onConnectedToManagedGateway: () => {
          this.startHealthCheck();
          logger.debug('Gateway started successfully');
        },
        runDoctorRepair: async () => await runOpenClawDoctorRepair(),
        onDoctorRepairSuccess: () => {
          this.setStatus({ state: 'starting', error: undefined, reconnectAttempts: 0 });
        },
        delay: async (ms) => {
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
      });
    } catch (error) {
      if (error instanceof LifecycleSupersededError) {
        logger.debug(error.message);
        return;
      }
      logger.error(
        `Gateway start failed (port=${this.status.port}, reconnectAttempts=${this.reconnector.getReconnectAttempts()}, spawn=${this.processManager.getLastSpawnSummary() ?? 'n/a'})`,
        error
      );
      this.setStatus({ state: 'error', error: String(error) });
      throw error;
    } finally {
      this.startLock = false;
      this.restartController.flushDeferredRestart(
        'start:finally',
        {
          state: this.status.state,
          startLock: this.startLock,
          shouldReconnect: this.shouldReconnect,
        },
        () => {
          void this.restart().catch((error) => {
            logger.warn('Deferred Gateway restart failed:', error);
          });
        }
      );
    }
  }

  /**
   * Stop Gateway process
   */
  async stop(): Promise<void> {
    logger.info('Gateway stop requested');
    this.lifecycleController.bump('stop');
    this.shouldReconnect = false;

    this.clearAllTimers();

    if (!this.processManager.ownsProcessCheck() && this.wsHandler.isConnected() && this.externalShutdownSupported !== false) {
      try {
        await this.rpc('shutdown', undefined, 5000);
        this.externalShutdownSupported = true;
      } catch (error) {
        if (this.isUnsupportedShutdownError(error)) {
          this.externalShutdownSupported = false;
          logger.info('External Gateway does not support "shutdown"; skipping shutdown RPC for future stops');
        } else {
          logger.warn('Failed to request shutdown for externally managed Gateway:', error);
        }
      }
    }

    this.wsHandler.terminate();

    if (this.processManager.ownsProcessCheck()) {
      await this.processManager.terminate();
    }

    clearPendingGatewayRequests(this.pendingRequests, new Error('Gateway stopped'));

    this.restartController.resetDeferredRestart();
    this.reconnector.setAutoReconnect(false);
    this.setStatus({ state: 'stopped', error: undefined, pid: undefined, connectedAt: undefined, uptime: undefined });
  }

  /**
   * Best-effort emergency cleanup for app-quit timeout paths.
   */
  async forceTerminateOwnedProcessForQuit(): Promise<boolean> {
    return await this.processManager.terminate();
  }

  /**
   * Restart Gateway process
   */
  async restart(): Promise<void> {
    if (this.restartController.isRestartDeferred({
      state: this.status.state,
      startLock: this.startLock,
    })) {
      this.restartController.markDeferredRestart('restart', {
        state: this.status.state,
        startLock: this.startLock,
      });
      return;
    }

    if (this.restartInFlight) {
      logger.debug('Gateway restart already in progress, joining existing request');
      await this.restartInFlight;
      return;
    }

    const decision = this.restartGovernor.decide();
    if (!decision.allow) {
      const observability = this.restartGovernor.getObservability();
      logger.warn(
        `[gateway-restart-governor] restart suppressed reason=${decision.reason} retryAfterMs=${decision.retryAfterMs} ` +
        `suppressed=${observability.suppressed_total} executed=${observability.executed_total} circuitOpenUntil=${observability.circuit_open_until}`
      );
      const props = {
        reason: decision.reason,
        retry_after_ms: decision.retryAfterMs,
        gateway_restart_suppressed_total: observability.suppressed_total,
        gateway_restart_executed_total: observability.executed_total,
        gateway_restart_circuit_open_until: observability.circuit_open_until,
      };
      trackMetric('gateway.restart.suppressed', props);
      captureTelemetryEvent('gateway_restart_suppressed', props);
      return;
    }

    const pidBefore = this.status.pid;
    logger.info(`[gateway-refresh] mode=restart requested pidBefore=${pidBefore ?? 'n/a'}`);
    this.restartInFlight = (async () => {
      await this.stop();
      try {
        await this.start();
      } catch (err) {
        logger.warn('Gateway restart: start() failed after stop(), enabling auto-reconnect recovery', err);
        this.shouldReconnect = true;
        this.scheduleReconnect();
        throw err;
      }
    })();

    try {
      await this.restartInFlight;
      this.restartGovernor.recordExecuted();
      this.restartController.recordRestartCompleted();
      const observability = this.restartGovernor.getObservability();
      const props = {
        gateway_restart_executed_total: observability.executed_total,
        gateway_restart_suppressed_total: observability.suppressed_total,
        gateway_restart_circuit_open_until: observability.circuit_open_until,
      };
      trackMetric('gateway.restart.executed', props);
      captureTelemetryEvent('gateway_restart_executed', props);
      logger.info(
        `[gateway-refresh] mode=restart result=applied pidBefore=${pidBefore ?? 'n/a'} pidAfter=${this.status.pid ?? 'n/a'} ` +
        `suppressed=${observability.suppressed_total} executed=${observability.executed_total} circuitOpenUntil=${observability.circuit_open_until}`
      );
    } finally {
      this.restartInFlight = null;
      this.restartController.flushDeferredRestart(
        'restart:finally',
        {
          state: this.status.state,
          startLock: this.startLock,
          shouldReconnect: this.shouldReconnect,
        },
        () => {
          void this.restart().catch((error) => {
            logger.warn('Deferred Gateway restart failed:', error);
          });
        }
      );
    }
  }

  /**
   * Debounced restart
   */
  debouncedRestart(delayMs = 2000): void {
    this.restartController.debouncedRestart(delayMs, () => {
      void this.restart().catch((err) => {
        logger.warn('Debounced Gateway restart failed:', err);
      });
    });
  }

  /**
   * Ask the Gateway process to reload config in-place
   */
  async reload(): Promise<void> {
    await this.refreshReloadPolicy();

    if (this.reloadPolicy.mode === 'off' || this.reloadPolicy.mode === 'restart') {
      logger.info(
        `[gateway-refresh] mode=reload result=policy_forced_restart policy=${this.reloadPolicy.mode}`
      );
      await this.restart();
      return;
    }

    if (this.restartController.isRestartDeferred({
      state: this.status.state,
      startLock: this.startLock,
    })) {
      this.restartController.markDeferredRestart('reload', {
        state: this.status.state,
        startLock: this.startLock,
      });
      return;
    }

    const pidBefore = this.processManager.getPid();
    logger.info(`[gateway-refresh] mode=reload requested pid=${pidBefore ?? 'n/a'} state=${this.status.state}`);

    if (!this.processManager.getPid() || this.status.state !== 'running') {
      logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=not_running');
      await this.restart();
      return;
    }

    const connectedForMs = this.status.connectedAt
      ? Date.now() - this.status.connectedAt
      : Number.POSITIVE_INFINITY;

    if (connectedForMs < 8000) {
      logger.info(
        `[gateway-refresh] mode=reload result=skipped_recent_connect connectedForMs=${connectedForMs} pid=${this.processManager.getPid()}`
      );
      return;
    }

    if (process.platform === 'win32') {
      logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=windows');
      await this.restart();
      return;
    }

    try {
      const pid = this.processManager.getPid();
      if (pid) {
        process.kill(pid, 'SIGUSR1');
        logger.info(`Sent SIGUSR1 to Gateway for config reload (pid=${pid})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (this.status.state !== 'running' || !this.processManager.getPid()) {
        logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=post_signal_unhealthy');
        await this.restart();
      } else {
        const pidAfter = this.processManager.getPid();
        logger.info(
          `[gateway-refresh] mode=reload result=applied_in_place pidBefore=${pidBefore} pidAfter=${pidAfter}`
        );
      }
    } catch {
      logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=signal_error');
      await this.restart();
    }
  }

  /**
   * Debounced reload
   */
  debouncedReload(delayMs?: number): void {
    void this.refreshReloadPolicy();
    const effectiveDelay = delayMs ?? this.reloadPolicy.debounceMs;
    if (this.reloadPolicy.mode === 'off' || this.reloadPolicy.mode === 'restart') {
      this.debouncedRestart(effectiveDelay);
      return;
    }

    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
    }
    this.reloadDebounceTimer = setTimeout(() => {
      this.reloadDebounceTimer = null;
      void this.reload().catch((err) => {
        logger.warn('Debounced Gateway reload failed:', err);
      });
    }, effectiveDelay);
  }

  private async refreshReloadPolicy(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.reloadPolicyLoadedAt < GatewayManager.RELOAD_POLICY_REFRESH_MS) {
      return;
    }

    if (this.reloadPolicyRefreshPromise) {
      await this.reloadPolicyRefreshPromise;
      return;
    }

    this.reloadPolicyRefreshPromise = (async () => {
      const nextPolicy = await loadGatewayReloadPolicy();
      this.reloadPolicy = nextPolicy;
      this.reloadPolicyLoadedAt = Date.now();
    })();

    try {
      await this.reloadPolicyRefreshPromise;
    } finally {
      this.reloadPolicyRefreshPromise = null;
    }
  }

  private clearAllTimers(): void {
    this.reconnector.clearTimer();
    this.connectionMonitor.clear();
    this.restartController.clearDebounceTimer();
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
  }

  /**
   * Make an RPC call to the Gateway
   */
  async rpc<T>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    return new Promise((resolve, reject) => {
      const ws = this.wsHandler.getWebSocket();
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Gateway not connected'));
        return;
      }

      const id = crypto.randomUUID();

      const timeout = setTimeout(() => {
        rejectPendingGatewayRequest(this.pendingRequests, id, new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      const request = {
        type: 'req',
        id,
        method,
        params,
      };

      try {
        ws.send(JSON.stringify(request));
      } catch (error) {
        rejectPendingGatewayRequest(this.pendingRequests, id, new Error(`Failed to send RPC request: ${error}`));
      }
    });
  }

  private startHealthCheck(): void {
    this.connectionMonitor.startHealthCheck({
      shouldCheck: () => this.status.state === 'running',
      checkHealth: () => this.checkHealth(),
      onUnhealthy: (errorMessage) => {
        this.emit('error', new Error(errorMessage));
      },
      onError: () => {},
    });
  }

  async checkHealth(): Promise<{ ok: boolean; error?: string; uptime?: number }> {
    try {
      if (this.wsHandler.isConnected()) {
        const uptime = this.status.connectedAt
          ? Math.floor((Date.now() - this.status.connectedAt) / 1000)
          : undefined;
        return { ok: true, uptime };
      }
      return { ok: false, error: 'WebSocket not connected' };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  private async startProcess(): Promise<void> {
    const launchContext = await prepareGatewayLaunchContext(this.status.port);
    await unloadLaunchctlGatewayService();

    const stderrDedup = new Map<string, number>();
    const recentStderrLines: string[] = [];

    const { child } = await launchGatewayProcess({
      port: this.status.port,
      launchContext,
      sanitizeSpawnArgs: (args) => this.sanitizeSpawnArgs(args),
      getCurrentState: () => this.status.state,
      getShouldReconnect: () => this.shouldReconnect,
      onStderrLine: (line) => {
        recordGatewayStartupStderrLine(recentStderrLines, line);
        const classified = classifyGatewayStderrMessage(line);
        if (classified.level === 'drop') return;

        const count = (stderrDedup.get(classified.normalized) ?? 0) + 1;
        stderrDedup.set(classified.normalized, count);
        if (count > 1) {
          if (count % 50 === 0) {
            logger.debug(`[Gateway stderr] (suppressed ${count} repeats) ${classified.normalized}`);
          }
          return;
        }

        if (classified.level === 'debug') {
          logger.debug(`[Gateway stderr] ${classified.normalized}`);
          return;
        }
        logger.warn(`[Gateway stderr] ${classified.normalized}`);
      },
      onSpawn: (pid) => {
        this.setStatus({ pid });
      },
      onExit: (exitedChild, code) => {
        this.processManager.setOwnsProcess(false);
        this.connectionMonitor.clear();
        this.emit('exit', code);

        if (this.status.state === 'running') {
          this.setStatus({ state: 'stopped' });
        }

        this.scheduleReconnect();
      },
      onError: () => {
        this.processManager.setOwnsProcess(false);
      },
    });

    // Store process reference internally for compatibility
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.processManager as any).process = child;
    this.processManager.setOwnsProcess(true);
    logger.debug(`Gateway manager now owns process pid=${child.pid ?? 'unknown'}`);
  }

  private async connect(port: number, _externalToken?: string): Promise<void> {
    const ws = await connectGatewaySocket({
      port,
      deviceIdentity: this.deviceIdentity,
      platform: process.platform,
      pendingRequests: this.pendingRequests,
      getToken: async () => await import('../utils/store').then(({ getSetting }) => getSetting('gatewayToken')),
      onHandshakeComplete: (ws) => {
        this.wsHandler.setWebSocket(ws);
        ws.on('pong', () => {
          this.connectionMonitor.markAlive('pong');
        });
        this.setStatus({
          state: 'running',
          port,
          connectedAt: Date.now(),
        });
        this.startPing();
      },
      onMessage: (message) => {
        this.handleMessage(message);
      },
      onCloseAfterHandshake: (closeCode) => {
        this.connectionMonitor.clear();
        if (this.status.state === 'running') {
          this.setStatus({ state: 'stopped' });
          if (process.platform !== 'win32' || closeCode === 1012) {
            this.scheduleReconnect();
          }
        }
      },
    });

    this.wsHandler.setWebSocket(ws);
  }

  private handleMessage(message: unknown): void {
    this.connectionMonitor.markAlive('message');

    if (typeof message !== 'object' || message === null) {
      logger.debug('Received non-object Gateway message');
      return;
    }

    const msg = message as Record<string, unknown>;

    if (msg.type === 'res' && typeof msg.id === 'string') {
      if (msg.ok === false || msg.error) {
        const errorObj = msg.error as { message?: string; code?: number } | undefined;
        const errorMsg = errorObj?.message || JSON.stringify(msg.error) || 'Unknown error';
        if (rejectPendingGatewayRequest(this.pendingRequests, msg.id, new Error(errorMsg))) {
          return;
        }
      } else if (resolvePendingGatewayRequest(this.pendingRequests, msg.id, msg.payload ?? msg)) {
        return;
      }
    }

    if (msg.type === 'event' && typeof msg.event === 'string') {
      dispatchProtocolEvent(this, msg.event, msg.payload);
      return;
    }

    if (isResponse(message) && message.id && this.pendingRequests.has(String(message.id))) {
      if (message.error) {
        const errorMsg = typeof message.error === 'object'
          ? (message.error as { message?: string }).message || JSON.stringify(message.error)
          : String(message.error);
        rejectPendingGatewayRequest(this.pendingRequests, String(message.id), new Error(errorMsg));
      } else {
        resolvePendingGatewayRequest(this.pendingRequests, String(message.id), message.result);
      }
      return;
    }

    if (isNotification(message)) {
      dispatchJsonRpcNotification(this, message);
      return;
    }

    this.emit('message', message);
  }

  private startPing(): void {
    const isWindows = process.platform === 'win32';
    this.connectionMonitor.startPing({
      intervalMs: isWindows ? 60_000 : 30_000,
      timeoutMs: isWindows ? 25_000 : 12_000,
      maxConsecutiveMisses: isWindows ? 5 : 3,
      sendPing: () => {
        const ws = this.wsHandler.getWebSocket();
        if (ws?.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      },
      onHeartbeatTimeout: ({ consecutiveMisses, timeoutMs }) => {
        const pid = this.processManager.getPid() ?? 'unknown';
        logger.warn(
          `Gateway heartbeat: ${consecutiveMisses} consecutive pong misses ` +
          `(timeout=${timeoutMs}ms, pid=${pid}, state=${this.status.state}). ` +
          `No action taken — relying on process exit and socket close events.`
        );
      },
    });
  }

  private scheduleReconnect(): void {
    const decision = this.reconnector.shouldScheduleReconnect({
      shouldReconnect: this.shouldReconnect,
      reconnectAttempts: this.reconnector.getReconnectAttempts(),
      reconnectConfig: this.reconnectConfig,
      lastRestartAt: this.lastRestartAt,
      getCurrentEpoch: () => this.lifecycleController.getCurrentEpoch(),
      setStatus: (update) => this.setStatus(update),
      onReconnectAttempt: () => {},
      onReconnectSuccess: () => {},
      onReconnectFailure: () => {},
      executeStart: async () => await this.start(),
    });

    if (!decision) return;

    this.reconnector.schedule({
      shouldReconnect: this.shouldReconnect,
      reconnectAttempts: this.reconnector.getReconnectAttempts(),
      reconnectConfig: this.reconnectConfig,
      lastRestartAt: this.lastRestartAt,
      getCurrentEpoch: () => this.lifecycleController.getCurrentEpoch(),
      setStatus: (update) => this.setStatus(update),
      onReconnectAttempt: () => {},
      onReconnectSuccess: () => {
        this.reconnector.setAutoReconnect(false);
      },
      onReconnectFailure: () => {
        this.scheduleReconnect();
      },
      executeStart: async () => await this.start(),
    });
  }

  private setStatus(update: Partial<GatewayStatus>): void {
    this.stateController.setStatus(update);
  }
}
