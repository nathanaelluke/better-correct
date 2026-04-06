export interface DictionaryOperationResult {
	ok: boolean;
	method: "native" | "fallback";
	dictionaryWords: string[];
	alreadyPresentWords?: string[];
	message?: string;
}

interface ElectronSessionLike {
	addWordToSpellCheckerDictionary?: (word: string) => boolean;
	removeWordFromSpellCheckerDictionary?: (word: string) => boolean;
}

interface WebContentsLike {
	session?: ElectronSessionLike | null;
}

interface ElectronModuleLike {
	remote?: {
		getCurrentWebContents?: () => WebContentsLike | null;
		webContents?: {
			getFocusedWebContents?: () => WebContentsLike | null;
		};
	};
	webContents?: {
		getFocusedWebContents?: () => WebContentsLike | null;
	};
}

type RequireLike = (id: string) => unknown;

export class DictionaryManager {
	private getDictionaryWords(word: string): string[] {
		const parts = word
			.split("-")
			.map((part) => part.trim())
			.filter(Boolean);
		const source = parts.length > 1 ? [word, ...parts] : [word];
		const seen = new Set<string>();
		const dictionaryWords: string[] = [];
		for (const candidate of source) {
			const key = candidate.toLowerCase();
			if (seen.has(key)) {
				continue;
			}

			seen.add(key);
			dictionaryWords.push(candidate);
		}

		return dictionaryWords;
	}

	private getRequire(): RequireLike | null {
		const maybeWindowRequire = (globalThis as { require?: RequireLike }).require;
		if (typeof maybeWindowRequire === "function") {
			return maybeWindowRequire;
		}

		if (typeof require === "function") {
			return require as RequireLike;
		}

		return null;
	}

	private getSessionFromWebContents(contents: WebContentsLike | null | undefined): ElectronSessionLike | null {
		return contents?.session ?? null;
	}

	private getSession(): ElectronSessionLike | null {
		try {
			const load = this.getRequire();
			if (!load) {
				return null;
			}

			const electron = load("electron") as ElectronModuleLike;
			const sessionCandidates: Array<ElectronSessionLike | null> = [
				this.getSessionFromWebContents(electron?.remote?.getCurrentWebContents?.()),
				this.getSessionFromWebContents(electron?.remote?.webContents?.getFocusedWebContents?.()),
				this.getSessionFromWebContents(electron?.webContents?.getFocusedWebContents?.()),
			];

			try {
				const electronRemote = load("@electron/remote") as {
					getCurrentWebContents?: () => WebContentsLike | null;
				};
				sessionCandidates.push(this.getSessionFromWebContents(electronRemote?.getCurrentWebContents?.()));
			} catch {
				// Some Obsidian runtimes do not expose @electron/remote.
			}

			for (const session of sessionCandidates) {
				if (session?.addWordToSpellCheckerDictionary || session?.removeWordFromSpellCheckerDictionary) {
					return session;
				}
			}

			return null;
		} catch {
			return null;
		}
	}

	canUseNativeDictionary(): boolean {
		const session = this.getSession();
		return Boolean(session?.addWordToSpellCheckerDictionary && session?.removeWordFromSpellCheckerDictionary);
	}

	async addWord(word: string, dictionaryWords = this.getDictionaryWords(word)): Promise<DictionaryOperationResult> {
		const session = this.getSession();
		if (!session?.addWordToSpellCheckerDictionary) {
			return {
				ok: false,
				method: "fallback",
				dictionaryWords,
				message: "Native dictionary API is unavailable in this Obsidian runtime. Better Correct could not resolve a writable spellchecker session.",
			};
		}

		try {
			const addedWords: string[] = [];
			const alreadyPresentWords: string[] = [];
			for (const dictionaryWord of dictionaryWords) {
				const ok = session.addWordToSpellCheckerDictionary(dictionaryWord);
				if (!ok) {
					alreadyPresentWords.push(dictionaryWord);
					continue;
				}

				addedWords.push(dictionaryWord);
			}

			return {
				ok: true,
				method: "native",
				dictionaryWords: addedWords,
				alreadyPresentWords,
				message: alreadyPresentWords.length
					? `Skipped ${alreadyPresentWords.map((word) => `"${word}"`).join(", ")} because ${alreadyPresentWords.length === 1 ? "it is" : "they are"} already present in the native dictionary.`
					: undefined,
			};
		} catch (error) {
			return {
				ok: false,
				method: "fallback",
				dictionaryWords,
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async removeWord(word: string, dictionaryWords = this.getDictionaryWords(word)): Promise<DictionaryOperationResult> {
		const session = this.getSession();
		if (!session?.removeWordFromSpellCheckerDictionary) {
			return {
				ok: false,
				method: "fallback",
				dictionaryWords,
				message: "Native dictionary removal API is unavailable in this Obsidian runtime. Better Correct could not resolve a writable spellchecker session.",
			};
		}

		try {
			const removedWords: string[] = [];
			for (const dictionaryWord of dictionaryWords) {
				const ok = session.removeWordFromSpellCheckerDictionary(dictionaryWord);
				if (!ok) {
					return {
						ok: false,
						method: "native",
						dictionaryWords: removedWords,
						message: `Obsidian rejected the dictionary remove request for "${dictionaryWord}".`,
					};
				}

				removedWords.push(dictionaryWord);
			}

			return {
				ok: true,
				method: "native",
				dictionaryWords: removedWords,
			};
		} catch (error) {
			return {
				ok: false,
				method: "fallback",
				dictionaryWords,
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}
}
