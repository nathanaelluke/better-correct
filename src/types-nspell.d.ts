declare module "dictionary-en" {
	export interface DictionaryData {
		aff: Uint8Array | string;
		dic: Uint8Array | string;
	}

	export default function loadDictionary(
		callback: (error: Error | null | undefined, dictionary?: DictionaryData) => void,
	): void;
}

declare module "*.aff" {
	const contents: string;
	export default contents;
}

declare module "*.dic" {
	const contents: string;
	export default contents;
}

declare module "nspell" {
	export interface NSpellInstance {
		add(word: string, model?: string): NSpellInstance;
		correct(word: string): boolean;
		remove(word: string): NSpellInstance;
		suggest(word: string): string[];
	}

	export default function nspell(dictionary: {
		aff: Uint8Array | string;
		dic?: Uint8Array | string;
	}): NSpellInstance;
}
