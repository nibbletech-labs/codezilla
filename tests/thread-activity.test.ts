import assert from "node:assert/strict";
import test from "node:test";
import {
  parseClaudeLine,
  parseClaudeLineDetailed,
  parseCodexLine,
  parseCodexLineDetailed,
} from "../src/lib/transcriptParser.ts";
import { transcriptReducer } from "../src/lib/transcriptStateMachine.ts";
import { deriveCoreRuntimeStatus } from "../src/lib/threadActivityCore.ts";
import { getThreadSubtitle, isThreadLikelyWorking } from "../src/lib/threadRuntime.ts";
import {
  isTurnCompletionEvent,
  shouldAssignDoneBadgeOnCompletion,
  shouldPromoteToWaitingFallback,
} from "../src/lib/transcriptStatusRules.ts";
import { createInitialTranscriptInfo } from "../src/store/transcriptTypes.ts";
import type { Thread } from "../src/store/types.ts";

function makeThread(overrides: Partial<Thread>): Thread {
  return {
    id: "thread-1",
    projectId: "project-1",
    type: "codex",
    name: "Codex #1",
    sessionId: "session-1",
    claudeSessionId: null,
    codexThreadId: null,
    state: "running",
    exitCode: null,
    resuming: false,
    ...overrides,
  };
}

test("parseClaudeLine handles core activity events", () => {
  const turnStarted = parseClaudeLine(JSON.stringify({
    type: "queue-operation",
    operation: "dequeue",
  }));
  assert.deepEqual(turnStarted, { type: "turn_started" });

  const userTurnStarted = parseClaudeLine(JSON.stringify({
    type: "user",
    message: { role: "user", content: "hello" },
  }));
  assert.deepEqual(userTurnStarted, { type: "turn_started" });

  const thinkingTurnStarted = parseClaudeLine(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "reasoning..." }],
    },
  }));
  assert.deepEqual(thinkingTurnStarted, { type: "turn_started" });

  const toolUse = parseClaudeLine(JSON.stringify({
    role: "assistant",
    content: [{ type: "tool_use", id: "u1", name: "Bash", input: { command: "ls -la" } }],
  }));
  assert.deepEqual(toolUse, {
    type: "tool_use",
    id: "u1",
    name: "Bash",
    input: { command: "ls -la" },
  });

  const malformedToolUse = parseClaudeLine(JSON.stringify({
    role: "assistant",
    content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }],
  }));
  assert.equal(malformedToolUse, null);

  const toolResult = parseClaudeLine(JSON.stringify({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "u1" }],
  }));
  assert.deepEqual(toolResult, { type: "tool_result", tool_use_id: "u1" });

  const assistantText = parseClaudeLine(JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "Done" }],
  }));
  assert.deepEqual(assistantText, { type: "assistant_text" });

  const assistantWhitespaceText = parseClaudeLine(JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "\n\n" }],
  }));
  assert.equal(assistantWhitespaceText, null);

  const result = parseClaudeLine(JSON.stringify({
    type: "result",
    cost: { total_cost_usd: 1.25 },
    duration_ms: 4200,
  }));
  assert.deepEqual(result, { type: "result", cost: 1.25, duration: 4200 });

  const compaction = parseClaudeLine(JSON.stringify({
    subtype: "CompactBoundaryMessage",
    summary: { newTranscriptPath: "/tmp/new-transcript.jsonl" },
  }));
  assert.deepEqual(compaction, {
    type: "compaction",
    newTranscriptPath: "/tmp/new-transcript.jsonl",
  });
});

test("parseClaudeLineDetailed emits explicit signal metadata and idle hints", () => {
  const thinking = parseClaudeLineDetailed(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "reasoning..." }],
    },
  }));
  assert.ok(thinking);
  assert.equal(thinking.signalKey, "claude.assistant.thinking_block");
  assert.equal(thinking.signalGroup, "thinking");
  assert.equal(thinking.semanticPhase, "thinking");
  assert.equal(thinking.idleReasonHint, "none");

  const questionText = parseClaudeLineDetailed(JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "What should I do next?" }],
  }));
  assert.ok(questionText);
  assert.equal(questionText.signalKey, "claude.assistant.text");
  assert.equal(questionText.idleReasonHint, "waiting_for_input");

  const approvalToolUse = parseClaudeLineDetailed(JSON.stringify({
    role: "assistant",
    content: [{
      type: "tool_use",
      id: "u2",
      name: "exec_command",
      input: { sandbox_permissions: "require_escalated" },
    }],
  }));
  assert.ok(approvalToolUse);
  assert.equal(approvalToolUse.signalKey, "claude.assistant.tool_use");
  assert.equal(approvalToolUse.idleReasonHint, "waiting_for_approval");

  const codexOnlyPromptTool = parseClaudeLineDetailed(JSON.stringify({
    role: "assistant",
    content: [{
      type: "tool_use",
      id: "u3",
      name: "request_user_input",
      input: { question: "Proceed?" },
    }],
  }));
  assert.ok(codexOnlyPromptTool);
  assert.equal(codexOnlyPromptTool.signalKey, "claude.assistant.tool_use");
  assert.equal(codexOnlyPromptTool.idleReasonHint, "none");
});

test("parseClaudeLineDetailed handles Claude progress events", () => {
  const hookProgress = parseClaudeLineDetailed(JSON.stringify({
    type: "progress",
    data: {
      type: "hook_progress",
      hookEvent: "PostToolUse",
      hookName: "PostToolUse:Read",
      command: "callback",
    },
  }));
  assert.ok(hookProgress);
  assert.equal(hookProgress.signalKey, "claude.progress.hook");
  assert.equal(hookProgress.semanticPhase, "tooling");
  assert.equal(hookProgress.event.type, "progress_update");
  if (hookProgress.event.type === "progress_update") {
    assert.equal(hookProgress.event.label, "Running PostToolUse:Read");
  }

  const bashProgress = parseClaudeLineDetailed(JSON.stringify({
    type: "progress",
    data: {
      type: "bash_progress",
      output: "vite v5.4.21 building for production...\n✓ built in 2.36s",
      elapsedTimeSeconds: 6,
    },
  }));
  assert.ok(bashProgress);
  assert.equal(bashProgress.signalKey, "claude.progress.bash");
  assert.equal(bashProgress.semanticPhase, "tooling");
  assert.equal(bashProgress.event.type, "progress_update");
  if (bashProgress.event.type === "progress_update") {
    assert.equal(bashProgress.event.label, "✓ built in 2.36s");
  }
});

