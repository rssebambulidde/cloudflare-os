import type { Message, Usage } from "@earendil-works/pi-ai";
import type { ModelHandle } from "./ai-models.js";

/**
 * An all-zeros pi Usage record, for synthesizing assistant messages that were never actually
 * produced by a live model call (chat-history replay, compaction prompts).
 */
export function zeroUsage(): Usage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * A failed model request, thrown by completeText() and the agent turn loop. pi never throws for
 * provider failures -- it reports them as a final assistant message with stopReason "error" --
 * so this converts that shape back into an exception for callers that expect one (the overseer's
 * turn error triage and the one-shot completion helpers).
 */
export class AgentTurnError extends Error {
  /** HTTP status of the failing request, when the handle observed a response for it. */
  readonly statusCode?: number;
  /** AI Gateway log id from cf-aig-log-id when the failing response was observed. */
  readonly aiGatewayLogId?: string;

  constructor(message: string, statusCode?: number, aiGatewayLogId?: string) {
    super(message);
    this.statusCode = statusCode;
    this.aiGatewayLogId = aiGatewayLogId;
  }
}

/**
 * Best-effort HTTP status extraction for a failed request. pi reports provider failures as
 * error text only, and its onResponse callback never fires for a request the SDK failed (so
 * ModelHandle.lastResponse is unset then) -- but the provider SDKs' error messages conventionally
 * begin with the status code (e.g. "400 {...}"), which is enough for the overseer's triage
 * (report 5xx/unknown, skip expected 4xx).
 */
export function httpStatusFromError(errorMessage: string, handle: ModelHandle)
    : number | undefined {
  const match = /^(\d{3})\b/.exec(errorMessage.trim());
  if (match) return Number(match[1]);
  return handle.lastResponse?.status;
}

/**
 * Enrich opaque provider/gateway failures (esp. empty-bodied 429s) with status + gateway log id
 * so chat UI and turn logs are actionable without opening the dashboard.
 */
export function formatModelError(errorMessage: string, handle: ModelHandle): {
  message: string;
  statusCode?: number;
  aiGatewayLogId?: string;
} {
  const statusCode = httpStatusFromError(errorMessage, handle);
  const aiGatewayLogId = handle.lastResponse?.aiGatewayLogId;
  let message = errorMessage.trim() || "The model request failed.";
  const opaque429 = statusCode === 429
      || /^429\b/.test(message)
      || /\b429 status code\b/i.test(message);
  if (opaque429 && /\(no body\)/i.test(message)) {
    message = "429 from AI Gateway (empty body) — often gateway rate limit, spend limit, or "
        + "Unified Billing throttling. Check AI Gateway → Settings / Logs.";
  }
  if (aiGatewayLogId && !message.includes(aiGatewayLogId)) {
    message = `${message} (ai-gateway-log: ${aiGatewayLogId})`;
  }
  return { message, statusCode, aiGatewayLogId };
}

/**
 * Run a single non-streaming-style completion against a ModelHandle and return the response
 * text. Used for one-shot calls: title generation, binding naming, compaction summaries, and
 * LanguageModelBinding.run. Always requests thinking off (one-shots should be quick, and none
 * of them benefit from extended thinking; pre-pi, these calls never configured thinking either).
 * Throws AgentTurnError on provider failure, or the abort reason when `signal` fired.
 */
export async function completeText(handle: ModelHandle, args: {
  systemPrompt?: string;
  /** Convenience: wraps into a single user message. Exactly one of `prompt`/`messages` required. */
  prompt?: string;
  messages?: Message[];
  maxTokens?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const messages: Message[] = args.messages ??
      [{ role: "user", content: args.prompt ?? "", timestamp: Date.now() }];
  const stream = await handle.stream(handle.model, {
    systemPrompt: args.systemPrompt,
    messages,
  }, {
    maxTokens: args.maxTokens,
    signal: args.signal,
    thinking: false,
  });
  const message = await stream.result();
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    // Surface a cancellation as the abort reason, like a directly-aborted request would.
    args.signal?.throwIfAborted();
    const formatted = formatModelError(
        message.errorMessage ?? "The model request failed.", handle);
    throw new AgentTurnError(formatted.message, formatted.statusCode, formatted.aiGatewayLogId);
  }
  return message.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");
}
