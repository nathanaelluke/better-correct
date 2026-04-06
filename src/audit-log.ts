import type { AuditEntry, BetterCorrectSettings } from "./types";

export interface AuditStoreHost {
	settings: BetterCorrectSettings;
	saveSettings(): Promise<void>;
}

export class AuditStore {
	constructor(private readonly host: AuditStoreHost) {}

	getEntries(): AuditEntry[] {
		return [...this.host.settings.auditLog].sort((left, right) => right.timestamp - left.timestamp);
	}

	getLastEntry(): AuditEntry | null {
		return this.getEntries()[0] ?? null;
	}

	hasWord(word: string): boolean {
		const normalized = word.toLowerCase();
		return this.host.settings.auditLog.some((entry) => entry.word.toLowerCase() === normalized);
	}

	async add(entry: AuditEntry): Promise<void> {
		const next = [entry, ...this.host.settings.auditLog]
			.filter((candidate, index, collection) => {
				return collection.findIndex((other) => other.id === candidate.id) === index;
			})
			.slice(0, this.host.settings.maxAuditEntries);
		this.host.settings.auditLog = next;
		await this.host.saveSettings();
	}

	async removeById(entryId: string): Promise<AuditEntry | null> {
		const existing = this.host.settings.auditLog.find((entry) => entry.id === entryId) ?? null;
		if (!existing) {
			return null;
		}

		this.host.settings.auditLog = this.host.settings.auditLog.filter((entry) => entry.id !== entryId);
		await this.host.saveSettings();
		return existing;
	}

	async removeLast(): Promise<AuditEntry | null> {
		const latest = this.getLastEntry();
		if (!latest) {
			return null;
		}

		return this.removeById(latest.id);
	}
}
