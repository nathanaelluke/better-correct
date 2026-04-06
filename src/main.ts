import { initAI, type AIProviderConfig } from "@obsidian-ai-providers/sdk";
import {
	App,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	WorkspaceLeaf,
} from "obsidian";
import { AIClassifier } from "./ai-classifier";
import { AuditStore } from "./audit-log";
import {
	cacheKey,
	candidateKey,
	detectCandidateAtCursor,
	enrichCandidateContext,
	scanDocumentCandidates,
	scanDocumentCandidatesInRange,
} from "./candidate-detector";
import { DictionaryManager } from "./dictionary-manager";
import { BetterCorrectReviewView, REVIEW_VIEW_TYPE } from "./review-view";
import { BetterCorrectSettingTab } from "./settings";
import { SpellService } from "./spell-service";
import type { AuditEntry, BetterCorrectSettings, CandidateContext, EnrichedCandidateContext, WordDecision } from "./types";

const DEFAULT_SETTINGS: Readonly<BetterCorrectSettings> = {
	autoAdd: true,
	askBeforeAdding: false,
	delayMs: 5000,
	minConfidence: 0.84,
	confirmationConfidence: 0.92,
	maxWordLength: 48,
	allowlistPatterns: [
		"^[A-Z]{2,}$",
		"^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$",
		"^[a-z0-9]+(?:-[a-z0-9]+)+$",
	],
	blocklistPatterns: [
		"^[a-z]{1,3}$",
		"^[A-Z][a-z]{0,2}$",
	],
	acronymOnlyMode: false,
	allowLowercaseAbbreviations: false,
	acceptCapitalizationDifferences: false,
	showSuccessfulAddNotices: true,
	showFailedAddNotices: true,
	debugLogging: false,
	providerName: "",
	customSystemPrompt: "",
	auditLog: [],
	maxAuditEntries: 200,
};

function cloneDefaultSettings(): BetterCorrectSettings {
	return {
		...DEFAULT_SETTINGS,
		allowlistPatterns: [...DEFAULT_SETTINGS.allowlistPatterns],
		blocklistPatterns: [...DEFAULT_SETTINGS.blocklistPatterns],
		auditLog: [...DEFAULT_SETTINGS.auditLog],
	};
}

function sanitizeSettings(loaded: Partial<BetterCorrectSettings> | null): BetterCorrectSettings {
	const defaults = cloneDefaultSettings();
	const coerceNumber = (value: unknown, fallback: number, predicate: (candidate: number) => boolean): number => {
		return typeof value === "number" && Number.isFinite(value) && predicate(value) ? value : fallback;
	};
	const coerceStringArray = (value: unknown, fallback: string[]): string[] => {
		return Array.isArray(value) ? value.filter((candidate): candidate is string => typeof candidate === "string") : [...fallback];
	};
	const auditLog = Array.isArray(loaded?.auditLog)
		? loaded.auditLog.flatMap((entry): AuditEntry[] => {
			if (
				!entry ||
				typeof entry.id !== "string" ||
				typeof entry.word !== "string" ||
				typeof entry.filePath !== "string" ||
				typeof entry.fileTitle !== "string" ||
				typeof entry.contextBefore !== "string" ||
				typeof entry.contextAfter !== "string" ||
				typeof entry.reason !== "string" ||
				typeof entry.confidence !== "number" ||
				typeof entry.timestamp !== "number" ||
				typeof entry.providerName !== "string" ||
				(entry.addedVia !== "auto" && entry.addedVia !== "manual" && entry.addedVia !== "fallback" && entry.addedVia !== "existing")
			) {
				return [];
			}

			const dictionaryWords = Array.isArray(entry.dictionaryWords)
				? entry.dictionaryWords.filter((word): word is string => typeof word === "string" && word.length > 0)
				: [];
			return [{
				...entry,
				dictionaryWords,
			}];
		})
		: defaults.auditLog;

	return {
		...defaults,
		autoAdd: typeof loaded?.autoAdd === "boolean" ? loaded.autoAdd : defaults.autoAdd,
		askBeforeAdding: typeof loaded?.askBeforeAdding === "boolean" ? loaded.askBeforeAdding : defaults.askBeforeAdding,
		delayMs: coerceNumber(loaded?.delayMs, defaults.delayMs, (value) => value >= 0),
		minConfidence: coerceNumber(loaded?.minConfidence, defaults.minConfidence, (value) => value >= 0 && value <= 1),
		confirmationConfidence: coerceNumber(
			loaded?.confirmationConfidence,
			defaults.confirmationConfidence,
			(value) => value >= 0 && value <= 1,
		),
		maxWordLength: coerceNumber(loaded?.maxWordLength, defaults.maxWordLength, (value) => value > 0),
		allowlistPatterns: coerceStringArray(loaded?.allowlistPatterns, defaults.allowlistPatterns),
		blocklistPatterns: coerceStringArray(loaded?.blocklistPatterns, defaults.blocklistPatterns),
		acronymOnlyMode: typeof loaded?.acronymOnlyMode === "boolean" ? loaded.acronymOnlyMode : defaults.acronymOnlyMode,
		allowLowercaseAbbreviations:
			typeof loaded?.allowLowercaseAbbreviations === "boolean"
				? loaded.allowLowercaseAbbreviations
				: defaults.allowLowercaseAbbreviations,
		acceptCapitalizationDifferences:
			typeof loaded?.acceptCapitalizationDifferences === "boolean"
				? loaded.acceptCapitalizationDifferences
				: defaults.acceptCapitalizationDifferences,
		showSuccessfulAddNotices:
			typeof loaded?.showSuccessfulAddNotices === "boolean"
				? loaded.showSuccessfulAddNotices
				: defaults.showSuccessfulAddNotices,
		showFailedAddNotices:
			typeof loaded?.showFailedAddNotices === "boolean"
				? loaded.showFailedAddNotices
				: defaults.showFailedAddNotices,
		debugLogging: typeof loaded?.debugLogging === "boolean" ? loaded.debugLogging : defaults.debugLogging,
		providerName: typeof loaded?.providerName === "string" ? loaded.providerName : defaults.providerName,
		customSystemPrompt:
			typeof loaded?.customSystemPrompt === "string" ? loaded.customSystemPrompt : defaults.customSystemPrompt,
		auditLog,
		maxAuditEntries: coerceNumber(loaded?.maxAuditEntries, defaults.maxAuditEntries, (value) => value > 0),
	};
}

