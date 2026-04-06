export interface AuditEntry {
	id: string;
	word: string;
	dictionaryWords: string[];
	filePath: string;
	fileTitle: string;
	contextBefore: string;
	contextAfter: string;
	reason: string;
	confidence: number;
	timestamp: number;
	providerName: string;
	addedVia: "auto" | "manual" | "fallback" | "existing";
}

export interface BetterCorrectSettings {
	autoAdd: boolean;
	askBeforeAdding: boolean;
	delayMs: number;
	minConfidence: number;
	confirmationConfidence: number;
	maxWordLength: number;
	allowlistPatterns: string[];
	blocklistPatterns: string[];
	acronymOnlyMode: boolean;
	allowLowercaseAbbreviations: boolean;
	acceptCapitalizationDifferences: boolean;
	showSuccessfulAddNotices: boolean;
	showFailedAddNotices: boolean;
	debugLogging: boolean;
	providerName: string;
	customSystemPrompt: string;
	auditLog: AuditEntry[];
	maxAuditEntries: number;
}

export interface CandidateRange {
	from: number;
	to: number;
}

export interface CandidateContext {
	filePath: string;
	fileTitle: string;
	line: number;
	range: CandidateRange;
	word: string;
	normalizedWord: string;
}

export interface EnrichedCandidateContext extends CandidateContext {
	contextBefore: string;
	contextAfter: string;
	sentence: string;
}

export interface ClassificationResult {
	misspelled: boolean;
	confidence: number;
	reason: string;
	raw: string;
	providerName: string;
}

export interface WordDecision {
	key: string;
	result: ClassificationResult;
	timestamp: number;
}
