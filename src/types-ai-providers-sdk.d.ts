declare module "@obsidian-ai-providers/sdk" {
	import type { App, Plugin } from "obsidian";

	export interface AIProviderConfig {
		id: string;
		name: string;
		type: string;
		url?: string;
		model?: string;
		apiKey?: string;
		availableModels?: string[];
	}

	export interface AIProvidersService {
		providers: AIProviderConfig[];
		version: number;
		execute(request: {
			provider: AIProviderConfig;
			messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
			abortController?: AbortController;
			onProgress?: (chunk: string, accumulated: string) => void;
			options?: Record<string, unknown>;
		}): Promise<string>;
	}

	export function initAI(app: App, plugin: Plugin, callback: () => Promise<void> | void): Promise<void>;
	export function waitForAI(): Promise<{ promise: Promise<AIProvidersService> }>;
}
