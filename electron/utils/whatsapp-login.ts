import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { getOpenClawResolvedDir, getOpenClawConfigDir } from './paths';

type StartWebLoginWithQr = (opts?: {
  accountId?: string;
  timeoutMs?: number;
  verbose?: boolean;
  force?: boolean;
}) => Promise<{
  qrDataUrl?: string;
  message: string;
}>;

type WaitForWebLogin = (opts?: {
  accountId?: string;
  timeoutMs?: number;
}) => Promise<{
  connected: boolean;
  message: string;
}>;

let loginQrModule: {
  startWebLoginWithQr: StartWebLoginWithQr;
  waitForWebLogin: WaitForWebLogin;
} | null = null;

function loadLoginQrModule(): typeof loginQrModule {
  if (loginQrModule) return loginQrModule;
  const openclawRequire = createRequire(join(getOpenClawResolvedDir(), 'package.json'));
  loginQrModule = openclawRequire('./dist/extensions/whatsapp/login-qr-runtime.js');
  return loginQrModule;
}

function cleanupWhatsAppLoginCredentials(accountId: string): void {
  const authDir = join(getOpenClawConfigDir(), 'credentials', 'whatsapp', accountId);
  if (existsSync(authDir)) {
    rmSync(authDir, { recursive: true, force: true });
    const parentDir = join(getOpenClawConfigDir(), 'credentials', 'whatsapp');
    if (existsSync(parentDir)) {
      const remaining = readdirSync(parentDir);
      if (remaining.length === 0) {
        rmSync(parentDir, { recursive: true, force: true });
      }
    }
  }
}

export type WhatsAppQrEvent = {
  qrDataUrl: string;
  message: string;
};

export type WhatsAppSuccessEvent = {
  accountId: string;
  message: string;
};

export type WhatsAppErrorEvent = {
  error: string;
  accountId?: string;
};

class WhatsAppLoginManager extends EventEmitter {
  private activeAccountId: string | null = null;
  private loginPromise: Promise<void> | null = null;
  private cancelled = false;

  override on(event: 'qr', listener: (data: WhatsAppQrEvent) => void): this;
  override on(event: 'success', listener: (data: WhatsAppSuccessEvent) => void): this;
  override on(event: 'error', listener: (error: WhatsAppErrorEvent) => void): this;
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override emit(event: 'qr', data: WhatsAppQrEvent): boolean;
  override emit(event: 'success', data: WhatsAppSuccessEvent): boolean;
  override emit(event: 'error', error: WhatsAppErrorEvent): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  async start(accountId: string = 'default'): Promise<void> {
    this.cancelled = false;
    this.activeAccountId = accountId;

    const module = loadLoginQrModule();
    if (!module?.startWebLoginWithQr || !module?.waitForWebLogin) {
      this.emit('error', { error: 'WhatsApp login module not available', accountId });
      return;
    }

    try {
      const startResult = await module.startWebLoginWithQr({ accountId });

      if (this.cancelled) {
        return;
      }

      if (startResult.qrDataUrl) {
        this.emit('qr', {
          qrDataUrl: startResult.qrDataUrl,
          message: startResult.message,
        });
      } else {
        this.emit('error', { error: startResult.message, accountId });
        return;
      }

      this.loginPromise = this.waitForLogin(accountId);
      await this.loginPromise;
    } catch (error) {
      if (!this.cancelled) {
        this.emit('error', { error: String(error), accountId });
      }
    }
  }

  private async waitForLogin(accountId: string): Promise<void> {
    const module = loadLoginQrModule();
    if (!module?.waitForWebLogin) return;

    try {
      const result = await module.waitForWebLogin({
        accountId,
        timeoutMs: 300000,
      });

      if (this.cancelled) {
        return;
      }

      if (result.connected) {
        this.emit('success', { accountId, message: result.message });
      } else {
        this.emit('error', { error: result.message, accountId });
      }
    } catch (error) {
      if (!this.cancelled) {
        this.emit('error', { error: String(error), accountId });
      }
    }
  }

  async stop(): Promise<void> {
    this.cancelled = true;

    if (this.activeAccountId) {
      cleanupWhatsAppLoginCredentials(this.activeAccountId);
      this.activeAccountId = null;
    }

    if (this.loginPromise) {
      await this.loginPromise.catch(() => {});
      this.loginPromise = null;
    }
  }
}

export const whatsAppLoginManager = new WhatsAppLoginManager();