class ConfirmAddModal extends Modal {
	private accepted = false;

	constructor(
		app: App,
		private readonly candidate: EnrichedCandidateContext,
		private readonly confidence: number,
		private readonly reason: string,
		private readonly onDecision: (accepted: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass("better-correct-confirm-modal");
		this.titleEl.setText("");
		this.setTitle("");
		contentEl.empty();

		const container = contentEl.createDiv({ cls: "better-correct-confirm" });
		const header = container.createDiv({ cls: "better-correct-confirm-header" });
		header.createEl("h2", {
			text: `Add "${this.candidate.normalizedWord}" to dictionary?`,
		});
		header.createSpan({
			cls: "better-correct-confirm-confidence",
			text: `${Math.round(this.confidence * 100)}% confidence`,
		});

		container.createEl("p", {
			cls: "better-correct-confirm-reason",
			text: this.reason,
		});

		container.createEl("p", {
			cls: "better-correct-confirm-example",
			text: this.candidate.sentence || `${this.candidate.contextBefore} ${this.candidate.word} ${this.candidate.contextAfter}`.trim(),
		});

		const actions = container.createDiv({ cls: "better-correct-confirm-actions" });
		actions.createEl("button", { text: "Add" }, (button) => {
			button.addClass("mod-cta");
			button.addEventListener("click", () => {
				this.accepted = true;
				this.close();
			});
		});
		actions.createEl("button", { text: "Skip" }, (button) => {
			button.addEventListener("click", () => this.close());
		});
	}

	onClose(): void {
		this.modalEl.removeClass("better-correct-confirm-modal");
		this.onDecision(this.accepted);
	}
}

export default class BetterCorrectPlugin extends Plugin {
	settings: BetterCorrectSettings = cloneDefaultSettings();
	auditStore = new AuditStore(this);

	private readonly dictionary = new DictionaryManager();
	private readonly spellService = new SpellService();
	private readonly classifier = new AIClassifier({
		log: (message, details) => this.debug(message, details),
	});
	private settingsTab: BetterCorrectSettingTab | null = null;
	private readonly decisionCache = new Map<string, WordDecision>();
	private readonly ignoredCandidateKeys = new Set<string>();
	private readonly knownMisspellings = new Set<string>();
	private documentScanTimer: number | null = null;
	private activeScanController: AbortController | null = null;
	private dirtyScanRange: { fromLine: number; toLine: number } | null = null;