test("parseCodexLine supports current and legacy schemas", () => {
  const turnStarted = parseCodexLine(JSON.stringify({
    type: "turn.started",
  }));
  assert.deepEqual(turnStarted, { type: "turn_started" });

  const startedCurrent = parseCodexLine(JSON.stringify({
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: "call-1",
      name: "Bash",
    },
  }));
  assert.deepEqual(startedCurrent, {
    type: "command_started",
    id: "call-1",
    command: "Bash",
    target: undefined,
  });

  const completedCurrent = parseCodexLine(JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "call-1" },
  }));
  assert.deepEqual(completedCurrent, {
    type: "item_completed",
    id: "call-1",
  });

  const agentMessage = parseCodexLine(JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message" },
  }));
  assert.deepEqual(agentMessage, { type: "assistant_text" });

  const taskStarted = parseCodexLine(JSON.stringify({
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-1" },
  }));
  assert.deepEqual(taskStarted, { type: "turn_started" });

  const taskComplete = parseCodexLine(JSON.stringify({
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-1" },
  }));
  assert.deepEqual(taskComplete, { type: "turn_completed", cost: null });

  const customStarted = parseCodexLine(JSON.stringify({
    type: "response_item",
    payload: { type: "custom_tool_call", call_id: "custom-1", name: "apply_patch", input: "*** Begin Patch" },
  }));
  assert.deepEqual(customStarted, {
    type: "command_started",
    id: "custom-1",
    command: "apply_patch",
    target: undefined,
  });

  const customCompleted = parseCodexLine(JSON.stringify({
    type: "response_item",
    payload: { type: "custom_tool_call_output", call_id: "custom-1", output: "{}" },
  }));
  assert.deepEqual(customCompleted, {
    type: "item_completed",
    id: "custom-1",
  });

  const startedLegacy = parseCodexLine(JSON.stringify({
    type: "item.started",
    item: { type: "command_execution", id: "legacy-1", command: "pwd" },
  }));
  assert.deepEqual(startedLegacy, {
    type: "command_started",
    id: "legacy-1",
    command: "pwd",
  });

  const completedLegacy = parseCodexLine(JSON.stringify({
    type: "item.completed",
    item: { id: "legacy-1" },
  }));
  assert.deepEqual(completedLegacy, {
    type: "item_completed",
    id: "legacy-1",
  });

  const turnCompleted = parseCodexLine(JSON.stringify({
    type: "turn.completed",
    usage: { total_cost_usd: 0.42 },
  }));
  assert.deepEqual(turnCompleted, { type: "turn_completed", cost: 0.42 });

  const missingIdsAreIgnored = parseCodexLine(JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output" },
  }));
  assert.equal(missingIdsAreIgnored, null);
});

test("parseCodexLineDetailed emits explicit signal metadata and idle hints", () => {
  const reasoning = parseCodexLineDetailed(JSON.stringify({
    type: "response_item",
    payload: { type: "reasoning", summary: [] },
  }));
  assert.ok(reasoning);
  assert.equal(reasoning.signalKey, "codex.response.reasoning");
  assert.equal(reasoning.semanticPhase, "thinking");

  const approvalFunctionCall = parseCodexLineDetailed(JSON.stringify({
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: "call-1",
      name: "exec_command",
      arguments: JSON.stringify({ sandbox_permissions: "require_escalated" }),
    },
  }));
  assert.ok(approvalFunctionCall);
  assert.equal(approvalFunctionCall.signalKey, "codex.response.function_call");
  assert.equal(approvalFunctionCall.idleReasonHint, "waiting_for_approval");

  const questionMessage = parseCodexLineDetailed(JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Do you want to continue?" }],
    },
  }));
  assert.ok(questionMessage);
  assert.equal(questionMessage.signalKey, "codex.response.assistant_message");
  assert.equal(questionMessage.idleReasonHint, "waiting_for_input");

  const claudeOnlyPromptTool = parseCodexLineDetailed(JSON.stringify({
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: "call-2",
      name: "AskUserQuestion",
      arguments: JSON.stringify({ question: "Proceed?" }),
    },
  }));
  assert.ok(claudeOnlyPromptTool);
  assert.equal(claudeOnlyPromptTool.signalKey, "codex.response.function_call");
  assert.equal(claudeOnlyPromptTool.idleReasonHint, "none");
});

test("parseCodexLineDetailed handles agent_reasoning event", () => {
  const agentReasoning = parseCodexLineDetailed(JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_reasoning", text: "Thinking..." },
  }));
  assert.ok(agentReasoning);
  assert.equal(agentReasoning.signalKey, "codex.event.agent_reasoning");
  assert.equal(agentReasoning.semanticPhase, "thinking");
  assert.equal(agentReasoning.event.type, "turn_started");
});

test("deriveCoreRuntimeStatus is PTY-owned", () => {
  assert.equal(deriveCoreRuntimeStatus("idle", false), "idle");
  assert.equal(deriveCoreRuntimeStatus("idle", true), "working");
  assert.equal(deriveCoreRuntimeStatus("working", false), "idle");
  assert.equal(deriveCoreRuntimeStatus("exited", true), "exited");
});

test("transcriptReducer keeps PTY status and tracks Claude semantics", () => {
  let info = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Working",
  };

  info = transcriptReducer(info, { type: "turn_started" });
  assert.equal(info.status, "working");

  info = transcriptReducer(info, {
    type: "tool_use",
    id: "use-1",
    name: "Edit",
    input: { file_path: "/tmp/file-a.ts" },
  });
  assert.equal(info.status, "working");
  assert.equal(info.badge, null);
  assert.equal(info.pendingToolUseIds.size, 1);
  assert.equal(info.subtitle, "Editing file-a.ts");
  assert.equal(info.source, "transcript");
  assert.equal(info.lastToolName, "Edit");

  info = transcriptReducer(info, {
    type: "tool_use",
    id: "use-2",
    name: "Bash",
    input: { command: "npm test" },
  });
  assert.equal(info.pendingToolUseIds.size, 2);
  assert.equal(info.status, "working");
  assert.equal(info.lastToolName, "Bash");
  assert.equal(info.subtitle, "Running npm test");

  info = transcriptReducer(info, { type: "tool_result", tool_use_id: "use-1" });
  assert.equal(info.pendingToolUseIds.size, 1);
  assert.equal(info.status, "working");

  info = transcriptReducer(info, { type: "tool_result", tool_use_id: "use-2" });
  assert.equal(info.pendingToolUseIds.size, 0);
  assert.equal(info.status, "working");

  info = transcriptReducer(info, { type: "assistant_text" });
  assert.equal(info.status, "working");
  assert.equal(info.badge, null);
});

