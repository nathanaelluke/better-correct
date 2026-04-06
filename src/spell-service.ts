import aff from "dictionary-en/index.aff";
import dic from "dictionary-en/index.dic";
import nspell, { type NSpellInstance } from "nspell";
import type { BetterCorrectSettings } from "./types";

export interface LocalSpellcheckResult {
	isCorrect: boolean;
	isCapitalizationOnly: boolean;
	suggestions: string[];
	unknownSegments: string[];
	misspelledSegments: string[];
}

export class SpellService {
	private spell: NSpellInstance | null = null;

	private isEligibleDictionarySegment(segment: string): boolean {
		return /[A-Za-z]/.test(segment) && !/^\d[\d._-]*$/.test(segment);
	}

	private checkSingleWord(word: string, settings: BetterCorrectSettings): LocalSpellcheckResult {
		if (!this.spell) {
			return {
				isCorrect: false,
				isCapitalizationOnly: false,
				suggestions: [],
				unknownSegments: [word],
				misspelledSegments: this.isEligibleDictionarySegment(word) ? [word] : [],
			};
		}

		if (this.spell.correct(word)) {
			return {
				isCorrect: true,
				isCapitalizationOnly: false,
				suggestions: [],
				unknownSegments: [],
				misspelledSegments: [],
			};
		}

		const suggestions = this.spell.suggest(word).slice(0, 5);
		const isCapitalizationOnly =
			settings.acceptCapitalizationDifferences &&
			suggestions.some((candidate) => candidate.toLowerCase() === word.toLowerCase());

		return {
			isCorrect: false,
			isCapitalizationOnly,
			suggestions,
			unknownSegments: isCapitalizationOnly ? [] : [word],
			misspelledSegments: isCapitalizationOnly
				? []
				: (this.isEligibleDictionarySegment(word) ? [word] : []),
		};
	}

	async initialize(): Promise<void> {
		this.spell = nspell({
			aff,
			dic,
		});
	}

	checkWord(word: string, settings: BetterCorrectSettings): LocalSpellcheckResult {
		const hyphenSegments = word
			.split("-")
			.map((segment) => segment.trim())
			.filter(Boolean);
		if (hyphenSegments.length <= 1) {
			return this.checkSingleWord(word, settings);
		}

		const segmentResults = hyphenSegments.map((segment) => this.checkSingleWord(segment, settings));
		const unknownSegments = segmentResults.flatMap((result) => result.unknownSegments);
		const misspelledSegments = segmentResults.flatMap((result) => result.misspelledSegments);
		const hasCapitalizationOnlySegment = segmentResults.some((result) => result.isCapitalizationOnly);
		const isCorrect = unknownSegments.length === 0 && !hasCapitalizationOnlySegment;
		const isCapitalizationOnly = unknownSegments.length === 0 && hasCapitalizationOnlySegment;
		const suggestions = segmentResults.flatMap((result) => result.suggestions).slice(0, 5);

		return {
			isCorrect,
			isCapitalizationOnly,
			suggestions,
			unknownSegments,
			misspelledSegments,
		};
	}

	addWords(words: string[]): void {
		if (!this.spell) {
			return;
		}

		for (const word of words) {
			this.spell.add(word);
		}
	}

	removeWords(words: string[]): void {
		if (!this.spell) {
			return;
		}

		for (const word of words) {
			this.spell.remove(word);
		}
	}
}
