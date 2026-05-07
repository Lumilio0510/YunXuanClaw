/**
 * Gateway Process Lifecycle
 * Handles process spawning, exit handling, and stderr management
 */
import type { Electron } from 'electron';
import { logger } from '../utils/logger';
import { launchGatewayProcess } from './process-launcher';
import { prepareGatewayLaunchContext } from './config-sync';
import { unloadLaunchctlGatewayService, terminateOwnedGatewayProcess } from './supervisor';
import { classifyGatewayStderrMessage, recordGatewayStartupStderrLine } from './startup-stderr';

export type ProcessExitHandler = (code: number | null) => void;
export type ProcessErrorHandler = (error: Error) => void;

export type ProcessSpawnOptions = {
  port: number;
  sanitizeSpawnArgs: (args: string[]) => string[];
  getCurrentState: () => string;
  getShouldReconnect: () => boolean;
  onSpawn: (pid: number | undefined) => void;
  onExit: (child: Electron.UtilityProcess, code: number | null) => void;
  onError: () => void;
};

export type ProcessManagerResult = {
  child: Electron.UtilityProcess;
  lastSpawnSummary: string | null;
};

export class GatewayProcessManager {
  private process: Electron.UtilityProcess | null = null;
  private processExitCode: number | null = null;
  private ownsProcess = false;
  private lastSpawnSummary: string | null = null;
  private recentStartupStderrLines: string[] = [];

  getProcess(): Electron.UtilityProcess | null {
    return this.process;
  }

  getPid(): number | undefined {
    return this.process?.pid;
  }

  getExitCode(): number | null {
    return this.processExitCode;
  }

  ownsProcessCheck(): boolean {
    return this.ownsProcess;
  }

  setOwnsProcess(value: boolean): void {
    this.ownsProcess = value;
  }

  getLastSpawnSummary(): string | null {
    return this.lastSpawnSummary;
  }

  getRecentStderrLines(): string[] {
    return this.recentStartupStderrLines;
  }

  resetStderrLines(): void {
    this.recentStartupStderrLines = [];
  }

  async spawn(options: ProcessSpawnOptions): Promise<ProcessManagerResult> {
    const launchContext = await prepareGatewayLaunchContext(options.port);
    await unloadLaunchctlGatewayService();
    this.processExitCode = null;

    // Per-process dedup map for stderr lines — resets on each new spawn.
    const stderrDedup = new Map<string, number>();

    const { child, lastSpawnSummary } = await launchGatewayProcess({
      port: options.port,
      launchContext,
      sanitizeSpawnArgs: options.sanitizeSpawnArgs,
      getCurrentState: options.getCurrentState,
      getShouldReconnect: options.getShouldReconnect,
      onStderrLine: (line) => {
        recordGatewayStartupStderrLine(this.recentStartupStderrLines, line);
        const classified = classifyGatewayStderrMessage(line);
        if (classified.level === 'drop') return;

        // Dedup: suppress identical stderr lines after the first occurrence.
        const count = (stderrDedup.get(classified.normalized) ?? 0) + 1;
        stderrDedup.set(classified.normalized, count);
        if (count > 1) {
          // Log a summary every 50 duplicates to stay visible without flooding.
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
        options.onSpawn(pid);
      },
      onExit: (exitedChild, code) => {
        this.processExitCode = code;
        this.ownsProcess = false;
        if (this.process === exitedChild) {
          this.process = null;
        }
        options.onExit(exitedChild, code);
      },
      onError: () => {
        this.ownsProcess = false;
        if (this.process === child) {
          this.process = null;
        }
        options.onError();
      },
    });

    this.process = child;
    this.ownsProcess = true;
    this.lastSpawnSummary = lastSpawnSummary;
    logger.debug(`Gateway manager now owns process pid=${child.pid ?? 'unknown'}`);

    return { child, lastSpawnSummary };
  }

  async terminate(): Promise<boolean> {
    if (!this.process || !this.ownsProcess) {
      return false;
    }

    const child = this.process;
    await terminateOwnedGatewayProcess(child);

    if (this.process === child) {
      this.process = null;
    }
    this.ownsProcess = false;
    return true;
  }

  clearProcess(): void {
    this.process = null;
    this.ownsProcess = false;
    this.processExitCode = null;
  }
}
