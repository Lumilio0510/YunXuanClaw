/**
 * 任务可视化工具函数
 * 从聊天消息中提取和派生任务执行步骤
 * 用于在 ExecutionGraphCard 中展示执行流程
 */
import { extractThinking, extractToolUse } from './message-utils';
import type { RawMessage, ToolStatus } from '@/stores/chat';

/** 任务步骤状态 */
export type TaskStepStatus = 'running' | 'completed' | 'error';

/** 任务步骤接口 */
export interface TaskStep {
  id: string;
  label: string;
  status: TaskStepStatus;
  kind: 'thinking' | 'tool' | 'system';
  detail?: string;
  depth: number;
  parentId?: string;
}

/** 最大显示步骤数 */
const MAX_TASK_STEPS = 8;

interface DeriveTaskStepsInput {
  messages: RawMessage[];
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  sending: boolean;
  pendingFinal: boolean;
  showThinking: boolean;
}

/** 子 Agent 完成信息接口 */
export interface SubagentCompletionInfo {
  sessionKey: string;
  sessionId: string;
  agentId: string;
}

/** 规范化文本：移除多余空白字符 */
function normalizeText(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized;
}

/** 生成工具步骤的唯一 ID */
function makeToolId(prefix: string, name: string, index: number): string {
  return `${prefix}:${name}:${index}`;
}

/** 从会话 Key 解析 Agent ID */
export function parseAgentIdFromSessionKey(sessionKey: string): string | null {
  const parts = sessionKey.split(':');
  if (parts.length < 2 || parts[0] !== 'agent') return null;
  return parts[1] || null;
}

/**
 * 解析子 Agent 完成信息
 * 从消息中检测 [Internal task completion event] 并提取会话信息
 */