test("transcriptReducer tracks codex metadata without owning status", () => {
  let info = createInitialTranscriptInfo();

  info = transcriptReducer(info, {
    type: "command_started",
    id: "cmd-1",
    command: "npm run build",
  });
  assert.equal(info.status, "idle");
  assert.equal(info.subtitle, "Idle");
  assert.equal(info.lastToolName, "npm run build");
  assert.equal(info.pendingToolUseIds.size, 1);

  info = transcriptReducer(info, { type: "item_completed", id: "cmd-1" });
  assert.equal(info.status, "idle");
  assert.equal(info.pendingToolUseIds.size, 0);

  info = transcriptReducer(info, { type: "turn_completed", cost: 0.3 });
  assert.equal(info.status, "idle");
  assert.equal(info.costUsd, 0.3);
  assert.equal(info.idleReason, "none");
  assert.equal(info.subtitle, "Idle");

  info = transcriptReducer(info, { type: "turn_completed", cost: 0.2 });
  assert.equal(info.costUsd, 0.5);
  assert.equal(info.idleReason, "none");
  assert.equal(info.subtitle, "Idle");
});

test("transcriptReducer does not default to waiting_for_input without explicit signal", () => {
  let info = createInitialTranscriptInfo();

  info = transcriptReducer(info, { type: "assistant_text" });
  assert.equal(info.idleReason, "none");
  assert.equal(info.subtitle, "Idle");

  info = transcriptReducer(info, { type: "result", cost: null, duration: null });
  assert.equal(info.idleReason, "none");
  assert.equal(info.subtitle, "Idle");
});

test("transcriptReducer persists semantic signal diagnostics for idle reasoning", () => {
  let info = createInitialTranscriptInfo();

  const parsed = parseCodexLineDetailed(JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Do you want to allow this action?" }],
    },
  }));
  assert.ok(parsed);

  info = transcriptReducer(info, parsed.event, parsed);
  assert.equal(info.semanticSignalKey, "codex.response.assistant_message");
  assert.equal(info.semanticSignalGroup, "response");
  assert.equal(info.semanticPhase, "responding");
  assert.equal(info.idleReason, "waiting_for_approval");
  assert.equal(info.subtitle, "Waiting for approval");
});

test("parse + reducer replay contract for codex current schema", () => {
  const lines = [
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", call_id: "call-1", name: "Bash" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1" },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Build finished" }],
      },
    }),
  ];

  let info = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Working",
  };
  const statuses: string[] = [];

  for (const line of lines) {
    const event = parseCodexLine(line);
    assert.ok(event, "expected every line in this fixture to parse");
    info = transcriptReducer(info, event);
    statuses.push(info.status);
  }

  assert.deepEqual(statuses, ["working", "working", "working"]);
  assert.equal(info.pendingToolUseIds.size, 0);
});

test("phase-specific subtitles avoid generic 'Working' for tooling/responding", () => {
  let info = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Working",
  };

  const responseSignal = parseClaudeLineDetailed(JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "Let me summarize changes." }],
  }));
  assert.ok(responseSignal);
  info = transcriptReducer(info, responseSignal.event, responseSignal);
  assert.equal(info.semanticPhase, "responding");
  assert.equal(info.subtitle, "Thinking");

  const toolingSignal = parseClaudeLineDetailed(JSON.stringify({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "u1" }],
  }));
  assert.ok(toolingSignal);
  info = transcriptReducer(info, toolingSignal.event, toolingSignal);
  assert.equal(info.semanticPhase, "tooling");
  assert.equal(info.subtitle, "Using tools");
});

test("tooling subtitle prefers known tool identity over progress text", () => {
  let info = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Working",
  };

  const toolSignal = parseClaudeLineDetailed(JSON.stringify({
    role: "assistant",
    content: [{ type: "tool_use", id: "u1", name: "Read", input: { file_path: "/tmp/a.ts" } }],
  }));
  assert.ok(toolSignal);
  info = transcriptReducer(info, toolSignal.event, toolSignal);
  assert.equal(info.subtitle, "Reading a.ts");

  const progressSignal = parseClaudeLineDetailed(JSON.stringify({
    type: "progress",
    data: {
      type: "bash_progress",
      output: "• Running... (Esc to interrupt)",
      elapsedTimeSeconds: 8,
    },
  }));
  assert.ok(progressSignal);
  info = transcriptReducer(info, progressSignal.event, progressSignal);
  assert.equal(info.semanticPhase, "tooling");
  assert.equal(info.subtitle, "Reading a.ts");
});

