import { waitForAI, type AIProviderConfig, type AIProvidersService } from "@obsidian-ai-providers/sdk";
import type { BetterCorrectSettings, ClassificationResult, EnrichedCandidateContext } from "./types";

interface ClassificationDependencies {
	log: (message: string, details?: unknown) => void;
}

const SYSTEM_PROMPT_BASE = [
	"You decide whether a highlighted word is genuinely misspelled.",
	"Technical terms, acronyms, package names, product names, class names, functions, and domain jargon should usually be treated as valid when context supports them.",
	"Short alphanumeric technical terms such as 4K, 8K, 1080p, 5GHz, USB-C, model numbers, CPU names, and hardware identifiers are often valid when context supports them.",
	"If the token is a common technology, hardware, display, resolution, frequency, or product term used naturally in the sentence, prefer misspelled=false.",
	"If you are uncertain, err on the side of misspelled=true.",
	"Return JSON only with keys misspelled, confidence, reason.",
	"confidence must be a number from 0 to 1.",
];

function buildSystemPrompt(settings: BetterCorrectSettings): string {
	const prompt = [...SYSTEM_PROMPT_BASE];
	if (settings.acceptCapitalizationDifferences) {
		prompt.push("If the only issue is capitalization, treat the provided spelling as valid in context.");
	}
	if (settings.customSystemPrompt.trim()) {
		prompt.push("Additional review instructions:");
		prompt.push(settings.customSystemPrompt.trim());
	}

	return prompt.join(" ");
}

function clampConfidence(value: unknown): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return 0;
	}

	return Math.max(0, Math.min(1, value));
}

export function parseClassificationResponse(raw: string): Omit<ClassificationResult, "providerName"> {
	const trimmed = raw.trim();
	const unwrapped = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	const source = unwrapped || trimmed;
	const firstBrace = source.indexOf("{");
	const lastBrace = source.lastIndexOf("}");
	const candidate = firstBrace >= 0 && lastBrace > firstBrace ? source.slice(firstBrace, lastBrace + 1) : source;

	let parsed: Partial<ClassificationResult>;
	try {
		parsed = JSON.parse(candidate) as Partial<ClassificationResult>;
	} catch (error) {
		throw new Error("AI response was not valid JSON: " + (error instanceof Error ? error.message : String(error)));
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("AI response JSON must be an object.");
	}

	return {
		misspelled: parsed.misspelled !== false,
		confidence: clampConfidence(parsed.confidence),
		reason: typeof parsed.reason === "string" ? parsed.reason : "No reason provided.",
		raw,
	};
}

export class AIClassifier {
	constructor(private readonly deps: ClassificationDependencies) {}

	private async resolveService(): Promise<AIProvidersService> {
		const resolver = await waitForAI();
		return resolver.promise;
	}

	private resolveProvider(settings: BetterCorrectSettings, service: AIProvidersService): AIProviderConfig {
		if (!service.providers.length) {
			throw new Error("No AI Providers providers are configured.");
		}

		if (!settings.providerName) {
			return service.providers[0];
		}

		return (
			service.providers.find((provider) => provider.name === settings.providerName) ??
			(() => {
				throw new Error("Configured AI provider \"" + settings.providerName + "\" was not found.");
			})()
		);
	}

	async classify(
		settings: BetterCorrectSettings,
		candidate: EnrichedCandidateContext,
		abortController: AbortController,
	): Promise<ClassificationResult> {
		const service = await this.resolveService();
		const provider = this.resolveProvider(settings, service);
		this.deps.log("Classifying word with AI", {
			provider: provider.name,
			word: candidate.normalizedWord,
			file: candidate.filePath,
			contextBefore: candidate.contextBefore,
			contextAfter: candidate.contextAfter,
		});

		const raw = await service.execute({
			provider,
			abortController,
			messages: [
				{
					role: "system",
					content: buildSystemPrompt(settings),
				},
				{
					role: "user",
					content: JSON.stringify({
						word: candidate.normalizedWord,
						filePath: candidate.filePath,
						fileTitle: candidate.fileTitle,
						contextBefore: candidate.contextBefore,
						contextAfter: candidate.contextAfter,
						sentence: candidate.sentence,
					}),
				},
			],
			options: {
				temperature: 0,
			},
		});
		this.deps.log("AI raw response", {
			word: candidate.normalizedWord,
			raw,
		});

		const parsed = parseClassificationResponse(raw);
		return {
			...parsed,
			providerName: provider.name,
		};
	}
}
