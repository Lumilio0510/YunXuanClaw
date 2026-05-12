import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import {
  clearHistoryPoll,
  enrichWithCachedImages,
  enrichWithToolResultFiles,
  getMessageText,
  hasNonToolAssistantContent,
  isInternalMessage,
  isToolResultRole,
  loadMissingPreviews,
  toMs,
} from './helpers';
import { buildCronSessionHistoryPath, isCronSessionKey } from './cron-session-utils';
import type { RawMessage } from './types';
import type { ChatGet, ChatSet, SessionHistoryActions } from './store-api';

async function loadCronFallbackMessages(sessionKey: string, limit = 200): Promise<RawMessage[]> {
  if (!isCronSessionKey(sessionKey)) return [];
  try {
    const response = await hostApiFetch<{ messages?: RawMessage[] }>(
      buildCronSessionHistoryPath(sessionKey, limit),
    );
    return Array.isArray(response.messages) ? response.messages : [];
  } catch (error) {
    console.warn('Failed to load cron fallback history:', error);
    return [];
  }
}

export function createHistoryActions(
  set: ChatSet,
  get: ChatGet,
): Pick<SessionHistoryActions, 'loadHistory'> {
  return {
    loadHistory: async (quiet = false) => {
      const { currentSessionKey } = get();
      if (!quiet) set({ loading: true, error: null });

      const isCurrentSession = () => get().currentSessionKey === currentSessionKey;
      const getPreviewMergeKey = (message: RawMessage): string => (
        `${message.id ?? ''}|${message.role}|${message.timestamp ?? ''}|${getMessageText(message.content)}`
      );
      const mergeHydratedMessages = (
        currentMessages: RawMessage[],
        hydratedMessages: RawMessage[],
      ): RawMessage[] => {
        const hydratedFilesByKey = new Map(
          hydratedMessages
            .filter((message) => message._attachedFiles?.length)
            .map((message) => [
              getPreviewMergeKey(message),
              message._attachedFiles!.map((file) => ({ ...file })),
            ]),
        );

        return currentMessages.map((message) => {
          const attachedFiles = hydratedFilesByKey.get(getPreviewMergeKey(message));
          return attachedFiles
            ? { ...message, _attachedFiles: attachedFiles }
            : message;
        });
      };

      const applyLoadFailure = (errorMessage: string | null) => {
        if (!isCurrentSession()) return;
        // 永远忽略超时错误，即使Gateway是满的
        if (errorMessage && errorMessage.toLowerCase().includes('timeout')) {
          set((state) => {
            const hasMessages = state.messages.length > 0;
            return {
              loading: false,
              error: null, // Suppress timeout errors silently
              ...(hasMessages ? {} : { messages: [] as RawMessage[] }),
            };
          });
          return;
        }
        set((state) => {
          const hasMessages = state.messages.length > 0;
          return {
            loading: false,
            error: !quiet && errorMessage ? errorMessage : state.error,
            ...(hasMessages ? {} : { messages: [] as RawMessage[] }),
          };
        });
      };

      const applyLoadedMessages = (rawMessages: RawMessage[], thinkingLevel: string | null) => {
        if (!isCurrentSession()) return;
        // Before filtering: attach images/files from tool_result messages to the next assistant message
        const messagesWithToolImages = enrichWithToolResultFiles(rawMessages);
        const filteredMessages = messagesWithToolImages.filter((msg) => !isToolResultRole(msg.role) && !isInternalMessage(msg));
        // Restore file attachments for user/assistant messages (from cache + text patterns)
        const enrichedMessages = enrichWithCachedImages(filteredMessages);

        // Deduplicate: merge server history with current local messages.
        // The local `messages[]` may contain optimistic/snapshot messages with
        // client-generated IDs that differ from the server's IDs.  A naive
        // `set({ messages: enrichedMessages })` can cause duplicate bubbles
        // when the server returns the same content with a different ID.
        //
        // Strategy: build a dedup key from role + rounded timestamp + content
        // text.  Prefer the server version (authoritative ID, richer metadata)
        // but keep any local-only messages that the server doesn't yet have.
        const dedupKey = (m: RawMessage): string => {
          const ts = m.timestamp ? Math.round(toMs(m.timestamp) / 1000) : 0;
          const text = getMessageText(m.content).slice(0, 200);
          return `${m.role}|${ts}|${text}`;
        };

        const serverByKey = new Map<string, RawMessage>();
        for (const m of enrichedMessages) {
          const key = dedupKey(m);
          serverByKey.set(key, m);
        }

        // Collect local-only messages not present in server history
        const localOnly: RawMessage[] = [];
        for (const m of get().messages) {
          const key = dedupKey(m);
          if (!serverByKey.has(key)) {
            localOnly.push(m);
          }
        }

        // Merge: server messages (authoritative) + local-only messages (optimistic snapshots)
        // Insert local-only messages at their chronological position based on timestamp
        let finalMessages = [...enrichedMessages];
        if (localOnly.length > 0) {
          for (const localMsg of localOnly) {
            const localTs = localMsg.timestamp ? toMs(localMsg.timestamp) : Infinity;
            let insertIdx = finalMessages.length;
            for (let i = finalMessages.length - 1; i >= 0; i--) {
              const ts = finalMessages[i].timestamp;
              const serverTs = ts != null ? toMs(ts) : 0;
              if (serverTs <= localTs) break;
              insertIdx = i;
            }
            finalMessages.splice(insertIdx, 0, localMsg);
          }
        }

        set({ messages: finalMessages, thinkingLevel, loading: false });

        // Extract first user message text as a session label for display in the toolbar.
        // Skip main sessions (key ends with ":main") — they rely on the Gateway-provided
        // displayName (e.g. the configured agent name "ClawX") instead.
        const isMainSession = currentSessionKey.endsWith(':main');
        if (!isMainSession) {
          const firstUserMsg = finalMessages.find((m) => m.role === 'user');
          if (firstUserMsg) {
            const labelText = getMessageText(firstUserMsg.content).trim();
            if (labelText) {
              const truncated = labelText.length > 50 ? `${labelText.slice(0, 50)}…` : labelText;
              set((s) => ({
                sessionLabels: { ...s.sessionLabels, [currentSessionKey]: truncated },
              }));
            }
          }
        }

        // Record last activity time from the last message in history
        const lastMsg = finalMessages[finalMessages.length - 1];
        if (lastMsg?.timestamp) {
          const lastAt = toMs(lastMsg.timestamp);
          set((s) => ({
            sessionLastActivity: { ...s.sessionLastActivity, [currentSessionKey]: lastAt },
          }));
        }

        // Async: load missing image previews from disk (updates in background)
        loadMissingPreviews(finalMessages).then((updated) => {
          if (!isCurrentSession()) return;
          if (updated) {
            set((state) => ({
              messages: mergeHydratedMessages(state.messages, finalMessages),
            }));
          }
        });
        const { pendingFinal, lastUserMessageAt, sending: isSendingNow } = get();

        // If we're sending but haven't received streaming events, check
        // whether the loaded history reveals intermediate tool-call activity.
        // This surfaces progress via the pendingFinal → ActivityIndicator path.
        const userMsTs = lastUserMessageAt ? toMs(lastUserMessageAt) : 0;
        const isAfterUserMsg = (msg: RawMessage): boolean => {
          if (!userMsTs || !msg.timestamp) return true;
          return toMs(msg.timestamp) >= userMsTs;
        };

        if (isSendingNow && !pendingFinal) {
          const hasRecentAssistantActivity = [...filteredMessages].reverse().some((msg) => {
            if (msg.role !== 'assistant') return false;
            return isAfterUserMsg(msg);
          });
          if (hasRecentAssistantActivity) {
            set({ pendingFinal: true });
          }
        }

        // If pendingFinal, check whether the AI produced a final text response.
        if (pendingFinal || get().pendingFinal) {
          const recentAssistant = [...filteredMessages].reverse().find((msg) => {
            if (msg.role !== 'assistant') return false;
            if (!hasNonToolAssistantContent(msg)) return false;
            return isAfterUserMsg(msg);
          });
          if (recentAssistant) {
            clearHistoryPoll();
            set({ sending: false, activeRunId: null, pendingFinal: false });
          }
        }
      };

      const MAX_RETRIES = 2;
      const RETRY_DELAY_MS = 1000;
      let result: { success: boolean; result?: Record<string, unknown>; error?: string } | null = null;
      let lastError: unknown = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          result = await invokeIpc(
            'gateway:rpc',
            'chat.history',
            { sessionKey: currentSessionKey, limit: 200 }
          ) as { success: boolean; result?: Record<string, unknown>; error?: string };

          if (result.success || attempt === MAX_RETRIES) {
            break;
          }
        } catch (err) {
          lastError = err;
          if (attempt < MAX_RETRIES) {
            console.warn(`chat.history attempt ${attempt + 1} failed, retrying in ${RETRY_DELAY_MS}ms:`, err);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
          }
        }
      }

      if (result && result.success && result.result) {
        const data = result.result;
        let rawMessages = Array.isArray(data.messages) ? data.messages as RawMessage[] : [];
        const thinkingLevel = data.thinkingLevel ? String(data.thinkingLevel) : null;
        if (rawMessages.length === 0 && isCronSessionKey(currentSessionKey)) {
          rawMessages = await loadCronFallbackMessages(currentSessionKey, 200);
        }
        applyLoadedMessages(rawMessages, thinkingLevel);
      } else {
        const fallbackMessages = await loadCronFallbackMessages(currentSessionKey, 200);
        if (fallbackMessages.length > 0) {
          applyLoadedMessages(fallbackMessages, null);
        } else {
          applyLoadFailure(result?.error || String(lastError) || 'Failed to load chat history');
        }
      }
    },
  };
}
