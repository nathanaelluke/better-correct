import { ButtonComponent, ItemView, Notice, WorkspaceLeaf } from "obsidian";
import type BetterCorrectPlugin from "./main";

export const REVIEW_VIEW_TYPE = "better-correct-review";

export class BetterCorrectReviewView extends ItemView {
	private addedWordsSearch = "";
	private historyCountEl: HTMLSpanElement | null = null;
	private historyListContainerEl: HTMLDivElement | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: BetterCorrectPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return REVIEW_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Better Correct Review";
	}

	getIcon(): string {
		return "history";
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async refresh(): Promise<void> {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("better-correct-review");

		const historySection = contentEl.createDiv({ cls: "better-correct-section" });
		const historyHeader = historySection.createDiv({ cls: "better-correct-history-header" });
		const historyHeaderTop = historyHeader.createDiv({ cls: "better-correct-history-header-top" });
		historyHeaderTop.createEl("h3", { text: "Added Words" });
		this.historyCountEl = historyHeaderTop.createEl("span", {
			cls: "better-correct-history-count",
			text: "0 words",
		});
		const searchInput = historySection.createEl("input", {
			type: "search",
			placeholder: "Search added words",
		});
		searchInput.addClass("better-correct-history-search");
		searchInput.value = this.addedWordsSearch;
		searchInput.setAttribute("aria-label", "Search added words");
		searchInput.addEventListener("input", () => {
			this.addedWordsSearch = searchInput.value;
			this.renderHistoryList();
		});
		this.historyListContainerEl = historySection.createDiv({ cls: "better-correct-history-list-container" });
		this.renderHistoryList();
	}

	private renderHistoryList(): void {
		if (!this.historyListContainerEl) {
			return;
		}

		const entries = this.plugin.auditStore.getEntries();
		const normalizedSearch = this.addedWordsSearch.trim().toLowerCase();
		const filteredEntries = normalizedSearch
			? entries.filter((entry) => {
				const context = `${entry.contextBefore} ${entry.word} ${entry.contextAfter}`.replace(/\s+/g, " ").trim();
				const haystack = [
					entry.word,
					entry.filePath,
					entry.fileTitle,
					entry.reason,
					entry.providerName,
					entry.addedVia,
					context,
					entry.dictionaryWords.join(" "),
				]
					.join(" ")
					.toLowerCase();
				return haystack.includes(normalizedSearch);
			})
			: entries;

		if (this.historyCountEl) {
			this.historyCountEl.setText(`${entries.length} ${entries.length === 1 ? "word" : "words"}`);
		}

		this.historyListContainerEl.empty();

		if (!entries.length) {
			const emptyState = this.historyListContainerEl.createDiv({ cls: "better-correct-history-empty" });
			emptyState.createEl("p", {
				cls: "better-correct-log-empty",
				text: "No Better Correct additions have been recorded yet.",
			});
			emptyState.createEl("p", {
				cls: "better-correct-setting-note",
				text: "Approved words will appear here after they are added.",
			});
		} else if (!filteredEntries.length) {
			const emptyState = this.historyListContainerEl.createDiv({ cls: "better-correct-history-empty" });
			emptyState.createEl("p", {
				cls: "better-correct-log-empty",
				text: "No added words match the current search.",
			});
		} else {
			const list = this.historyListContainerEl.createDiv({ cls: "better-correct-history-list" });

			for (const entry of filteredEntries) {
				const card = list.createDiv({ cls: "better-correct-history-card" });
				const topRow = card.createDiv({ cls: "better-correct-history-top-row" });
				topRow.createEl("strong", {
					cls: "better-correct-log-word",
					text: entry.word,
				});
				topRow.createSpan({
					cls: "better-correct-history-confidence",
					text: `Confidence ${entry.confidence.toFixed(2)}`,
				});

				const meta = card.createDiv({ cls: "better-correct-history-meta" });
				meta.createSpan({ text: new Date(entry.timestamp).toLocaleString() });
				meta.createSpan({ text: entry.filePath });
				meta.createSpan({ text: `${entry.providerName} via ${entry.addedVia}` });

				if (entry.reason) {
					card.createEl("p", {
						cls: "better-correct-history-reason",
						text: entry.reason,
					});
				}

				const context = `${entry.contextBefore} ${entry.word} ${entry.contextAfter}`.replace(/\s+/g, " ").trim();
				if (context) {
					card.createEl("p", {
						cls: "better-correct-history-context",
						text: context,
					});
				}

				const dictionaryWordsText =
					entry.dictionaryWords.length === 1 && entry.dictionaryWords[0] === entry.word
						? ""
						: `Dictionary entries: ${entry.dictionaryWords.join(", ")}`;
				if (dictionaryWordsText) {
					card.createEl("p", {
						cls: "better-correct-history-dictionary-words",
						text: dictionaryWordsText,
					});
				}

				const actions = card.createDiv({ cls: "better-correct-history-actions" });
				new ButtonComponent(actions)
					.setButtonText("Remove word")
					.setCta()
					.onClick(async () => {
						const result = await this.plugin.undoEntry(entry.id);
						if (!result.removed) {
							new Notice(`Could not remove "${entry.word}".`);
							this.render();
							return;
						}

						new Notice(`Removed "${entry.word}" from Better Correct history.`);
						if (result.message) {
							new Notice(result.message);
						}
						this.render();
					});
			}
		}
	}
}