test("getThreadSubtitle falls back cleanly for PTY lifecycle", () => {
  const shellRunning = makeThread({ type: "shell", state: "running" });
  assert.equal(getThreadSubtitle(shellRunning, null), "Idle");
  assert.equal(
    getThreadSubtitle(shellRunning, { ...createInitialTranscriptInfo(), ptyActive: true }),
    "Working",
  );

  const exitedCrashed = makeThread({ state: "exited", exitCode: 1 });
  assert.equal(getThreadSubtitle(exitedCrashed, createInitialTranscriptInfo()), "Session crashed");

  const stalePtyInfo = {
    ...createInitialTranscriptInfo(),
    status: "idle" as const,
    subtitle: "Starting...",
    source: "pty" as const,
    ptyActive: true,
  };
  assert.equal(getThreadSubtitle(makeThread({}), stalePtyInfo), "Working");

  const staleDoneInfo = {
    ...createInitialTranscriptInfo(),
    status: "idle" as const,
    subtitle: "Idle · Done",
    source: "mixed" as const,
    ptyActive: true,
  };
  assert.equal(getThreadSubtitle(makeThread({}), staleDoneInfo), "Working");

  const workingWithStaleDoneSubtitle = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Idle · Done",
    source: "mixed" as const,
    ptyActive: true,
  };
  assert.equal(getThreadSubtitle(makeThread({}), workingWithStaleDoneSubtitle), "Working");

  const transcriptInfo = {
    ...createInitialTranscriptInfo(),
    status: "idle" as const,
    subtitle: "Reading file.ts",
    source: "transcript" as const,
  };
  assert.equal(getThreadSubtitle(makeThread({}), transcriptInfo), "Reading file.ts");

  const mixedOutputInfo = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Reading file.ts",
    source: "mixed" as const,
    ptyLifecycleSource: "output" as const,
    ptyActive: false,
  };
  assert.equal(getThreadSubtitle(makeThread({}), mixedOutputInfo), "Reading file.ts");

  const markerInfo = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Reading file.ts",
    source: "mixed" as const,
    ptyLifecycleSource: "marker" as const,
    ptyActive: false,
  };
  assert.equal(getThreadSubtitle(makeThread({}), markerInfo), "Reading file.ts");

  const codexBindingPending = {
    ...createInitialTranscriptInfo(),
    status: "idle" as const,
    subtitle: "Idle",
    codexBindingState: "pending" as const,
  };
  assert.equal(getThreadSubtitle(makeThread({ type: "codex" }), codexBindingPending), "Connecting transcript");

  const codexBindingFailed = {
    ...createInitialTranscriptInfo(),
    status: "idle" as const,
    subtitle: "Idle",
    codexBindingState: "failed" as const,
  };
  assert.equal(getThreadSubtitle(makeThread({ type: "codex" }), codexBindingFailed), "Transcript unavailable");

  const recentHeartbeatInfo = {
    ...createInitialTranscriptInfo(),
    status: "idle" as const,
    subtitle: "Idle",
    semanticPhase: "unknown" as const,
    lastLineTime: Date.now(),
    lastParsedTime: null,
  };
  assert.equal(getThreadSubtitle(makeThread({ type: "codex" }), recentHeartbeatInfo), "Working");

  const staleDoneWhileStreamingInfo = {
    ...createInitialTranscriptInfo(),
    status: "idle" as const,
    subtitle: "Idle · Done",
    semanticPhase: "waiting" as const,
    idleReason: "none" as const,
    lastParsedTime: Date.now() - 5_000,
    lastLineTime: Date.now(),
  };
  assert.equal(getThreadSubtitle(makeThread({ type: "codex" }), staleDoneWhileStreamingInfo), "Working");
});

test("isThreadLikelyWorking handles stale done state while transcript is still streaming", () => {
  const thread = makeThread({ type: "codex", state: "running" });
  const now = Date.now();

  const heartbeatOnly = {
    ...createInitialTranscriptInfo(),
    status: "idle" as const,
    subtitle: "Idle",
    semanticPhase: "unknown" as const,
    lastLineTime: now,
  };
  assert.equal(isThreadLikelyWorking(thread, heartbeatOnly, now), true);

  const waitingForInput = {
    ...heartbeatOnly,
    semanticPhase: "waiting" as const,
    idleReason: "waiting_for_input" as const,
  };
  assert.equal(isThreadLikelyWorking(thread, waitingForInput, now), false);

  const staleDoneState = {
    ...heartbeatOnly,
    semanticPhase: "waiting" as const,
    idleReason: "none" as const,
    subtitle: "Idle · Done",
    lastParsedTime: now - 5_000,
  };
  assert.equal(isThreadLikelyWorking(thread, staleDoneState, now), true);

  const settledDoneState = {
    ...staleDoneState,
    lastLineTime: now - 20_000,
  };
  assert.equal(isThreadLikelyWorking(thread, settledDoneState, now), false);
});

// --- New parser tests ---

test("parseClaudeLineDetailed handles redacted_thinking blocks", () => {
  const redacted = parseClaudeLineDetailed(JSON.stringify({
    role: "assistant",
    content: [{ type: "redacted_thinking", data: "..." }],
  }));
  assert.ok(redacted);
  assert.equal(redacted.signalKey, "claude.assistant.redacted_thinking");
  assert.equal(redacted.semanticPhase, "thinking");
  assert.equal(redacted.event.type, "turn_started");
  assert.equal(redacted.confidence, "high");
});

test("parseClaudeLineDetailed handles server_tool_use (MCP) blocks", () => {
  const serverTool = parseClaudeLineDetailed(JSON.stringify({
    role: "assistant",
    content: [{ type: "server_tool_use", id: "mcp-1", name: "mcp__search__query", input: { q: "test" } }],
  }));
  assert.ok(serverTool);
  assert.equal(serverTool.signalKey, "claude.assistant.server_tool_use");
  assert.equal(serverTool.semanticPhase, "tooling");
  assert.equal(serverTool.event.type, "tool_use");
  if (serverTool.event.type === "tool_use") {
    assert.equal(serverTool.event.id, "mcp-1");
    assert.equal(serverTool.event.name, "mcp__search__query");
  }
});

test("parseClaudeLineDetailed handles system_error events", () => {
  const sysError = parseClaudeLineDetailed(JSON.stringify({
    type: "system",
    error: "Hook execution failed",
  }));
  assert.ok(sysError);
  assert.equal(sysError.signalKey, "claude.lifecycle.system_error");
  assert.equal(sysError.event.type, "system_error");
  if (sysError.event.type === "system_error") {
    assert.equal(sysError.event.message, "Hook execution failed");
  }
});

test("parseClaudeLineDetailed handles api_error events", () => {
  const apiError = parseClaudeLineDetailed(JSON.stringify({
    type: "api_error",
    error: "Rate limit exceeded",
  }));
  assert.ok(apiError);
  assert.equal(apiError.signalKey, "claude.lifecycle.api_error");
  assert.equal(apiError.event.type, "api_error");
  if (apiError.event.type === "api_error") {
    assert.equal(apiError.event.message, "Rate limit exceeded");
  }
});