	async onload(): Promise<void> {
		this.debug("onload:start", {
			id: this.manifest.id,
			version: this.manifest.version,
		});
		try {
			await this.loadSettings();
			await this.spellService.initialize();
			this.hydrateSpellService();
			this.auditStore = new AuditStore(this);
			this.settingsTab = new BetterCorrectSettingTab(this.app, this);
			this.addSettingTab(this.settingsTab);
			this.registerView(REVIEW_VIEW_TYPE, (leaf) => new BetterCorrectReviewView(leaf, this));
			this.addRibbonIcon("history", "Open Better Correct history", () => {
				void this.openReviewView();
			});
			this.registerCommands();
			this.registerEditorObservers();
			this.registerInterval(window.setInterval(() => this.pruneDecisionCache(), 60_000));

			this.debug("ai:init:start");
			await initAI(this.app, this, async () => {
				this.debug("ai:init:ready");
				this.settingsTab?.display();
			});
			this.scheduleDocumentScan("onload");
			this.debug("onload:complete");
		} catch (error) {
			console.error("[Better Correct] onload:failed", error);
			throw error;
		}
	}

	async onunload(): Promise<void> {
		this.cancelScheduledDocumentScan("plugin unload");
		await this.detachReviewLeaves();
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<BetterCorrectSettings> | null;
		this.settings = sanitizeSettings(loaded);
		this.debug("Settings loaded", {
			debugLogging: this.settings.debugLogging,
			providerName: this.settings.providerName,
			autoAdd: this.settings.autoAdd,
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		await this.refreshReviewView();
	}

	getAvailableProviders(): AIProviderConfig[] {
		const appWithProviders = this.app as App & { aiProviders?: { providers?: AIProviderConfig[] } };
		return appWithProviders.aiProviders?.providers ?? [];
	}

	getKnownMisspellings(): string[] {
		return [...this.knownMisspellings].sort((left, right) => left.localeCompare(right));
	}

	async addKnownMisspelling(word: string): Promise<boolean> {
		const normalized = this.normalizeKnownMisspelling(word);
		if (!normalized || this.knownMisspellings.has(normalized)) {
			return false;
		}

		this.knownMisspellings.add(normalized);
		await this.refreshReviewView();
		return true;
	}

	async removeKnownMisspelling(word: string): Promise<boolean> {
		const normalized = this.normalizeKnownMisspelling(word);
		if (!normalized || !this.knownMisspellings.delete(normalized)) {
			return false;
		}

		this.invalidateDecisionCacheForWord(normalized);
		await this.refreshReviewView();
		return true;
	}

	async clearKnownMisspellings(): Promise<number> {
		const words = this.getKnownMisspellings();
		if (!words.length) {
			return 0;
		}

		this.knownMisspellings.clear();
		for (const word of words) {
			this.invalidateDecisionCacheForWord(word);
		}
		await this.refreshReviewView();
		return words.length;
	}

	async openReviewView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			return;
		}

		await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	async undoEntry(entryId: string): Promise<{ removed: boolean; dictionaryRemoved: boolean; message?: string }> {
		const entry = this.settings.auditLog.find((candidate) => candidate.id === entryId);
		if (!entry) {
			return {
				removed: false,
				dictionaryRemoved: false,
				message: "Entry was not found in Better Correct history.",
			};
		}

		const wordsToRemove = entry.dictionaryWords.length ? entry.dictionaryWords : [entry.word];
		const normalizedMisspelling = this.normalizeKnownMisspelling(entry.word);
		if (entry.addedVia === "fallback" || entry.addedVia === "existing") {
			if (entry.dictionaryWords.length) {
				this.spellService.removeWords(entry.dictionaryWords);
			}
			await this.auditStore.removeById(entry.id);
			this.knownMisspellings.add(normalizedMisspelling);
			await this.refreshReviewView();
			return {
				removed: true,
				dictionaryRemoved: false,
				message: entry.addedVia === "existing"
					? "Removed from Better Correct history. The native dictionary entry was already present, so nothing was removed from Obsidian's dictionary."
					: "Removed from Better Correct history. No native dictionary entry was recorded for this fallback approval.",
			};
		}

		const result = await this.dictionary.removeWord(entry.word, wordsToRemove);
		this.debug("Dictionary remove end", {
			word: entry.word,
			dictionaryWords: result.dictionaryWords,
			ok: result.ok,
			method: result.method,
			message: result.message,
		});

		this.spellService.removeWords(wordsToRemove);
		await this.auditStore.removeById(entry.id);
		this.knownMisspellings.add(normalizedMisspelling);
		await this.refreshReviewView();
		if (!result.ok || result.dictionaryWords.length !== wordsToRemove.length) {
			return {
				removed: true,
				dictionaryRemoved: false,
				message: result.message ?? "Better Correct removed the history entry, but native dictionary removal did not fully succeed.",
			};
		}

		return {
			removed: true,
			dictionaryRemoved: true,
		};
	}

	private hydrateSpellService(): void {
		const approvedWords = this.settings.auditLog.flatMap((entry) => entry.dictionaryWords);
		this.spellService.addWords(approvedWords);
	}

	private normalizeKnownMisspelling(word: string): string {
		return word.trim().toLowerCase();
	}

	private invalidateDecisionCacheForWord(word: string): void {
		const normalized = this.normalizeKnownMisspelling(word);
		const prefix = `${normalized}::`;
		for (const key of this.decisionCache.keys()) {
			if (key.startsWith(prefix)) {
				this.decisionCache.delete(key);
			}
		}
	}

	private registerCommands(): void {
		this.addCommand({
			id: "check-current-word-with-ai",
			name: "Check current word with AI",
			callback: () => {
				void this.runManualCheck();
			},
		});

		this.addCommand({
			id: "undo-last-auto-added-word",
			name: "Undo last auto-added word",
			callback: () => {
				void this.undoLastAddedWord();
			},
		});

		this.addCommand({
			id: "open-audit-log",
			name: "Open Better Correct audit log",
			callback: () => {
				void this.openReviewView();
			},
		});

		this.addCommand({
			id: "ignore-current-word-for-session",
			name: "Ignore current word for this session",
			callback: () => {
				void this.ignoreCurrentWord();
			},
		});
	}

	private registerEditorObservers(): void {
		this.registerEvent(
			this.app.workspace.on("editor-change", (_editor, view) => {
				if (!(view instanceof MarkdownView)) {
					return;
				}

				const cursorLine = view.editor?.getCursor().line ?? 0;
				this.scheduleDocumentScan("editor-change", view, {
					fromLine: Math.max(0, cursorLine - 2),
					toLine: cursorLine + 2,
				});
			}),
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.scheduleDocumentScan("leaf-change");
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				this.scheduleDocumentScan("file-open");
			}),
		);
	}

