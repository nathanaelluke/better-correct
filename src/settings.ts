import { App, PluginSettingTab, Setting } from "obsidian";
import type BetterCorrectPlugin from "./main";

function patternListToText(patterns: string[]): string {
	return patterns.join("\n");
}

function textToPatternList(value: string): string[] {
	return value
		.split("\n")
		.map((pattern) => pattern.trim())
		.filter(Boolean);
}

export class BetterCorrectSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: BetterCorrectPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Auto-add after delay")
			.setDesc("Automatically add AI-approved words to Obsidian's native dictionary.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoAdd).onChange(async (value) => {
					this.plugin.settings.autoAdd = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Ask before adding")
			.setDesc("Require explicit confirmation before each dictionary add.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.askBeforeAdding).onChange(async (value) => {
					this.plugin.settings.askBeforeAdding = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Provider selection")
			.setDesc("Use a specific AI Providers profile or leave blank to use the first configured provider.")
			.addDropdown((dropdown) => {
				dropdown.addOption("", "First configured provider");
				for (const provider of this.plugin.getAvailableProviders()) {
					dropdown.addOption(provider.name, provider.name);
				}

				dropdown.setValue(this.plugin.settings.providerName).onChange(async (value) => {
					this.plugin.settings.providerName = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Delay before AI check")
			.setDesc("Milliseconds the word must remain stable before Better Correct queries the AI provider.")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.delayMs)).onChange(async (value) => {
					const parsed = Number(value);
					if (!Number.isNaN(parsed) && parsed >= 0) {
						this.plugin.settings.delayMs = parsed;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Maximum word length")
			.setDesc("Skip very long tokens during automatic review so code-like identifiers do not get auto-added.")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.maxWordLength)).onChange(async (value) => {
					const parsed = Number(value);
					if (!Number.isNaN(parsed) && parsed > 0) {
						this.plugin.settings.maxWordLength = parsed;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Minimum confidence threshold")
			.setDesc("Only add words when the AI returns misspelled=false above this threshold.")
			.addSlider((slider) =>
				slider
					.setLimits(0.5, 0.99, 0.01)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.minConfidence)
					.onChange(async (value) => {
						this.plugin.settings.minConfidence = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Confirmation notice threshold")
			.setDesc("Auto-add only above this higher threshold. Lower-confidence approvals require confirmation.")
			.addSlider((slider) =>
				slider
					.setLimits(0.6, 0.99, 0.01)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.confirmationConfidence)
					.onChange(async (value) => {
						this.plugin.settings.confirmationConfidence = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Acronym-only mode")
			.setDesc("Only consider all-caps acronyms and similar tokens for automatic checks.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.acronymOnlyMode).onChange(async (value) => {
					this.plugin.settings.acronymOnlyMode = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Allow lowercase abbreviations")
			.setDesc("Keep a curated set of lowercase technical abbreviations such as api, sdk, llm, cpu, gpu, json, or html eligible for automatic review.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.allowLowercaseAbbreviations).onChange(async (value) => {
					this.plugin.settings.allowLowercaseAbbreviations = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Accept capitalization-only differences")
			.setDesc("Treat words as valid when the only issue is capitalization, such as linux instead of Linux.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.acceptCapitalizationDifferences).onChange(async (value) => {
					this.plugin.settings.acceptCapitalizationDifferences = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Hide successful add notices")
			.setDesc("Turn this on to suppress notifications when Better Correct adds a word to Obsidian's dictionary.")
			.addToggle((toggle) =>
				toggle.setValue(!this.plugin.settings.showSuccessfulAddNotices).onChange(async (value) => {
					this.plugin.settings.showSuccessfulAddNotices = !value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Hide failure notices")
			.setDesc("Turn this on to suppress failure notices of any kind.")
			.addToggle((toggle) =>
				toggle.setValue(!this.plugin.settings.showFailedAddNotices).onChange(async (value) => {
					this.plugin.settings.showFailedAddNotices = !value;
					await this.plugin.saveSettings();
				}),
			);

		const advancedDetails = containerEl.createEl("details");
		advancedDetails.createEl("summary", { text: "Advanced Settings" });
		const advancedContainer = advancedDetails.createDiv();

		new Setting(advancedContainer)
			.setName("Debug logging")
			.setDesc("Write Better Correct internals to the developer console.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(advancedContainer)
			.setName("Additional AI instructions")
			.setDesc("Appended to the system prompt. Leave blank to use the built-in prompt only.")
			.addTextArea((text) =>
				text
					.setPlaceholder("Treat game titles, internal package names, and product SKUs as valid when context supports them.")
					.setValue(this.plugin.settings.customSystemPrompt)
					.onChange(async (value) => {
						this.plugin.settings.customSystemPrompt = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(advancedContainer)
			.setName("Allowlist patterns")
			.setDesc("One regular expression per line. Matching words stay eligible for automatic review even when other automatic filters would skip them.")
			.addTextArea((text) =>
				text
					.setPlaceholder("^[A-Z]{2,}$")
					.setValue(patternListToText(this.plugin.settings.allowlistPatterns))
					.onChange(async (value) => {
						this.plugin.settings.allowlistPatterns = textToPatternList(value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(advancedContainer)
			.setName("Blocklist patterns")
			.setDesc("One regular expression per line. Matching words are always skipped during automatic review, even if they also match the allowlist.")
			.addTextArea((text) =>
				text
					.setPlaceholder("^[a-z]{1,3}$")
					.setValue(patternListToText(this.plugin.settings.blocklistPatterns))
					.onChange(async (value) => {
						this.plugin.settings.blocklistPatterns = textToPatternList(value);
						await this.plugin.saveSettings();
					}),
				);

	}
}
