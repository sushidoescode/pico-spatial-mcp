import path from "node:path";
import { z } from "zod";

const externalAndroidExecutionSchema = z.object({
  route: z.literal("hand-authored-classic-android"),
  projectPath: z.string().min(1).refine(path.isAbsolute, "projectPath must be absolute"),
  packageName: z.string().min(1),
  launcherActivity: z.string().min(1),
}).strict();

const briefExecutionEnvelopeSchema = z.object({
  execution: externalAndroidExecutionSchema.optional(),
}).passthrough();

export type BriefExecution =
  | { route: "appspec-pipeline" }
  | z.infer<typeof externalAndroidExecutionSchema>;

/**
 * Classify how a corpus brief may be built. Briefs default to the AppSpec pipeline; an explicitly
 * hand-authored Android probe must be skipped by generic builders so a look-alike generated HUD
 * can never masquerade as the native implementation.
 */
export function classifyBriefExecution(entry: unknown): BriefExecution {
  const parsed = briefExecutionEnvelopeSchema.safeParse(entry);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "execution"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid brief execution metadata: ${issues}`);
  }
  return parsed.data.execution ?? { route: "appspec-pipeline" };
}