test("parseClaudeLineDetailed handles summary compaction", () => {
  const summary = parseClaudeLineDetailed(JSON.stringify({
    type: "summary",
    newTranscriptPath: "/tmp/session-2.jsonl",
  }));
  assert.ok(summary);
  assert.equal(summary.signalKey, "claude.lifecycle.summary");
  assert.equal(summary.event.type, "compaction");

  // Summary without newTranscriptPath signals in-place context compaction
  const noPath = parseClaudeLineDetailed(JSON.stringify({
    type: "summary",
    sessionId: null,
  }));
  assert.ok(noPath);
  assert.equal(noPath.event.type, "context_compacted");
});

test("parseCodexLineDetailed handles request_user_input event", () => {
  const input = parseCodexLineDetailed(JSON.stringify({
    type: "event_msg",
    payload: { type: "request_user_input", prompt: "Enter your choice" },
  }));
  assert.ok(input);
  assert.equal(input.signalKey, "codex.event.user_input_request");
  assert.equal(input.idleReasonHint, "waiting_for_input");
});

test("parseCodexLineDetailed handles task lifecycle events", () => {
  const started = parseCodexLineDetailed(JSON.stringify({
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-1" },
  }));
  assert.ok(started);
  assert.equal(started.signalKey, "codex.event.task_started");
  assert.equal(started.event.type, "turn_started");

  const completed = parseCodexLineDetailed(JSON.stringify({
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "All set." },
  }));
  assert.ok(completed);
  assert.equal(completed.signalKey, "codex.event.task_complete");
  assert.equal(completed.event.type, "turn_completed");
});

test("parseCodexLineDetailed handles custom tool call events", () => {
  const started = parseCodexLineDetailed(JSON.stringify({
    type: "response_item",
    payload: { type: "custom_tool_call", call_id: "custom-1", name: "apply_patch", input: "*** Begin Patch" },
  }));
  assert.ok(started);
  assert.equal(started.signalKey, "codex.response.custom_tool_call");
  assert.equal(started.event.type, "command_started");
  if (started.event.type === "command_started") {
    assert.equal(started.event.id, "custom-1");
    assert.equal(started.event.command, "apply_patch");
  }

  const completed = parseCodexLineDetailed(JSON.stringify({
    type: "response_item",
    payload: { type: "custom_tool_call_output", call_id: "custom-1", output: "{}" },
  }));
  assert.ok(completed);
  assert.equal(completed.signalKey, "codex.response.custom_tool_call_output");
  assert.equal(completed.event.type, "item_completed");
});

test("parseCodexLineDetailed handles turn_aborted event", () => {
  const aborted = parseCodexLineDetailed(JSON.stringify({
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: "turn-1", reason: "interrupted" },
  }));
  assert.ok(aborted);
  assert.equal(aborted.signalKey, "codex.event.turn_aborted");
  assert.equal(aborted.event.type, "turn_failed");
  if (aborted.event.type === "turn_failed") {
    assert.equal(aborted.event.error, "interrupted");
  }
});

test("parseCodexLineDetailed handles elicitation_request event", () => {
  const elicit = parseCodexLineDetailed(JSON.stringify({
    type: "event_msg",
    payload: { type: "elicitation_request", options: ["A", "B"] },
  }));
  assert.ok(elicit);
  assert.equal(elicit.signalKey, "codex.event.user_input_request");
  assert.equal(elicit.idleReasonHint, "waiting_for_input");
});

test("parseCodexLineDetailed handles turn_failed event", () => {
  const failed = parseCodexLineDetailed(JSON.stringify({
    type: "turn.failed",
    error: "Context window exceeded",
  }));
  assert.ok(failed);
  assert.equal(failed.signalKey, "codex.lifecycle.turn_failed");
  assert.equal(failed.event.type, "turn_failed");
  if (failed.event.type === "turn_failed") {
    assert.equal(failed.event.error, "Context window exceeded");
  }
});

test("parseCodexLineDetailed handles context_compacted event", () => {
  const compacted = parseCodexLineDetailed(JSON.stringify({
    type: "context.compacted",
  }));
  assert.ok(compacted);
  assert.equal(compacted.signalKey, "codex.lifecycle.context_compacted");
  assert.equal(compacted.event.type, "context_compacted");
});

test("parseCodexLineDetailed handles web_search_call event", () => {
  const ws = parseCodexLineDetailed(JSON.stringify({
    type: "response_item",
    payload: { type: "web_search_call", id: "ws-1" },
  }));
  assert.ok(ws);
  assert.equal(ws.signalKey, "codex.response.web_search");
  assert.equal(ws.event.type, "command_started");
  if (ws.event.type === "command_started") {
    assert.equal(ws.event.command, "web_search");
  }
});

test("parseCodexLineDetailed handles file_search_call event", () => {
  const fs = parseCodexLineDetailed(JSON.stringify({
    type: "response_item",
    payload: { type: "file_search_call", id: "fs-1" },
  }));
  assert.ok(fs);
  assert.equal(fs.signalKey, "codex.response.file_search");
  assert.equal(fs.event.type, "command_started");
  if (fs.event.type === "command_started") {
    assert.equal(fs.event.command, "file_search");
  }
});

// --- Ignored sentinel tests ---

test("intentionally ignored lines return ignored sentinel (not null)", () => {
  // Claude ignored types
  const system = parseClaudeLineDetailed(JSON.stringify({ type: "system", message: "info" }));
  assert.ok(system);
  assert.equal(system.event.type, "ignored");

  const ping = parseClaudeLineDetailed(JSON.stringify({ type: "ping" }));
  assert.ok(ping);
  assert.equal(ping.event.type, "ignored");

  const config = parseClaudeLineDetailed(JSON.stringify({ type: "config", data: {} }));
  assert.ok(config);
  assert.equal(config.event.type, "ignored");

  const streamEvent = parseClaudeLineDetailed(JSON.stringify({ type: "stream_event" }));
  assert.ok(streamEvent);
  assert.equal(streamEvent.event.type, "ignored");

  // Codex ignored types
  const threadStarted = parseCodexLineDetailed(JSON.stringify({ type: "thread.started" }));
  assert.ok(threadStarted);
  assert.equal(threadStarted.event.type, "ignored");

  const sessionStarted = parseCodexLineDetailed(JSON.stringify({ type: "session.started" }));
  assert.ok(sessionStarted);
  assert.equal(sessionStarted.event.type, "ignored");

  const messageDelta = parseCodexLineDetailed(JSON.stringify({ type: "message.delta" }));
  assert.ok(messageDelta);
  assert.equal(messageDelta.event.type, "ignored");
});

