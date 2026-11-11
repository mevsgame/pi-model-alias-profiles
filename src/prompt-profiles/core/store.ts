import { loadConfigFile } from "./config.js";
import { configPath, globalRoot, projectRoot } from "./paths.js";
import { loadProfiles } from "./profiles.js";
import type { Diagnostic, ProfileCatalog, SourceConfig } from "./types.js";

export interface LoadedState {
	cwd: string;
	agentDir: string;
	configDirName: string;
	projectTrusted: boolean;
	globalConfig: SourceConfig;
	projectConfig: SourceConfig;
	globalProfiles: ProfileCatalog;
	projectProfiles: ProfileCatalog;
	diagnostics: Diagnostic[];
}

export function emptyProjectConfig(
	cwd: string,
	configDirName: string,
): SourceConfig {
	return {
		scope: "project",
		path: configPath(projectRoot(cwd, configDirName)),
		exists: false,
		config: undefined,
		diagnostics: [],
	};
}

function emptyProjectProfiles(): ProfileCatalog {
	return { scope: "project", profiles: new Map(), createDiagnostics: [] };
}

export interface LoadStateOptions {
	cwd: string;
	agentDir: string;
	configDirName: string;
	projectTrusted: boolean;
}

/**
 * Reads global state always, and project state only when the project is
 * trusted. An untrusted project contributes nothing: no config, no profiles.
 */
export function loadState(options: LoadStateOptions): LoadedState {
	const { cwd, agentDir, configDirName, projectTrusted } = options;

	const globalConfig = loadConfigFile(
		configPath(globalRoot(agentDir)),
		"global",
	);
	const globalProfiles = loadProfiles(
		globalRoot(agentDir),
		"global",
		globalConfig.config?.profiles,
	);

	let projectConfig = emptyProjectConfig(cwd, configDirName);
	let projectProfiles = emptyProjectProfiles();
	if (projectTrusted) {
		projectConfig = loadConfigFile(
			configPath(projectRoot(cwd, configDirName)),
			"project",
		);
		projectProfiles = loadProfiles(
			projectRoot(cwd, configDirName),
			"project",
			projectConfig.config?.profiles,
		);
	}

	const diagnostics: Diagnostic[] = [
		...globalConfig.diagnostics,
		...globalProfiles.createDiagnostics,
		...projectConfig.diagnostics,
		...projectProfiles.createDiagnostics,
	];

	return {
		cwd,
		agentDir,
		configDirName,
		projectTrusted,
		globalConfig,
		projectConfig,
		globalProfiles,
		projectProfiles,
		diagnostics,
	};
}
