/**
 * Shared domain types for the prompt-profile core.
 *
 * The core is intentionally free of any Pi runtime import so it can be unit
 * tested in isolation. The Pi adapter converts its own types into these.
 */

export type Scope = "global" | "project";

/** A profile identified by scope and local id, e.g. `global:base`. */
export interface ProfileRef {
	scope: Scope;
	id: string;
}

export type SelectionConfig =
	| { mode: "auto" }
	| { mode: "manual"; profile: string }
	| { mode: "off" };

/** How a profile applies inside a subagent run. */
export const SUBAGENT_POLICIES = ["off", "bindings", "inherit"] as const;
export type SubagentPolicy = (typeof SUBAGENT_POLICIES)[number];

/** Selection modes accepted in `config.json`. */
export const SELECTION_MODES = ["auto", "off", "manual"] as const;

/** Optional metadata for a profile, stored in `config.json`. */
export interface ProfileMeta {
	/** Single optional parent profile. Bare ids resolve inside the same scope. */
	extends?: string;
	description?: string;
}

/** One provider/model rule. Absent fields behave as `*`. */
export interface MatchRule {
	provider?: string;
	model?: string;
}

export interface Binding {
	id: string;
	profile: string;
	/** Higher wins. Missing means 0. */
	priority?: number;
	/** Rules are OR-ed; provider and model inside a rule are AND-ed. */
	match: MatchRule[];
}

/** Versioned configuration file. Only version 1 exists today. */
export interface ConfigV1 {
	version: 1;
	selection?: SelectionConfig;
	defaultProfile?: string;
	profiles?: Record<string, ProfileMeta>;
	bindings?: Binding[];
	/** Project-only. `false` disables global bindings for this project. */
	inheritGlobalBindings?: boolean;
	/**
	 * Applies in subagents. `bindings` only uses an explicit binding for the
	 * child's model, `inherit` resolves normally and `off` applies nothing.
	 */
	subagents?: SubagentPolicy;
}

export interface LoadedProfile {
	id: string;
	scope: Scope;
	path: string;
	/** Raw Markdown body, verbatim except a leading UTF-8 BOM. */
	content: string;
	hash: string;
	description?: string;
}

export interface ProfileLayer {
	ref: ProfileRef;
	content: string;
	hash: string;
}

export interface ResolvedProfile {
	ref: ProfileRef;
	/** Specific profile first, then its bases in inheritance order. */
	layers: ProfileLayer[];
}

export type DiagnosticLevel = "info" | "warn" | "error";

export interface Diagnostic {
	level: DiagnosticLevel;
	code: string;
	message: string;
}

/** A parsed config file with validation results. */
export interface SourceConfig {
	scope: Scope;
	path: string;
	exists: boolean;
	config: ConfigV1 | undefined;
	diagnostics: Diagnostic[];
}

export interface BindingMatch {
	binding: Binding;
	scope: Scope;
	rule: MatchRule;
	/** 0 = both wildcards, 3 = both exact. */
	specificity: number;
}

export interface Selection {
	mode: "auto" | "manual" | "off";
	/** Normalized reference when the mode is manual. */
	profile?: string;
}

export interface ModelIdentity {
	provider: string;
	id: string;
}

export interface Resolution {
	mode: "native" | "auto" | "manual" | "off";
	profile?: ResolvedProfile;
	binding?: BindingMatch;
	/** Matching rules that were considered but did not win. */
	ignored: BindingMatch[];
	diagnostics: Diagnostic[];
}

export interface ProfileCatalog {
	scope: Scope;
	profiles: Map<string, LoadedProfile>;
	createDiagnostics: Diagnostic[];
}