test("backward-compat wrappers filter out ignored events", () => {
  // parseClaudeLine returns null for ignored types
  assert.equal(parseClaudeLine(JSON.stringify({ type: "ping" })), null);
  assert.equal(parseClaudeLine(JSON.stringify({ type: "config" })), null);
  assert.equal(parseClaudeLine(JSON.stringify({ type: "system", message: "info" })), null);

  // parseCodexLine returns null for ignored types
  assert.equal(parseCodexLine(JSON.stringify({ type: "thread.started" })), null);
  assert.equal(parseCodexLine(JSON.stringify({ type: "session.started" })), null);
});

// --- Heuristic fix tests ---

test("isClaudeApprovalLikeText no longer matches past-tense approval references", () => {
  // Past-tense should NOT trigger waiting_for_approval
  const pastTense = parseClaudeLineDetailed(JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "I've approved the changes and they look good." }],
  }));
  assert.ok(pastTense);
  assert.equal(pastTense.idleReasonHint, "none");

  // Direct approval prompt should still match
  const directPrompt = parseClaudeLineDetailed(JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "Do you want to allow this action?" }],
  }));
  assert.ok(directPrompt);
  assert.equal(directPrompt.idleReasonHint, "waiting_for_approval");
});

test("isQuestionLikeText no longer matches long single paragraphs ending with ?", () => {
  // Single long paragraph (>200 chars) ending with ? should NOT trigger waiting_for_input
  const longText = "A".repeat(180) + " so what do you think about this approach to the problem?";
  const longParagraph = parseClaudeLineDetailed(JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: longText }],
  }));
  assert.ok(longParagraph);
  assert.equal(longParagraph.idleReasonHint, "none");

  // Short question should still match
  const shortQuestion = parseClaudeLineDetailed(JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "Should I continue?" }],
  }));
  assert.ok(shortQuestion);
  assert.equal(shortQuestion.idleReasonHint, "waiting_for_input");
});

test("isQuestionLikeText detects question in last paragraph of long response", () => {
  // Long response with a short question paragraph at the end
  const longResponse = "I've updated all the files and here's what changed:\n\n"
    + "1. Fixed the state machine reducer\n"
    + "2. Updated the parser with new event types\n"
    + "3. Added comprehensive tests\n\n"
    + "How are the status updates looking? Want me to do another round of tool calls to test different states?";
  const parsed = parseClaudeLineDetailed(JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: longResponse }],
  }));
  assert.ok(parsed);
  assert.equal(parsed.idleReasonHint, "waiting_for_input");
});

test("Claude direct-input request text without a question mark maps to waiting_for_input", () => {
  const parsed = parseClaudeLineDetailed(JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "Tell me which option you'd like and I'll apply it." }],
  }));
  assert.ok(parsed);
  assert.equal(parsed.idleReasonHint, "waiting_for_input");
});

test("turn completion rule helpers keep done logic deterministic", () => {
  const now = Date.now();
  const baseInfo = {
    ...createInitialTranscriptInfo(),
    parserHealth: "healthy" as const,
    semanticPhase: "responding" as const,
    status: "idle" as const,
    ptyActive: false,
    idleReason: "none" as const,
    lastError: null,
    pendingToolUseIds: new Set<string>(),
    lastEventTime: now - 2500,
    lastLineTime: now - 2500,
  };

  assert.equal(isTurnCompletionEvent({ type: "result", cost: null, duration: null }), true);
  assert.equal(isTurnCompletionEvent({ type: "turn_completed", cost: null }), true);
  assert.equal(isTurnCompletionEvent({ type: "assistant_text" }), false);

  assert.equal(shouldAssignDoneBadgeOnCompletion(baseInfo, "claude"), true);
  assert.equal(shouldAssignDoneBadgeOnCompletion({ ...baseInfo, idleReason: "waiting_for_input" }, "claude"), false);
  assert.equal(shouldAssignDoneBadgeOnCompletion({ ...baseInfo, ptyActive: true }, "claude"), false);

  assert.equal(shouldPromoteToWaitingFallback(baseInfo, "codex", now, 2000), true);
  assert.equal(shouldPromoteToWaitingFallback(baseInfo, "claude", now, 2000), true);
  assert.equal(
    shouldPromoteToWaitingFallback({ ...baseInfo, parserHealth: "degraded" }, "codex", now, 2000),
    false,
  );
});

// --- Reducer fix tests ---

test("idle reason persists through result event within the same turn", () => {
  let info = createInitialTranscriptInfo();

  // Set waiting_for_input via question text signal
  const questionSignal = parseClaudeLineDetailed(JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "What should I do next?" }],
  }));
  assert.ok(questionSignal);
  info = transcriptReducer(info, questionSignal.event, questionSignal);
  assert.equal(info.idleReason, "waiting_for_input");

  // Result event (waiting phase, hint "none") should preserve the idle reason
  const resultSignal = parseClaudeLineDetailed(JSON.stringify({
    type: "result",
    cost: { total_cost_usd: 0.05 },
    duration_ms: 1000,
  }));
  assert.ok(resultSignal);
  info = transcriptReducer(info, resultSignal.event, resultSignal);
  assert.equal(info.idleReason, "waiting_for_input");
  assert.equal(info.semanticPhase, "waiting");
  assert.equal(info.subtitle, "Waiting for input");
});

test("idle reason is cleared by new turn start", () => {
  let info = createInitialTranscriptInfo();

  // Set waiting_for_approval
  const approvalSignal = parseCodexLineDetailed(JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Do you want to allow this action?" }],
    },
  }));
  assert.ok(approvalSignal);
  info = transcriptReducer(info, approvalSignal.event, approvalSignal);
  assert.equal(info.idleReason, "waiting_for_approval");

  // New turn clears idle reason
  const turnSignal = parseClaudeLineDetailed(JSON.stringify({
    type: "queue-operation",
    operation: "dequeue",
  }));
  assert.ok(turnSignal);
  info = transcriptReducer(info, turnSignal.event, turnSignal);
  assert.equal(info.idleReason, "none");
});

