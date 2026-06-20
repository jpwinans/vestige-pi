/**
 * Public API for the local multi-model coding pipeline (Phase 1).
 *
 * Importing this module registers pi-ai's built-in API providers transitively
 * (via the orchestrator's model imports) before any model call.
 */

export { type CallRoleOptions, callRole, RoleOutputError, type StructuredVia } from "./call-role.ts";
export {
	defaultConfig,
	type ModelEndpoint,
	type PipelineCaps,
	type PipelineConfig,
	type PipelineConfigOverrides,
	type SandboxMode,
} from "./config.ts";
export { DecisionLog, readDecisionLog, renderSummary } from "./decision-log.ts";
export { buildLocalModel, buildRoleModels, healthCheck, type RoleModels } from "./models.ts";
export { runPipeline } from "./orchestrator.ts";
export { loadPlan } from "./plan-loader.ts";
export { checkToolCall, type GateDecision, makeSafetyGate } from "./safety-gate.ts";
export type {
	DecisionEvent,
	Finding,
	Phase,
	Plan,
	PlanManifest,
	PlanTest,
	Review,
} from "./schemas.ts";
export type { EscalationContext, PipelineHooks, RunResult, RunStatus } from "./types.ts";
