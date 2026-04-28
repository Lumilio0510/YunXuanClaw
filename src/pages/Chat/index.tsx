/**
 * Chat 页面组件
 * 与 OpenClaw Gateway 通过 gateway:rpc IPC 通信
 * 包含会话选择、思考过程开关、刷新按钮
 * 消息支持 Markdown 渲染和流式输出
 */
import { useEffect, useState } from 'react';
import { AlertCircle, Loader2, Sparkles } from 'lucide-react';
import { useChatStore, type RawMessage } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { hostApiFetch } from '@/lib/host-api';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { ExecutionGraphCard } from './ExecutionGraphCard';
import { ChatToolbar } from './ChatToolbar';
import { extractImages, extractText, extractThinking, extractToolUse } from './message-utils';
import { deriveTaskSteps, parseSubagentCompletionInfo } from './task-visualization';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useStickToBottomInstant } from '@/hooks/use-stick-to-bottom-instant';
import { useMinLoading } from '@/hooks/use-min-loading';

/**
 * Chat 页面主组件
 * 管理消息状态、Gateway 连接、子 Agent 转录本加载
 */
export function Chat() {
  const { t } = useTranslation('chat');
  // Gateway 连接状态
  const gatewayStatus = useGatewayStore((s) => s.status);
  const isGatewayRunning = gatewayStatus.state === 'running';

  // 从 Chat Store 获取消息和状态
  const messages = useChatStore((s) => s.messages);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const sessionLabels = useChatStore((s) => s.sessionLabels);
  const loading = useChatStore((s) => s.loading);
  const sending = useChatStore((s) => s.sending);
  const error = useChatStore((s) => s.error);
  const showThinking = useChatStore((s) => s.showThinking);
  const streamingMessage = useChatStore((s) => s.streamingMessage);
  const streamingTools = useChatStore((s) => s.streamingTools);
  const pendingFinal = useChatStore((s) => s.pendingFinal);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const abortRun = useChatStore((s) => s.abortRun);
  const clearError = useChatStore((s) => s.clearError);

  // 从 Agents Store 获取 Agent 列表
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const agents = useAgentsStore((s) => s.agents);

  const cleanupEmptySession = useChatStore((s) => s.cleanupEmptySession);

  // 子 Agent 转录本（用于显示子 Agent 的执行过程）
  const [childTranscripts, setChildTranscripts] = useState<Record<string, RawMessage[]>>({});

  // 流式输出的时间戳
  const [streamingTimestamp, setStreamingTimestamp] = useState<number>(0);
  // 最小加载时间（避免闪烁）
  const minLoading = useMinLoading(loading && messages.length > 0);
  // 自动滚动到底部
  const { contentRef, scrollRef } = useStickToBottomInstant(currentSessionKey);

  // 组件卸载时清理空会话
  useEffect(() => {
    return () => {
      // If the user navigates away without sending any messages, remove the
      // empty session so it doesn't linger as a ghost entry in the sidebar.
      cleanupEmptySession();
    };
  }, [cleanupEmptySession]);

  // 加载 Agent 列表
  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  // 加载子 Agent 转录本
  useEffect(() => {
    const completions = messages
      .map((message) => parseSubagentCompletionInfo(message))
      .filter((value): value is NonNullable<typeof value> => value != null);
    const missing = completions.filter((completion) => !childTranscripts[completion.sessionId]);
    if (missing.length === 0) return;

    let cancelled = false;
    void Promise.all(
      missing.map(async (completion) => {
        try {
          const result = await hostApiFetch<{ success: boolean; messages?: RawMessage[] }>(
            `/api/sessions/transcript?agentId=${encodeURIComponent(completion.agentId)}&sessionId=${encodeURIComponent(completion.sessionId)}`,
          );
          if (!result.success) {
            console.warn('Failed to load child transcript:', {
              agentId: completion.agentId,
              sessionId: completion.sessionId,
              result,
            });
            return null;
          }
          return { sessionId: completion.sessionId, messages: result.messages || [] };
        } catch (error) {
          console.warn('Failed to load child transcript:', {
            agentId: completion.agentId,
            sessionId: completion.sessionId,
            error,
          });
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setChildTranscripts((current) => {
        const next = { ...current };
        for (const result of results) {
          if (!result) continue;
          next[result.sessionId] = result.messages;
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [messages, childTranscripts]);

  // 发送消息时更新时间戳
  useEffect(() => {
    if (sending && streamingTimestamp === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStreamingTimestamp(Date.now() / 1000);
    } else if (!sending && streamingTimestamp !== 0) {
      setStreamingTimestamp(0);
    }
  }, [sending, streamingTimestamp]);

  // 流式消息解析：从 streamingMessage 提取各种内容
  const streamMsg = streamingMessage && typeof streamingMessage === 'object'
    ? streamingMessage as unknown as { role?: string; content?: unknown; timestamp?: number }
    : null;
  const streamText = streamMsg ? extractText(streamMsg) : (typeof streamingMessage === 'string' ? streamingMessage : '');
  const hasStreamText = streamText.trim().length > 0;
  const streamThinking = streamMsg ? extractThinking(streamMsg) : null;
  const hasStreamThinking = showThinking && !!streamThinking && streamThinking.trim().length > 0;
  const streamTools = streamMsg ? extractToolUse(streamMsg) : [];
  const hasStreamTools = streamTools.length > 0;
  const streamImages = streamMsg ? extractImages(streamMsg) : [];
  const hasStreamImages = streamImages.length > 0;
  const hasStreamToolStatus = streamingTools.length > 0;
  // 判断是否需要渲染流式消息
  const shouldRenderStreaming = sending && (hasStreamText || hasStreamThinking || hasStreamTools || hasStreamImages || hasStreamToolStatus);
  const hasAnyStreamContent = hasStreamText || hasStreamThinking || hasStreamTools || hasStreamImages || hasStreamToolStatus;

  // 判断是否为空会话
  const isEmpty = messages.length === 0 && !sending;

  // 解析子 Agent 完成信息
  const subagentCompletionInfos = messages.map((message) => parseSubagentCompletionInfo(message));
  const nextUserMessageIndexes = new Array<number>(messages.length).fill(-1);
  let nextUserMessageIndex = -1;
  // 从后向前遍历，找出每个用户消息的下一个用户消息位置
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    nextUserMessageIndexes[idx] = nextUserMessageIndex;
    if (messages[idx].role === 'user' && !subagentCompletionInfos[idx]) {
      nextUserMessageIndex = idx;
    }
  }

  // 生成用户运行卡片（执行图）
  // 将消息按用户触发 → Agent 响应分段，每段生成一个 ExecutionGraphCard
  const userRunCards = messages.flatMap((message, idx) => {
    if (message.role !== 'user' || subagentCompletionInfos[idx]) return [];

    const nextUserIndex = nextUserMessageIndexes[idx];
    const segmentEnd = nextUserIndex === -1 ? messages.length : nextUserIndex;
    const segmentMessages = messages.slice(idx + 1, segmentEnd);
    const replyIndexOffset = segmentMessages.findIndex((candidate) => candidate.role === 'assistant');
    const replyIndex = replyIndexOffset === -1 ? null : idx + 1 + replyIndexOffset;
    const completionInfos = subagentCompletionInfos
      .slice(idx + 1, segmentEnd)
      .filter((value): value is NonNullable<typeof value> => value != null);
    const isLatestOpenRun = nextUserIndex === -1 && (sending || pendingFinal || hasAnyStreamContent);
    let steps = deriveTaskSteps({
      messages: segmentMessages,
      streamingMessage: isLatestOpenRun ? streamingMessage : null,
      streamingTools: isLatestOpenRun ? streamingTools : [],
      sending: isLatestOpenRun ? sending : false,
      pendingFinal: isLatestOpenRun ? pendingFinal : false,
      showThinking,
    });

    for (const completion of completionInfos) {
      const childMessages = childTranscripts[completion.sessionId];
      if (!childMessages || childMessages.length === 0) continue;
      const branchRootId = `subagent:${completion.sessionId}`;
      const childSteps = deriveTaskSteps({
        messages: childMessages,
        streamingMessage: null,
        streamingTools: [],
        sending: false,
        pendingFinal: false,
        showThinking,
      }).map((step) => ({
        ...step,
        id: `${completion.sessionId}:${step.id}`,
        depth: step.depth + 1,
        parentId: branchRootId,
      }));

      steps = [
        ...steps,
        {
          id: branchRootId,
          label: `${completion.agentId} subagent`,
          status: 'completed',
          kind: 'system' as const,
          detail: completion.sessionKey,
          depth: 1,
          parentId: 'agent-run',
        },
        ...childSteps,
      ];
    }

    if (steps.length === 0) return [];

    const segmentAgentId = currentAgentId;
    const segmentAgentLabel = agents.find((agent) => agent.id === segmentAgentId)?.name || segmentAgentId;
    const segmentSessionLabel = sessionLabels[currentSessionKey] || currentSessionKey;

    return [{
      triggerIndex: idx,
      replyIndex,
      active: isLatestOpenRun,
      agentLabel: segmentAgentLabel,
      sessionLabel: segmentSessionLabel,
      segmentEnd: nextUserIndex === -1 ? messages.length - 1 : nextUserIndex - 1,
      steps,
    }];
  });

  return (
    <div className={cn("relative flex min-h-0 flex-col -m-6 transition-colors duration-500 dark:bg-background")} style={{ height: 'calc(100vh - 2.5rem)' }}>
      {/* 工具栏 */}
      <div className="flex shrink-0 items-center justify-end px-4 py-2">
        <ChatToolbar />
      </div>

      {/* 消息区域 */}
      <div className="min-h-0 flex-1 overflow-hidden px-4 py-4">
        <div className="mx-auto flex h-full min-h-0 max-w-6xl flex-col gap-4 lg:flex-row lg:items-stretch">
          <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div ref={contentRef} className="max-w-4xl space-y-4">
              {isEmpty ? (
                <WelcomeScreen />
              ) : (
                <>
                  {/* 渲染消息列表 */}
                  {messages.map((msg, idx) => {
                    // 判断是否需要隐藏工具卡片（当该消息属于某个执行图卡片时）
                    const suppressToolCards = userRunCards.some((card) =>
                      idx > card.triggerIndex && idx <= card.segmentEnd,
                    );
                    return (
                    <div
                      key={msg.id || `msg-${idx}`}
                      className="space-y-3"
                      id={`chat-message-${idx}`}
                      data-testid={`chat-message-${idx}`}
                    >
                      <ChatMessage
                        message={msg}
                        showThinking={showThinking}
                        suppressToolCards={suppressToolCards}
                        suppressProcessAttachments={suppressToolCards}
                      />
                      {/* 渲染执行图卡片（位于用户消息之后） */}
                      {userRunCards
                        .filter((card) => card.triggerIndex === idx)
                        .map((card) => (
                          <ExecutionGraphCard
                            key={`graph-${idx}`}
                            agentLabel={card.agentLabel}
                            sessionLabel={card.sessionLabel}
                            steps={card.steps}
                            active={card.active}
                            onJumpToTrigger={() => {
                              document.getElementById(`chat-message-${card.triggerIndex}`)?.scrollIntoView({
                                behavior: 'smooth',
                                block: 'center',
                              });
                            }}
                            onJumpToReply={() => {
                              if (card.replyIndex == null) return;
                              document.getElementById(`chat-message-${card.replyIndex}`)?.scrollIntoView({
                                behavior: 'smooth',
                                block: 'center',
                              });
                            }}
                          />
                        ))}
                    </div>
                    );
                  })}

                  {/* 流式消息 */}
                  {shouldRenderStreaming && (
                    <ChatMessage
                      message={(streamMsg
                        ? {
                            ...(streamMsg as Record<string, unknown>),
                            role: (typeof streamMsg.role === 'string' ? streamMsg.role : 'assistant') as RawMessage['role'],
                            content: streamMsg.content ?? streamText,
                            timestamp: streamMsg.timestamp ?? streamingTimestamp,
                          }
                        : {
                            role: 'assistant',
                            content: streamText,
                            timestamp: streamingTimestamp,
                          }) as RawMessage}
                      showThinking={showThinking}
                      isStreaming
                      streamingTools={streamingTools}
                    />
                  )}

                  {/* 活动指示器：工具执行完成后等待 AI 响应 */}
                  {sending && pendingFinal && !shouldRenderStreaming && (
                    <ActivityIndicator phase="tool_processing" />
                  )}

                  {/* 输入中指示器：发送中但暂无流式内容 */}
                  {sending && !pendingFinal && !hasAnyStreamContent && (
                    <TypingIndicator />
                  )}
                </>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* 错误提示栏 永久删除RPC超时错误 */}
      {error && !error.toLowerCase().includes('timeout') && (
        <div className="px-4 py-2 bg-destructive/10 border-t border-destructive/20">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <p className="text-sm text-destructive flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {error}
            </p>
            <button
              onClick={clearError}
              className="text-xs text-destructive/60 hover:text-destructive underline"
            >
              {t('common:actions.dismiss')}
            </button>
          </div>
        </div>
      )}

      {/* 输入区域 */}
      <ChatInput
        onSend={sendMessage}
        onStop={abortRun}
        disabled={!isGatewayRunning}
        sending={sending}
        isEmpty={isEmpty}
      />

      {/* 加载遮罩层 */}
      {minLoading && !sending && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/20 backdrop-blur-[1px] rounded-xl pointer-events-auto">
          <div className="bg-background shadow-lg rounded-full p-2.5 border border-border">
            <LoadingSpinner size="md" />
          </div>
        </div>
      )}
    </div>
  );
}

// ── 欢迎屏幕 ────────────────────────────────────────────────────

/**
 * 欢迎屏幕组件
 * 空会话时显示的引导界面
 */
function WelcomeScreen() {
  const { t } = useTranslation('chat');
  const quickActions = [
    { key: 'askQuestions', label: t('welcome.askQuestions') },
    // { key: 'creativeTasks', label: t('welcome.creativeTasks') },
    // { key: 'brainstorming', label: t('welcome.brainstorming') },
  ];

  return (
    <div className="flex flex-col items-center justify-center text-center h-[60vh]">
      <h1 className="text-4xl md:text-5xl font-sans text-foreground/80 mb-8 font-normal tracking-tight">
        {t('welcome.subtitle')}
      </h1>

      <div className="flex flex-wrap items-center justify-center gap-2.5 max-w-lg w-full">
        {quickActions.map(({ key, label }) => (
          <button 
            key={key}
            className="px-4 py-1.5 rounded-full border border-black/10 dark:border-white/10 text-[13px] font-medium text-foreground/70 hover:bg-black/5 dark:hover:bg-white/5 transition-colors bg-black/[0.02]"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── 输入中指示器 ───────────────────────────────────────────────

/**
 * 输入中指示器组件
 * 显示三个跳动的点，表示 AI 正在输入
 */
function TypingIndicator() {
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full mt-1 bg-black/5 dark:bg-white/5 text-foreground">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="bg-black/5 dark:bg-white/5 text-foreground rounded-2xl px-4 py-3">
        <div className="flex gap-1">
          <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    </div>
  );
}

// ── 活动指示器（工具执行循环之间显示） ─────────────────────────────

/**
 * 活动指示器组件
 * 工具执行完成后、等待 AI 响应时显示
 */
function ActivityIndicator({ phase }: { phase: 'tool_processing' }) {
  void phase;
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full mt-1 bg-black/5 dark:bg-white/5 text-foreground">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="bg-black/5 dark:bg-white/5 text-foreground rounded-2xl px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span>Processing tool results…</span>
        </div>
      </div>
    </div>
  );
}

export default Chat;