test("idle reason is cleared by non-waiting phase events", () => {
  let info = createInitialTranscriptInfo();

  // Set waiting_for_approval
  const approvalSignal = parseCodexLineDetailed(JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Do you want to allow this action?" }],
    },
  }));
  assert.ok(approvalSignal);
  info = transcriptReducer(info, approvalSignal.event, approvalSignal);
  assert.equal(info.idleReason, "waiting_for_approval");

  // A tool_result (tooling phase, hint "none") clears it
  const toolSignal = parseClaudeLineDetailed(JSON.stringify({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "u1" }],
  }));
  assert.ok(toolSignal);
  info = transcriptReducer(info, toolSignal.event, toolSignal);
  assert.equal(info.idleReason, "none");
});

test("Codex command_started preserves actual tool name for subtitle derivation", () => {
  let info = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Working",
  };

  // Modern schema: function_call with name "Read"
  const readSignal = parseCodexLineDetailed(JSON.stringify({
    type: "response_item",
    payload: { type: "function_call", call_id: "call-r1", name: "Read" },
  }));
  assert.ok(readSignal);
  info = transcriptReducer(info, readSignal.event, readSignal);
  assert.equal(info.lastToolName, "Read");
  assert.equal(info.subtitle, "Reading");
});

test("waiting phase shows 'Idle · Done' subtitle", () => {
  let info = createInitialTranscriptInfo();

  const resultSignal = parseClaudeLineDetailed(JSON.stringify({
    type: "result",
    cost: { total_cost_usd: 0.1 },
    duration_ms: 500,
  }));
  assert.ok(resultSignal);
  info = transcriptReducer(info, resultSignal.event, resultSignal);
  assert.equal(info.semanticPhase, "waiting");
  assert.equal(info.idleReason, "none");
  assert.equal(info.subtitle, "Idle · Done");
});

test("signal confidence is propagated to TranscriptInfo", () => {
  let info = createInitialTranscriptInfo();
  assert.equal(info.signalConfidence, null);

  const thinking = parseClaudeLineDetailed(JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "reasoning..." }],
    },
  }));
  assert.ok(thinking);
  assert.equal(thinking.confidence, "high");

  info = transcriptReducer(info, thinking.event, thinking);
  assert.equal(info.signalConfidence, "high");
});

test("system_error and api_error events clear pending tools in reducer", () => {
  let info = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Working",
  };

  // Add a pending tool
  info = transcriptReducer(info, {
    type: "tool_use",
    id: "use-1",
    name: "Bash",
    input: { command: "npm test" },
  });
  assert.equal(info.pendingToolUseIds.size, 1);
  assert.equal(info.lastToolName, "Bash");

  // system_error should clear pending tools
  info = transcriptReducer(info, { type: "system_error", message: "Hook failed" });
  assert.equal(info.pendingToolUseIds.size, 0);
  assert.equal(info.lastToolName, null);
});

test("createInitialTranscriptInfo starts with 'initial' semanticPhase", () => {
  const info = createInitialTranscriptInfo();
  assert.equal(info.semanticPhase, "initial");
  assert.equal(info.signalConfidence, null);
  assert.equal(info.ignoredLineCount, 0);
});

// --- Error badge + plan progress tests ---

test("error events set lastError in reducer; turn_started clears it", () => {
  let info = createInitialTranscriptInfo();

  // system_error sets lastError
  info = transcriptReducer(info, { type: "system_error", message: "Hook failed" });
  assert.ok(info.lastError);
  assert.equal(info.lastError.message, "Hook failed");

  // turn_started clears lastError
  info = transcriptReducer(info, { type: "turn_started" });
  assert.equal(info.lastError, null);
});

test("api_error and turn_failed also set lastError", () => {
  let info = createInitialTranscriptInfo();

  info = transcriptReducer(info, { type: "api_error", message: "Rate limit exceeded" });
  assert.ok(info.lastError);
  assert.equal(info.lastError.message, "Rate limit exceeded");

  info = createInitialTranscriptInfo();
  info = transcriptReducer(info, { type: "turn_failed", error: "Context window exceeded" });
  assert.ok(info.lastError);
  assert.equal(info.lastError.message, "Context window exceeded");

  // turn_failed with null error uses fallback message
  info = createInitialTranscriptInfo();
  info = transcriptReducer(info, { type: "turn_failed", error: null });
  assert.ok(info.lastError);
  assert.equal(info.lastError.message, "Turn failed");
});

test("error subtitle shows 'Error' instead of 'Idle · Done' when lastError is set", () => {
  let info = createInitialTranscriptInfo();

  // First get to waiting phase via a result event
  const resultSignal = parseClaudeLineDetailed(JSON.stringify({
    type: "result",
    cost: { total_cost_usd: 0.1 },
    duration_ms: 500,
  }));
  assert.ok(resultSignal);
  info = transcriptReducer(info, resultSignal.event, resultSignal);
  assert.equal(info.subtitle, "Idle · Done");

  // Now simulate an error in waiting phase
  info = transcriptReducer(info, { type: "api_error", message: "Rate limit" });
  assert.equal(info.semanticPhase, "waiting");
  assert.equal(info.subtitle, "Error");
});

test("TodoWrite tool_use sets planProgress as authoritative snapshot", () => {
  let info = createInitialTranscriptInfo();

  info = transcriptReducer(info, {
    type: "tool_use",
    id: "todo-1",
    name: "TodoWrite",
    input: {
      todos: [
        { id: "1", subject: "Step 1", status: "completed" },
        { id: "2", subject: "Step 2", status: "in_progress" },
        { id: "3", subject: "Step 3", status: "pending" },
      ],
    },
  });
  assert.ok(info.planProgress);
  assert.equal(info.planProgress.total, 3);
  assert.equal(info.planProgress.done, 1);
});

test("plan progress appended to subtitle as (done/total)", () => {
  let info = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Working",
  };

  info = transcriptReducer(info, {
    type: "tool_use",
    id: "todo-1",
    name: "TodoWrite",
    input: {
      todos: [
        { id: "1", subject: "Step 1", status: "completed" },
        { id: "2", subject: "Step 2", status: "pending" },
        { id: "3", subject: "Step 3", status: "pending" },
      ],
    },
  });
  // Subtitle should include plan progress (display = min(done+1, total) = 2)
  assert.ok(info.subtitle.includes("(2/3)"), `expected subtitle to include (2/3), got: ${info.subtitle}`);
});