	private async runManualCheck(): Promise<void> {
		const view = this.getActiveMarkdownView();
		if (!view) {
			this.showFailureNotice("No active Markdown editor.");
			return;
		}

		const candidate = detectCandidateAtCursor(view, this.settings, { manual: true });
		if (!candidate) {
			this.showFailureNotice("No eligible word under the cursor.");
			return;
		}

		await this.classifyAndMaybeAdd(view, candidate, true);
	}

	private async undoLastAddedWord(): Promise<void> {
		const latest = this.auditStore.getEntries().find((entry) => entry.addedVia === "auto") ?? null;
		if (!latest) {
			this.showFailureNotice("No automatic Better Correct dictionary additions to undo.");
			return;
		}

		const result = await this.undoEntry(latest.id);
		if (!result.removed) {
			this.showFailureNotice(`Could not remove "${latest.word}" from Better Correct.`);
			return;
		}

		new Notice(`Removed "${latest.word}" from Better Correct history.`);
		if (result.message) {
			this.showFailureNotice(result.message);
		}
	}

	private async ignoreCurrentWord(): Promise<void> {
		const view = this.getActiveMarkdownView();
		if (!view) {
			this.showFailureNotice("No active Markdown editor.");
			return;
		}

		const candidate = detectCandidateAtCursor(view, this.settings, { manual: true });
		if (!candidate) {
			this.showFailureNotice("No eligible word under the cursor.");
			return;
		}

		const key = candidateKey(candidate);
		this.ignoredCandidateKeys.add(key);
		new Notice(`Ignoring "${candidate.normalizedWord}" for this session.`);
	}

