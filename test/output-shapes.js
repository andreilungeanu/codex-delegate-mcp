import { z } from "zod";

// The result shapes, parsed .strict() against what each tool returns. No tool declares an
// outputSchema: it requires structuredContent too, and a host that reads both (Codex) puts the
// payload in context twice. Field meanings are in skills/delegate/reference.md.
export const delegateOutputShape = {
  result: z.string(),
  status: z.enum(["completed", "failed", "interrupted"]),
  reason: z
    .enum([
      "cancelled",
      "startup-timeout",
      "hard-cap",
      "agent-error",
      "died-mid-turn",
      "exit-nonzero",
      "result-unavailable",
    ])
    .optional(),
  threadId: z.string().optional(),
  delegationId: z.string().optional(),
  resumed: z.boolean().optional(),
  workspace: z.string(),
  cliVersion: z.string().optional(),
  usage: z
    .object({
      scope: z.literal("thread"),
      inputTokens: z.number().optional(),
      cachedInputTokens: z.number().optional(),
      cacheWriteInputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      reasoningOutputTokens: z.number().optional(),
    })
    .optional(),
  filesReportedByEditTools: z.array(z.string()).optional(),
  plan: z
    .object({
      overview: z.string(),
      steps: z.array(
        z.object({
          title: z.string(),
          detail: z.string(),
        })
      ),
    })
    .optional(),
  warnings: z.array(z.string()).optional(),
  exitCode: z.number().int().optional(),
};