test("TaskCreate increments planProgress.total", () => {
  let info = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Working",
  };

  info = transcriptReducer(info, {
    type: "tool_use",
    id: "tc-1",
    name: "TaskCreate",
    input: { subject: "Step 1", description: "Do step 1" },
  });
  assert.ok(info.planProgress);
  assert.equal(info.planProgress.total, 1);
  assert.equal(info.planProgress.done, 0);
  assert.ok(info.subtitle.includes("(1/1)"), `expected (1/1), got: ${info.subtitle}`);
  assert.ok(info.subtitle.startsWith("Planning"), `expected 'Planning', got: ${info.subtitle}`);

  info = transcriptReducer(info, {
    type: "tool_use",
    id: "tc-2",
    name: "TaskCreate",
    input: { subject: "Step 2", description: "Do step 2" },
  });
  assert.equal(info.planProgress!.total, 2);
  assert.equal(info.planProgress!.done, 0);
  assert.ok(info.subtitle.includes("(1/2)"), `expected (1/2), got: ${info.subtitle}`);
});

test("TaskUpdate with status completed increments planProgress.done", () => {
  let info = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Working",
    planProgress: { total: 3, done: 0 },
  };

  info = transcriptReducer(info, {
    type: "tool_use",
    id: "tu-1",
    name: "TaskUpdate",
    input: { taskId: "1", status: "completed" },
  });
  assert.equal(info.planProgress!.total, 3);
  assert.equal(info.planProgress!.done, 1);
  assert.ok(info.subtitle.includes("(2/3)"), `expected (2/3), got: ${info.subtitle}`);
  assert.ok(info.subtitle.startsWith("Executing plan"), `expected 'Executing plan', got: ${info.subtitle}`);
});

test("TaskUpdate with status deleted decrements planProgress.total", () => {
  let info = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Working",
    planProgress: { total: 3, done: 1 },
  };

  info = transcriptReducer(info, {
    type: "tool_use",
    id: "tu-2",
    name: "TaskUpdate",
    input: { taskId: "2", status: "deleted" },
  });
  assert.equal(info.planProgress!.total, 2);
  assert.equal(info.planProgress!.done, 1);

  // Floor at 0
  info = { ...info, planProgress: { total: 0, done: 0 } };
  info = transcriptReducer(info, {
    type: "tool_use",
    id: "tu-3",
    name: "TaskUpdate",
    input: { taskId: "3", status: "deleted" },
  });
  assert.equal(info.planProgress!.total, 0);
});

test("plan progress accumulates across turns (not cleared by turn_started)", () => {
  let info = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Working",
  };

  // Turn 1: create 2 tasks
  info = transcriptReducer(info, {
    type: "tool_use",
    id: "tc-a",
    name: "TaskCreate",
    input: { subject: "A", description: "Task A" },
  });
  info = transcriptReducer(info, {
    type: "tool_use",
    id: "tc-b",
    name: "TaskCreate",
    input: { subject: "B", description: "Task B" },
  });
  assert.equal(info.planProgress!.total, 2);
  assert.equal(info.planProgress!.done, 0);

  // Turn boundary — progress must survive
  info = transcriptReducer(info, { type: "turn_started" });
  assert.ok(info.planProgress, "planProgress must not be cleared by turn_started");
  assert.equal(info.planProgress!.total, 2);
  assert.equal(info.planProgress!.done, 0);

  // Turn 2: complete one
  info = transcriptReducer(info, {
    type: "tool_use",
    id: "tu-c",
    name: "TaskUpdate",
    input: { taskId: "a", status: "completed" },
  });
  assert.equal(info.planProgress!.total, 2);
  assert.equal(info.planProgress!.done, 1);
});

test("TodoWrite still overwrites incremental task progress with authoritative snapshot", () => {
  let info = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Working",
    planProgress: { total: 5, done: 2 },
  };

  // TodoWrite provides authoritative state — overwrites incremental counts
  info = transcriptReducer(info, {
    type: "tool_use",
    id: "tw-1",
    name: "TodoWrite",
    input: {
      todos: [
        { id: "1", subject: "A", status: "completed" },
        { id: "2", subject: "B", status: "completed" },
        { id: "3", subject: "C", status: "pending" },
      ],
    },
  });
  assert.equal(info.planProgress!.total, 3);
  assert.equal(info.planProgress!.done, 2);
});

test("TaskUpdate with non-terminal status does not change progress", () => {
  let info = {
    ...createInitialTranscriptInfo(),
    status: "working" as const,
    subtitle: "Working",
    planProgress: { total: 3, done: 1 },
  };

  info = transcriptReducer(info, {
    type: "tool_use",
    id: "tu-ip",
    name: "TaskUpdate",
    input: { taskId: "2", status: "in_progress" },
  });
  assert.equal(info.planProgress!.total, 3);
  assert.equal(info.planProgress!.done, 1);
});

// --- False "waiting for approval" regression test ---

test("speculative waiting_for_approval from tool_use is cleared by tool_result", () => {
  let info = createInitialTranscriptInfo();

  // Write tool_use sets speculative waiting_for_approval via signal hint
  const writeSignal = parseClaudeLineDetailed(JSON.stringify({
    role: "assistant",
    content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "/tmp/a.ts" } }],
  }));
  assert.ok(writeSignal);
  info = transcriptReducer(info, writeSignal.event, writeSignal);
  // The signal may set waiting_for_approval speculatively
  const reasonAfterToolUse = info.idleReason;

  // tool_result should clear idle reason unconditionally (belt-and-suspenders)
  const resultSignal = parseClaudeLineDetailed(JSON.stringify({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "w1" }],
  }));
  assert.ok(resultSignal);
  info = transcriptReducer(info, resultSignal.event, resultSignal);
  assert.equal(info.idleReason, "none", `expected idleReason cleared after tool_result, was "${reasonAfterToolUse}" -> "${info.idleReason}"`);
  assert.equal(info.pendingToolUseIds.size, 0);
});