export function parseSubagentCompletionInfo(message: RawMessage): SubagentCompletionInfo | null {
  const text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((block) => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('\n')
      : '';
  if (!text.includes('[Internal task completion event]')) return null;

  const sessionKeyMatch = text.match(/session_key:\s*(.+)/);
  const sessionIdMatch = text.match(/session_id:\s*(.+)/);
  const sessionKey = sessionKeyMatch?.[1]?.trim();
  const sessionId = sessionIdMatch?.[1]?.trim();
  if (!sessionKey || !sessionId) return null;
  const agentId = parseAgentIdFromSessionKey(sessionKey);
  if (!agentId) return null;
  return { sessionKey, sessionId, agentId };
}

/** 判断是否为类似 spawn 的步骤（子 Agent、分支等） */
function isSpawnLikeStep(label: string): boolean {
  return /(spawn|subagent|delegate|parallel)/i.test(label);
}

/** 尝试解析 JSON 对象 */
function tryParseJsonObject(detail: string | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** 从步骤中提取分支 Agent 名称 */
function extractBranchAgent(step: TaskStep): string | null {
  const parsed = tryParseJsonObject(step.detail);
  const agentId = parsed?.agentId;
  if (typeof agentId === 'string' && agentId.trim()) return agentId.trim();

  const message = typeof parsed?.message === 'string' ? parsed.message : step.detail;
  if (!message) return null;
  const match = message.match(/\b(coder|reviewer|project-manager|manager|planner|researcher|worker|subagent)\b/i);
  return match ? match[1] : null;
}

/**
 * 附加拓扑结构
 * 为步骤添加深度和父子关系，支持分支显示
 */
function attachTopology(steps: TaskStep[]): TaskStep[] {
  const withTopology: TaskStep[] = [];
  let activeBranchNodeId: string | null = null;

  for (const step of steps) {
    if (step.kind === 'system') {
      activeBranchNodeId = null;
      withTopology.push({ ...step, depth: 1, parentId: 'agent-run' });
      continue;
    }

    if (/sessions_spawn/i.test(step.label)) {
      const branchAgent = extractBranchAgent(step) || 'subagent';
      const branchNodeId = `${step.id}:branch`;
      withTopology.push({ ...step, depth: 1, parentId: 'agent-run' });
      withTopology.push({
        id: branchNodeId,
        label: `${branchAgent} run`,
        status: step.status,
        kind: 'system',
        detail: `Spawned branch for ${branchAgent}`,
        depth: 2,
        parentId: step.id,
      });
      activeBranchNodeId = branchNodeId;
      continue;
    }

    if (/sessions_yield/i.test(step.label)) {
      withTopology.push({
        ...step,
        depth: activeBranchNodeId ? 3 : 1,
        parentId: activeBranchNodeId ?? 'agent-run',
      });
      activeBranchNodeId = null;
      continue;
    }

    if (step.kind === 'thinking') {
      withTopology.push({
        ...step,
        depth: activeBranchNodeId ? 3 : 1,
        parentId: activeBranchNodeId ?? 'agent-run',
      });
      continue;
    }

    if (isSpawnLikeStep(step.label)) {
      activeBranchNodeId = step.id;
      withTopology.push({
        ...step,
        depth: 1,
        parentId: 'agent-run',
      });
      continue;
    }

    withTopology.push({
      ...step,
      depth: activeBranchNodeId ? 3 : 1,
      parentId: activeBranchNodeId ?? 'agent-run',
    });
  }

  return withTopology;
}

/**
 * 从消息中派生任务执行步骤
 * 提取历史消息中的思考和工具调用
 * 结合流式消息和工具状态生成完整的步骤列表
 */
export function deriveTaskSteps({
  messages,
  streamingMessage,
  streamingTools,
  sending,
  pendingFinal,
  showThinking,
}: DeriveTaskStepsInput): TaskStep[] {
  const steps: TaskStep[] = [];
  const stepIndexById = new Map<string, number>();

  // 更新或插入步骤
  const upsertStep = (step: TaskStep): void => {
    const existingIndex = stepIndexById.get(step.id);
    if (existingIndex == null) {
      stepIndexById.set(step.id, steps.length);
      steps.push(step);
      return;
    }
    const existing = steps[existingIndex];
    steps[existingIndex] = {
      ...existing,
      ...step,
      detail: step.detail ?? existing.detail,
    };
  };

  // 解析流式消息
  const streamMessage = streamingMessage && typeof streamingMessage === 'object'
    ? streamingMessage as RawMessage
    : null;

  // 过滤出相关的助手消息（有工具调用或思考内容）
  const relevantAssistantMessages = messages.filter((message) => {
    if (!message || message.role !== 'assistant') return false;
    if (extractToolUse(message).length > 0) return true;
    return showThinking && !!extractThinking(message);
  });

  // 从历史助手消息中提取思考和工具调用步骤
  for (const [messageIndex, assistantMessage] of relevantAssistantMessages.entries()) {
    if (showThinking) {
      const thinking = extractThinking(assistantMessage);
      if (thinking) {
        upsertStep({
          id: `history-thinking-${assistantMessage.id || messageIndex}`,
          label: 'Thinking',
          status: 'completed',
          kind: 'thinking',
          detail: normalizeText(thinking),
          depth: 1,
        });
      }
    }

    extractToolUse(assistantMessage).forEach((tool, index) => {
      upsertStep({
        id: tool.id || makeToolId(`history-tool-${assistantMessage.id || messageIndex}`, tool.name, index),
        label: tool.name,
        status: 'completed',
        kind: 'tool',
        detail: normalizeText(JSON.stringify(tool.input, null, 2)),
        depth: 1,
      });
    });
  }

  // 从流式消息中提取思考内容
  if (streamMessage && showThinking) {
    const thinking = extractThinking(streamMessage);
    if (thinking) {
      upsertStep({
        id: 'stream-thinking',
        label: 'Thinking',
        status: 'running',
        kind: 'thinking',
        detail: normalizeText(thinking),
        depth: 1,
      });
    }
  }

  // 从流式工具状态中提取正在运行的工具
  const activeToolIds = new Set<string>();
  const activeToolNamesWithoutIds = new Set<string>();
  streamingTools.forEach((tool, index) => {
    const id = tool.toolCallId || tool.id || makeToolId('stream-status', tool.name, index);
    activeToolIds.add(id);
    if (!tool.toolCallId && !tool.id) {
      activeToolNamesWithoutIds.add(tool.name);
    }
    upsertStep({
      id,
      label: tool.name,
      status: tool.status,
      kind: 'tool',
      detail: normalizeText(tool.summary),
      depth: 1,
    });
  });

  // 从流式消息中提取工具调用
  if (streamMessage) {
    extractToolUse(streamMessage).forEach((tool, index) => {
      const id = tool.id || makeToolId('stream-tool', tool.name, index);
      if (activeToolIds.has(id) || activeToolNamesWithoutIds.has(tool.name)) return;
      upsertStep({
        id,
        label: tool.name,
        status: 'running',
        kind: 'tool',
        detail: normalizeText(JSON.stringify(tool.input, null, 2)),
        depth: 1,
      });
    });
  }

  // 添加系统状态步骤（正在完成答案/正在准备运行）
  if (sending && pendingFinal) {
      upsertStep({
        id: 'system-finalizing',
        label: 'Finalizing answer',
        status: 'running',
      kind: 'system',
      detail: 'Waiting for the assistant to finish this run.',
      depth: 1,
    });
  } else if (sending && steps.length === 0) {
      upsertStep({
        id: 'system-preparing',
        label: 'Preparing run',
        status: 'running',
      kind: 'system',
      detail: 'Waiting for the first streaming update.',
      depth: 1,
    });
  }

  // 附加拓扑结构并限制最大步骤数
  const withTopology = attachTopology(steps);
  return withTopology.length > MAX_TASK_STEPS
    ? withTopology.slice(-MAX_TASK_STEPS)
    : withTopology;
}
