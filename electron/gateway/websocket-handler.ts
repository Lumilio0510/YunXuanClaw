/**
 * Gateway WebSocket Connection Handler
 * Handles WebSocket connection, message routing, and ping/pong lifecycle
 */
import WebSocket from 'ws';
import { logger } from '../utils/logger';
import { JsonRpcNotification, isNotification, isResponse } from './protocol';
import {
  resolvePendingGatewayRequest,
  rejectPendingGatewayRequest,
  type PendingGatewayRequest,
} from './request-store';
import { dispatchJsonRpcNotification, dispatchProtocolEvent } from './event-dispatch';
import { GatewayConnectionMonitor } from './connection-monitor';

export type WebSocketMessageHandler = (message: unknown) => void;

export type WebSocketConnectionOptions = {
  port: number;
  ws: WebSocket;
  pendingRequests: Map<string, PendingGatewayRequest>;
  connectionMonitor: GatewayConnectionMonitor;
  onMessage: WebSocketMessageHandler;
  onCloseAfterHandshake: (closeCode: number) => void;
  setStatusRunning: (port: number) => void;
  startPing: () => void;
};

export class GatewayWebSocketHandler {
  private ws: WebSocket | null = null;
  private readonly connectionMonitor = new GatewayConnectionMonitor();

  // Platform-specific heartbeat parameters
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;
  private static readonly HEARTBEAT_TIMEOUT_MS = 12_000;
  private static readonly HEARTBEAT_MAX_MISSES = 3;
  private static readonly HEARTBEAT_INTERVAL_MS_WIN = 60_000;
  private static readonly HEARTBEAT_TIMEOUT_MS_WIN = 25_000;
  private static readonly HEARTBEAT_MAX_MISSES_WIN = 5;

  setWebSocket(ws: WebSocket | null): void {
    this.ws = ws;
  }

  getWebSocket(): WebSocket | null {
    return this.ws;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  terminate(): void {
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  handleMessage(
    message: unknown,
    pendingRequests: Map<string, PendingGatewayRequest>,
    emitMessage: (message: unknown) => void,
    _emitNotification: (notification: JsonRpcNotification) => void
  ): void {
    this.connectionMonitor.markAlive('message');

    if (typeof message !== 'object' || message === null) {
      logger.debug('Received non-object Gateway message');
      return;
    }

    const msg = message as Record<string, unknown>;

    // Handle OpenClaw protocol response format: { type: "res", id: "...", ok: true/false, ... }
    if (msg.type === 'res' && typeof msg.id === 'string') {
      if (msg.ok === false || msg.error) {
        const errorObj = msg.error as { message?: string; code?: number } | undefined;
        const errorMsg =
          errorObj?.message || JSON.stringify(msg.error) || 'Unknown error';
        if (rejectPendingGatewayRequest(pendingRequests, msg.id, new Error(errorMsg))) {
          return;
        }
      } else if (
        resolvePendingGatewayRequest(pendingRequests, msg.id, msg.payload ?? msg)
      ) {
        return;
      }
    }

    // Handle OpenClaw protocol event format: { type: "event", event: "...", payload: {...} }
    if (msg.type === 'event' && typeof msg.event === 'string') {
      dispatchProtocolEvent(this, msg.event, msg.payload);
      return;
    }

    // Fallback: Check if this is a JSON-RPC 2.0 response (legacy support)
    if (isResponse(message) && message.id && pendingRequests.has(String(message.id))) {
      if (message.error) {
        const errorMsg =
          typeof message.error === 'object'
            ? (message.error as { message?: string }).message ||
              JSON.stringify(message.error)
            : String(message.error);
        rejectPendingGatewayRequest(
          pendingRequests,
          String(message.id),
          new Error(errorMsg)
        );
      } else {
        resolvePendingGatewayRequest(pendingRequests, String(message.id), message.result);
      }
      return;
    }

    // Check if this is a JSON-RPC notification (server-initiated event)
    if (isNotification(message)) {
      dispatchJsonRpcNotification(this, message);
      return;
    }

    emitMessage(message);
  }

  startPing(options: {
    sendPing: () => void;
    onHeartbeatTimeout: (context: { consecutiveMisses: number; timeoutMs: number }) => void;
  }): void {
    const isWindows = process.platform === 'win32';
    this.connectionMonitor.startPing({
      intervalMs: isWindows
        ? GatewayWebSocketHandler.HEARTBEAT_INTERVAL_MS_WIN
        : GatewayWebSocketHandler.HEARTBEAT_INTERVAL_MS,
      timeoutMs: isWindows
        ? GatewayWebSocketHandler.HEARTBEAT_TIMEOUT_MS_WIN
        : GatewayWebSocketHandler.HEARTBEAT_TIMEOUT_MS,
      maxConsecutiveMisses: isWindows
        ? GatewayWebSocketHandler.HEARTBEAT_MAX_MISSES_WIN
        : GatewayWebSocketHandler.HEARTBEAT_MAX_MISSES,
      sendPing: options.sendPing,
      onHeartbeatTimeout: options.onHeartbeatTimeout,
    });
  }

  startHealthCheck(options: {
    shouldCheck: () => boolean;
    checkHealth: () => Promise<{ ok: boolean; error?: string; uptime?: number }>;
    onUnhealthy: (errorMessage: string) => void;
    onError: (error: unknown) => void;
  }): void {
    this.connectionMonitor.startHealthCheck(options);
  }

  clearMonitoring(): void {
    this.connectionMonitor.clear();
  }

  markAlive(reason: 'pong' | 'message'): void {
    this.connectionMonitor.markAlive(reason);
  }

  sendRpc<T>(
    method: string,
    params: unknown | undefined,
    pendingRequests: Map<string, PendingGatewayRequest>,
    timeoutMs: number
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Gateway not connected'));
        return;
      }

      const id = crypto.randomUUID();

      const timeout = setTimeout(() => {
        rejectPendingGatewayRequest(
          pendingRequests,
          id,
          new Error(`RPC timeout: ${method}`)
        );
      }, timeoutMs);

      pendingRequests.set(id, {
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
        this.ws.send(JSON.stringify(request));
      } catch (error) {
        rejectPendingGatewayRequest(
          pendingRequests,
          id,
          new Error(`Failed to send RPC request: ${error}`)
        );
      }
    });
  }
}