	private getActiveMarkdownView(): MarkdownView | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view ?? null;
	}

	private markDocumentScanRange(view: MarkdownView, range?: { fromLine: number; toLine: number }): void {
		const lineCount = view.editor?.lineCount() ?? 0;
		if (lineCount <= 0) {
			this.dirtyScanRange = null;
			return;
		}

		const nextRange = range
			? {
				fromLine: Math.max(0, Math.min(range.fromLine, lineCount - 1)),
				toLine: Math.max(0, Math.min(range.toLine, lineCount - 1)),
			}
			: {
				fromLine: 0,
				toLine: lineCount - 1,
			};

		if (!this.dirtyScanRange) {
			this.dirtyScanRange = nextRange;
			return;
		}

		this.dirtyScanRange = {
			fromLine: Math.min(this.dirtyScanRange.fromLine, nextRange.fromLine),
			toLine: Math.max(this.dirtyScanRange.toLine, nextRange.toLine),
		};
	}

	private scheduleDocumentScan(reason: string, explicitView?: MarkdownView, range?: { fromLine: number; toLine: number }): void {
		const view = explicitView ?? this.getActiveMarkdownView();
		if (!view) {
			this.cancelScheduledDocumentScan(`no active view (${reason})`);
			return;
		}

		this.markDocumentScanRange(view, range);

		if (this.documentScanTimer !== null) {
			window.clearTimeout(this.documentScanTimer);
		}
		this.activeScanController?.abort();
		this.documentScanTimer = window.setTimeout(() => {
			this.documentScanTimer = null;
			void this.processDocumentCandidates(view, reason);
		}, this.settings.delayMs);
		this.debug("Document scan scheduled", {
			reason,
			delayMs: this.settings.delayMs,
			file: view.file?.path,
		});
	}

	private async processDocumentCandidates(view: MarkdownView, reason: string): Promise<void> {
		const currentView = this.getActiveMarkdownView();
		if (!currentView || currentView.file?.path !== view.file?.path) {
			return;
		}

		const scanRange = this.dirtyScanRange;
		this.dirtyScanRange = null;
		const candidates = scanRange
			? scanDocumentCandidatesInRange(view, this.settings, scanRange.fromLine, scanRange.toLine)
			: scanDocumentCandidates(view, this.settings);
		this.debug("Document scan complete", {
			reason,
			range: scanRange,
			count: candidates.length,
			candidates: candidates.map((candidate) => ({
				word: candidate.normalizedWord,
				line: candidate.line,
				from: candidate.range.from,
				to: candidate.range.to,
			})),
		});

		const controller = new AbortController();
		this.activeScanController = controller;
		for (const candidate of candidates) {
			const key = candidateKey(candidate);
			const normalizedKey = candidate.normalizedWord.toLowerCase();
			if (
				this.ignoredCandidateKeys.has(key) ||
				this.auditStore.hasWord(candidate.normalizedWord) ||
				this.knownMisspellings.has(normalizedKey)
			) {
				continue;
			}

			const localSpellcheck = this.spellService.checkWord(candidate.normalizedWord, this.settings);
			if (localSpellcheck.isCorrect) {
				continue;
			}

			if (localSpellcheck.isCapitalizationOnly) {
				const enrichedCandidate = enrichCandidateContext(view, candidate);
				await this.addCapitalizationOnlyWord(enrichedCandidate, false);
				continue;
			}

			const enrichedCandidate = enrichCandidateContext(view, candidate);
			if (this.decisionCache.has(cacheKey(enrichedCandidate))) {
				continue;
			}

			if (controller.signal.aborted) {
				return;
			}

			await this.classifyAndMaybeAdd(view, candidate, false, controller, localSpellcheck, enrichedCandidate);
		}

		if (this.activeScanController === controller) {
			this.activeScanController = null;
		}
	}

	private cancelScheduledDocumentScan(reason: string): void {
		if (this.documentScanTimer !== null) {
			window.clearTimeout(this.documentScanTimer);
			this.documentScanTimer = null;
		}
		this.activeScanController?.abort();
		this.activeScanController = null;
		this.dirtyScanRange = null;
		this.debug("Cancelled document scan", { reason });
	}

	private canAutoAdd(candidate: CandidateContext, confidence: number): boolean {
		if (!this.settings.autoAdd) {
			return false;
		}

		if (this.settings.askBeforeAdding) {
			return false;
		}

		if (confidence < this.settings.confirmationConfidence) {
			return false;
		}

		if (/[^A-Za-z0-9._'-]/.test(candidate.normalizedWord)) {
			return false;
		}

		return true;
	}

	private showSuccessfulAddNotice(message: string): void {
		if (!this.settings.showSuccessfulAddNotices) {
			return;
		}

		new Notice(message);
	}

	private showFailedAddNotice(message: string): void {
		if (!this.settings.showFailedAddNotices) {
			return;
		}

		new Notice(message);
	}

	private showFailureNotice(message: string): void {
		this.showFailedAddNotice(message);
	}

	private buildSegmentCandidate(candidate: EnrichedCandidateContext, segment: string): EnrichedCandidateContext {
		return {
			...candidate,
			word: segment,
			normalizedWord: segment,
		};
	}

	private async classifyUnknownSegments(
		candidate: EnrichedCandidateContext,
		segments: string[],
		abortController: AbortController,
	): Promise<WordDecision["result"] | null> {
		const uniqueSegments = [...new Set(segments)];
		const approvals: WordDecision["result"][] = [];

		for (const originalSegment of uniqueSegments) {
			const normalizedSegment = originalSegment.toLowerCase();
			if (this.knownMisspellings.has(normalizedSegment)) {
				return null;
			}

			const segmentCandidate = this.buildSegmentCandidate(candidate, originalSegment);
			const segmentCacheToken = cacheKey(segmentCandidate);
			const cached = this.decisionCache.get(segmentCacheToken);
			let result = cached?.result;

			if (!result) {
				this.debug("AI request start", {
					word: segmentCandidate.normalizedWord,
					manual: false,
					contextBefore: segmentCandidate.contextBefore,
					contextAfter: segmentCandidate.contextAfter,
					sentence: segmentCandidate.sentence,
				});
				result = await this.classifier.classify(this.settings, segmentCandidate, abortController);
				if (abortController.signal.aborted) {
					return null;
				}
				this.decisionCache.set(segmentCacheToken, {
					key: segmentCacheToken,
					result,
					timestamp: Date.now(),
				});
				this.debug("AI request end", {
					word: segmentCandidate.normalizedWord,
					misspelled: result.misspelled,
					confidence: result.confidence,
					reason: result.reason,
					providerName: result.providerName,
				});
			}

			if (result.misspelled) {
				const wasAdded = !this.knownMisspellings.has(normalizedSegment);
				this.knownMisspellings.add(normalizedSegment);
				if (wasAdded) {
					await this.refreshReviewView();
				}
				return null;
			}

			approvals.push(result);
		}

		if (!approvals.length) {
			return null;
		}

		const providerNames = [...new Set(approvals.map((result) => result.providerName))];
		const segmentReason = approvals.length === 1
			? approvals[0].reason
			: `Accepted because the unresolved hyphenated segments were valid in context: ${approvals.map((result) => result.reason).join(" ")}`;

		return {
			misspelled: false,
			confidence: Math.min(...approvals.map((result) => result.confidence)),
			reason: segmentReason,
			raw: approvals.map((result) => result.raw).join("\n"),
			providerName: providerNames.join(", "),
		};
	}

	private async classifyAndMaybeAdd(
		view: MarkdownView,
		candidate: CandidateContext,
		manual: boolean,
		abortController = new AbortController(),
		localSpellcheck = this.spellService.checkWord(candidate.normalizedWord, this.settings),
		enrichedCandidate?: EnrichedCandidateContext,
	): Promise<void> {
		if (this.auditStore.hasWord(candidate.normalizedWord)) {
			return;
		}

		if (!manual && this.knownMisspellings.has(candidate.normalizedWord.toLowerCase())) {
			return;
		}

		const resolvedCandidate = enrichedCandidate ?? enrichCandidateContext(view, candidate);
		const cacheToken = cacheKey(resolvedCandidate);
		const cached = this.decisionCache.get(cacheToken);
		if (cached) {
			this.debug("Using cached decision", cached);
			await this.handleDecision(resolvedCandidate, cached.result, manual);
			return;
		}

		if (localSpellcheck.isCorrect) {
			if (manual) {
				this.showFailureNotice(`Better Correct left "${candidate.normalizedWord}" unchanged.`);
			}
			return;
		}

		if (localSpellcheck.isCapitalizationOnly) {
			await this.addCapitalizationOnlyWord(resolvedCandidate, manual);
			return;
		}

		if (candidate.normalizedWord.includes("-") && localSpellcheck.unknownSegments.length > 0) {
			this.debug("Hyphenated candidate spellcheck", {
				word: candidate.normalizedWord,
				unknownSegments: localSpellcheck.unknownSegments,
				misspelledSegments: localSpellcheck.misspelledSegments,
			});
			if (localSpellcheck.misspelledSegments.length === 0) {
				if (manual) {
					this.showFailureNotice(`Better Correct left "${candidate.normalizedWord}" unchanged.`);
				}
				return;
			}
			try {
				const segmentClassification = await this.classifyUnknownSegments(
					resolvedCandidate,
					localSpellcheck.unknownSegments,
					abortController,
				);
				if (abortController.signal.aborted) {
					return;
				}
				if (!segmentClassification) {
					if (manual) {
						this.showFailureNotice(`Better Correct left "${candidate.normalizedWord}" unchanged.`);
					}
					return;
				}
				await this.handleDecision(
					resolvedCandidate,
					segmentClassification,
					manual,
					[...new Set(localSpellcheck.misspelledSegments)],
				);
			} catch (error) {
				if (abortController.signal.aborted) {
					return;
				}

				this.debug("Classification failed", error);
				this.showFailureNotice(`Better Correct could not classify "${candidate.normalizedWord}".`);
			}
			return;
		}

		try {
			this.debug("AI request start", {
				word: candidate.normalizedWord,
				manual,
				contextBefore: resolvedCandidate.contextBefore,
				contextAfter: resolvedCandidate.contextAfter,
				sentence: resolvedCandidate.sentence,
			});
			const result = await this.classifier.classify(this.settings, resolvedCandidate, abortController);
			if (abortController.signal.aborted) {
				return;
			}

			this.decisionCache.set(cacheToken, {
				key: cacheToken,
				result,
				timestamp: Date.now(),
			});
			this.debug("AI request end", {
				word: candidate.normalizedWord,
				misspelled: result.misspelled,
				confidence: result.confidence,
				reason: result.reason,
				providerName: result.providerName,
			});
			if (result.misspelled) {
				const normalizedWord = candidate.normalizedWord.toLowerCase();
				const wasAdded = !this.knownMisspellings.has(normalizedWord);
				this.knownMisspellings.add(normalizedWord);
				if (wasAdded) {
					await this.refreshReviewView();
				}
			}
			await this.handleDecision(resolvedCandidate, result, manual);
		} catch (error) {
			if (abortController.signal.aborted) {
				return;
			}

			this.debug("Classification failed", error);
			this.showFailureNotice(`Better Correct could not classify "${candidate.normalizedWord}".`);
		}
	}

	private async handleDecision(
		candidate: EnrichedCandidateContext,
		result: WordDecision["result"],
		manual: boolean,
		dictionaryWordsToAdd?: string[],
	): Promise<void> {
		if (result.misspelled || result.confidence < this.settings.minConfidence) {
			if (manual) {
				this.showFailureNotice(`Better Correct left "${candidate.normalizedWord}" unchanged.`);
			}
			return;
		}

		if (this.auditStore.hasWord(candidate.normalizedWord)) {
			this.debug("Word already recorded in audit log", candidate.normalizedWord);
			return;
		}

		if (!manual && !this.settings.autoAdd && !this.settings.askBeforeAdding) {
			return;
		}

		const shouldAsk = manual || this.settings.askBeforeAdding || !this.canAutoAdd(candidate, result.confidence);
		const confirmed = shouldAsk
			? await this.askToAdd(candidate, result.confidence, result.reason)
			: true;
		if (!confirmed) {
			if (manual) {
				this.showFailureNotice(`Better Correct left "${candidate.normalizedWord}" unchanged.`);
			}
			return;
		}

		this.debug("Dictionary add start", {
			word: candidate.normalizedWord,
			dictionaryWordsToAdd,
		});
		const addResult = await this.dictionary.addWord(candidate.normalizedWord, dictionaryWordsToAdd);
		this.debug("Dictionary add end", {
			word: candidate.normalizedWord,
			dictionaryWords: addResult.dictionaryWords,
			alreadyPresentWords: addResult.alreadyPresentWords,
			ok: addResult.ok,
			method: addResult.method,
			message: addResult.message,
		});

		const addedVia: AuditEntry["addedVia"] = addResult.ok
			? (addResult.dictionaryWords.length > 0 ? (manual ? "manual" : "auto") : "existing")
			: "fallback";
		const dictionaryWords = addResult.dictionaryWords.length
			? addResult.dictionaryWords
			: (dictionaryWordsToAdd && dictionaryWordsToAdd.length ? dictionaryWordsToAdd : [candidate.normalizedWord]);
		const entry: AuditEntry = {
			id: `${Date.now()}-${candidate.filePath}-${candidate.line}-${candidate.normalizedWord}`,
			word: candidate.normalizedWord,
			dictionaryWords: addedVia === "existing" ? [] : dictionaryWords,
			filePath: candidate.filePath,
			fileTitle: candidate.fileTitle,
			contextBefore: candidate.contextBefore,
			contextAfter: candidate.contextAfter,
			reason: result.reason,
			confidence: result.confidence,
			timestamp: Date.now(),
			providerName: result.providerName,
			addedVia,
		};
		await this.auditStore.add(entry);
		if (addedVia !== "existing") {
			this.spellService.addWords(dictionaryWords);
		}

		const recentCount = this.auditStore.getEntries().length;
		if (addResult.ok && addedVia !== "existing") {
			const addedWordsText =
				dictionaryWords.length === 1
					? `"${dictionaryWords[0]}"`
					: dictionaryWords.map((word) => `"${word}"`).join(", ");
			const matchesCandidateWord =
				dictionaryWords.length === 1 && dictionaryWords[0].toLowerCase() === candidate.normalizedWord.toLowerCase();
			this.showSuccessfulAddNotice(
				matchesCandidateWord
					? `${addedWordsText} added to dictionary.`
					: `Added ${addedWordsText} to dictionary for "${candidate.normalizedWord}".`,
			);
			return;
		}

		if (addedVia === "existing") {
			this.showSuccessfulAddNotice(`"${candidate.normalizedWord}" is already in the dictionary.`);
			return;
		}

		this.showFailedAddNotice(`Saved "${candidate.normalizedWord}" to Better Correct history.`);
		this.showFailedAddNotice(`Native dictionary update failed: ${addResult.message ?? "Obsidian did not expose a writable dictionary API in this runtime."}`);
	}

	private async addCapitalizationOnlyWord(candidate: EnrichedCandidateContext, manual: boolean): Promise<void> {
		if (this.auditStore.hasWord(candidate.normalizedWord)) {
			return;
		}

		const normalizedWord = candidate.normalizedWord.toLowerCase();
		this.knownMisspellings.delete(normalizedWord);
		this.invalidateDecisionCacheForWord(normalizedWord);

		this.debug("Capitalization-only add start", {
			word: candidate.normalizedWord,
			manual,
		});
		const addResult = await this.dictionary.addWord(candidate.normalizedWord);
		this.debug("Capitalization-only add end", {
			word: candidate.normalizedWord,
			dictionaryWords: addResult.dictionaryWords,
			alreadyPresentWords: addResult.alreadyPresentWords,
			ok: addResult.ok,
			method: addResult.method,
			message: addResult.message,
		});

		const addedVia: AuditEntry["addedVia"] = addResult.ok
			? (addResult.dictionaryWords.length > 0 ? (manual ? "manual" : "auto") : "existing")
			: "fallback";
		const dictionaryWords = addResult.dictionaryWords.length ? addResult.dictionaryWords : [candidate.normalizedWord];
		const entry: AuditEntry = {
			id: `${Date.now()}-${candidate.filePath}-${candidate.line}-${candidate.normalizedWord}`,
			word: candidate.normalizedWord,
			dictionaryWords: addedVia === "existing" ? [] : dictionaryWords,
			filePath: candidate.filePath,
			fileTitle: candidate.fileTitle,
			contextBefore: candidate.contextBefore,
			contextAfter: candidate.contextAfter,
			reason: "Accepted because the only difference from the local dictionary was capitalization.",
			confidence: 1,
			timestamp: Date.now(),
			providerName: "Local spellcheck",
			addedVia,
		};
		await this.auditStore.add(entry);
		if (addedVia !== "existing") {
			this.spellService.addWords(dictionaryWords);
		}

		if (addResult.ok && addedVia !== "existing") {
			const addedWordsText =
				dictionaryWords.length === 1
					? `"${dictionaryWords[0]}"`
					: dictionaryWords.map((word) => `"${word}"`).join(", ");
			const matchesCandidateWord =
				dictionaryWords.length === 1 && dictionaryWords[0].toLowerCase() === candidate.normalizedWord.toLowerCase();
			this.showSuccessfulAddNotice(
				matchesCandidateWord
					? `${addedWordsText} added to dictionary.`
					: `Added ${addedWordsText} to dictionary for "${candidate.normalizedWord}".`,
			);
			return;
		}

		if (addedVia === "existing") {
			this.showSuccessfulAddNotice(`"${candidate.normalizedWord}" is already in the dictionary.`);
			return;
		}

		this.showFailedAddNotice(`Saved "${candidate.normalizedWord}" to Better Correct history.`);
		this.showFailedAddNotice(`Native dictionary update failed: ${addResult.message ?? "Obsidian did not expose a writable dictionary API in this runtime."}`);
	}

	private askToAdd(candidate: EnrichedCandidateContext, confidence: number, reason: string): Promise<boolean> {
		return new Promise((resolve) => {
			new ConfirmAddModal(this.app, candidate, confidence, reason, resolve).open();
		});
	}

	private pruneDecisionCache(): void {
		const now = Date.now();
		for (const [key, value] of this.decisionCache.entries()) {
			if (now - value.timestamp > 30 * 60_000) {
				this.decisionCache.delete(key);
			}
		}
	}

	private async refreshReviewView(): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof BetterCorrectReviewView) {
				await view.refresh();
			}
		}
	}

	private async detachReviewLeaves(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE);
		await Promise.all(leaves.map((leaf: WorkspaceLeaf) => leaf.detach()));
	}

	private debug(message: string, details?: unknown): void {
		if (!this.settings.debugLogging) {
			return;
		}

		console.debug("[Better Correct]", message, details);
	}
}
