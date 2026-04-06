import type { MarkdownView, TFile } from "obsidian";
import type { BetterCorrectSettings, CandidateContext, CandidateRange, EnrichedCandidateContext } from "./types";

const WORD_CHAR = /[A-Za-z0-9._'-]/;
const TOKEN_PATTERN = /[A-Za-z0-9._'-]+/g;
const SUSPICIOUS_PUNCTUATION = /[@$%^&*+=|~<>]/;
const URL_PATTERN = /^(?:[a-z]+:\/\/|www\.)/i;
const FILE_PATH_PATTERN = /^(?:\.{1,2}\/|~\/|\/|[A-Za-z]:\\)/;
const TAG_PATTERN = /(^|[^A-Za-z0-9])#[\p{L}\p{N}_/\-]+$/u;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
const CODE_FENCE_PATTERN = /^(\s*)(`{3,}|~{3,})/;
const APPROVED_LOWERCASE_ABBREVIATIONS = new Set([
	"api",
	"cpu",
	"css",
	"db",
	"dns",
	"gpu",
	"html",
	"http",
	"https",
	"ide",
	"ip",
	"json",
	"llm",
	"rpc",
	"sdk",
	"sql",
	"ssh",
	"tcp",
	"udp",
	"ui",
	"url",
	"ux",
]);
const COMMON_PROSE_WORDS = new Set([
	"about",
	"after",
	"again",
	"around",
	"before",
	"being",
	"best",
	"between",
	"computer",
	"create",
	"delete",
	"dictionary",
	"epic",
	"external",
	"file",
	"hello",
	"importer",
	"input",
	"into",
	"love",
	"make",
	"my",
	"new",
	"note",
	"operating",
	"or",
	"own",
	"ready",
	"really",
	"something",
	"system",
	"that",
	"the",
	"thing",
	"this",
	"try",
	"vault",
	"well",
	"welcome",
	"when",
	"with",
	"word",
	"world",
	"your",
]);

function safeRegExp(pattern: string): RegExp | null {
	try {
		return new RegExp(pattern);
	} catch {
		return null;
	}
}

function lineSlice(line: string, from: number, to: number): string {
	return line.slice(Math.max(0, from), Math.max(0, to));
}

function getTokenBounds(line: string, ch: number): CandidateRange | null {
	if (!line.length) {
		return null;
	}

	let pivot = Math.min(Math.max(ch, 0), line.length);
	const charAtPivot = line[pivot];
	const beforePivot = line[pivot - 1];
	if (!WORD_CHAR.test(charAtPivot ?? "") && WORD_CHAR.test(beforePivot ?? "")) {
		pivot -= 1;
	}

	if (!WORD_CHAR.test(line[pivot] ?? "")) {
		return null;
	}

	let from = pivot;
	let to = pivot + 1;
	while (from > 0 && WORD_CHAR.test(line[from - 1] ?? "")) {
		from -= 1;
	}
	while (to < line.length && WORD_CHAR.test(line[to] ?? "")) {
		to += 1;
	}

	return { from, to };
}

function trimToken(token: string): string {
	return token
		.replace(/^[`"'([{<]+/g, "")
		.replace(/[`"'!?\)\]}>.,:;]+$/g, "");
}

function isInsideDelimitedSpan(line: string, offset: number, delimiter: string): boolean {
	let count = 0;
	for (let index = 0; index < Math.min(offset, line.length); index += 1) {
		if (line[index] === "\\" && index + 1 < offset) {
			index += 1;
			continue;
		}

		if (line[index] === delimiter) {
			count += 1;
		}
	}

	return count % 2 === 1;
}

function isInsideLinkLikeSyntax(line: string, range: CandidateRange): boolean {
	const before = lineSlice(line, 0, range.from);
	const after = lineSlice(line, range.to, line.length);

	if (before.lastIndexOf("[[") > before.lastIndexOf("]]") && after.includes("]]")) {
		return true;
	}

	if (before.lastIndexOf("[") > before.lastIndexOf("]") && after.includes("](")) {
		return true;
	}

	if (before.lastIndexOf("](") > before.lastIndexOf(")") && after.includes(")")) {
		return true;
	}

	if (before.lastIndexOf("<") > before.lastIndexOf(">") && after.includes(">")) {
		return true;
	}

	return false;
}

function overlapsPattern(line: string, range: CandidateRange, pattern: RegExp): boolean {
	for (const match of line.matchAll(pattern)) {
		const start = match.index ?? -1;
		const value = match[0];
		if (!value || start < 0) {
			continue;
		}

		const end = start + value.length;
		if (start < range.to && end > range.from) {
			return true;
		}
	}

	return false;
}

function isInsideUrlOrPath(line: string, range: CandidateRange): boolean {
	return (
		overlapsPattern(line, range, /(?:[a-z]+:\/\/|www\.)[^\s)>\]]+/gi) ||
		overlapsPattern(line, range, /(?:\.{1,2}\/|~\/|\/|[A-Za-z]:\\)[^\s)>\]]+/g)
	);
}

function extractSentence(line: string, range: CandidateRange): string {
	const before = lineSlice(line, 0, range.from);
	const after = lineSlice(line, range.to, line.length);
	const sentenceStart = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"));
	const sentenceEndCandidates = [after.indexOf("."), after.indexOf("!"), after.indexOf("?")].filter((value) => value >= 0);
	const sentenceEnd = sentenceEndCandidates.length > 0 ? Math.min(...sentenceEndCandidates) : after.length;
	return (before.slice(sentenceStart + 1) + lineSlice(line, range.from, range.to) + after.slice(0, sentenceEnd + 1)).trim();
}

function normalizeWord(rawToken: string): string {
	return trimToken(rawToken).replace(/^#+/, "").replace(/#+$/, "");
}

function matchesPatterns(word: string, patterns: string[]): boolean {
	return patterns.some((pattern) => {
		const expression = safeRegExp(pattern);
		return expression ? expression.test(word) : false;
	});
}

export function matchesConfiguredPatterns(word: string, patterns: string[]): boolean {
	return matchesPatterns(word, patterns);
}

export function isApprovedLowercaseAbbreviation(word: string): boolean {
	return APPROVED_LOWERCASE_ABBREVIATIONS.has(word);
}

export function isCommonProseWord(word: string): boolean {
	return COMMON_PROSE_WORDS.has(word.toLowerCase());
}

function isSuspiciousWord(word: string): boolean {
	if (!word || word.length < 2) {
		return true;
	}

	if (URL_PATTERN.test(word) || FILE_PATH_PATTERN.test(word)) {
		return true;
	}

	if (EMOJI_PATTERN.test(word)) {
		return true;
	}

	if (SUSPICIOUS_PUNCTUATION.test(word)) {
		return true;
	}

	if (!/[A-Za-z]/.test(word)) {
		return true;
	}

	if (/^\d[\d._-]*$/.test(word)) {
		return true;
	}

	return false;
}

export function looksTechnical(word: string): boolean {
	return (
		/[A-Z].*[A-Z]/.test(word) ||
		/[a-z][A-Z]/.test(word) ||
		/[A-Z][a-z]+[A-Z]/.test(word) ||
		/\d/.test(word) ||
		/[.-]/.test(word) ||
		/^[A-Z]{2,}$/.test(word) ||
		/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(word)
	);
}

function buildCandidate(
	file: TFile,
	lineText: string,
	line: number,
	range: CandidateRange,
	settings: BetterCorrectSettings,
	options?: { manual?: boolean },
): CandidateContext | null {
	if (isInsideDelimitedSpan(lineText, range.from, "`") || isInsideDelimitedSpan(lineText, range.from, "$")) {
		return null;
	}

	if (isInsideLinkLikeSyntax(lineText, range) || isInsideUrlOrPath(lineText, range)) {
		return null;
	}

	const rawToken = lineSlice(lineText, range.from, range.to);
	const normalizedWord = normalizeWord(rawToken);
	const manual = options?.manual === true;
	if (!normalizedWord || (!manual && normalizedWord.length > settings.maxWordLength)) {
		return null;
	}

	const matchesAllowlist = matchesPatterns(normalizedWord, settings.allowlistPatterns);
	const lowercaseAbbreviationAllowed =
		settings.allowLowercaseAbbreviations &&
		isApprovedLowercaseAbbreviation(normalizedWord.toLowerCase());

	if (!manual && matchesPatterns(normalizedWord, settings.blocklistPatterns)) {
		return null;
	}

	if (TAG_PATTERN.test(lineSlice(lineText, 0, range.to))) {
		return null;
	}

	if (isSuspiciousWord(normalizedWord)) {
		return null;
	}

	if (
		!manual &&
		settings.acronymOnlyMode &&
		!matchesAllowlist &&
		!lowercaseAbbreviationAllowed &&
		!/^[A-Z0-9][A-Z0-9.-]*$/.test(normalizedWord)
	) {
		return null;
	}

	return {
		filePath: file.path,
		fileTitle: file.basename,
		line,
		range,
		word: rawToken,
		normalizedWord,
	};
}

export function enrichCandidateContext(view: MarkdownView, candidate: CandidateContext): EnrichedCandidateContext {
	const lineText = view.editor?.getLine(candidate.line) ?? "";
	const contextBefore = lineSlice(lineText, Math.max(0, candidate.range.from - 80), candidate.range.from).trim();
	const contextAfter = lineSlice(
		lineText,
		candidate.range.to,
		Math.min(lineText.length, candidate.range.to + 80),
	).trim();

	return {
		...candidate,
		contextBefore,
		contextAfter,
		sentence: extractSentence(lineText, candidate.range),
	};
}

function lineHasCodeFence(lineText: string): boolean {
	return CODE_FENCE_PATTERN.test(lineText);
}

export function scanDocumentCandidatesInRange(
	view: MarkdownView,
	settings: BetterCorrectSettings,
	fromLine: number,
	toLine: number,
	options?: { manual?: boolean },
): CandidateContext[] {
	const editor = view.editor;
	const file = view.file;
	if (!editor || !file) {
		return [];
	}

	const lineCount = editor.lineCount();
	if (lineCount === 0) {
		return [];
	}

	const safeFromLine = Math.max(0, Math.min(fromLine, lineCount - 1));
	const safeToLine = Math.max(safeFromLine, Math.min(toLine, lineCount - 1));

	const candidates = new Map<string, CandidateContext>();
	let insideCodeFence = false;
	for (let line = 0; line < safeFromLine; line += 1) {
		if (lineHasCodeFence(editor.getLine(line))) {
			insideCodeFence = !insideCodeFence;
		}
	}

	for (let line = safeFromLine; line <= safeToLine; line += 1) {
		const lineText = editor.getLine(line);
		const hasFence = lineHasCodeFence(lineText);
		if (hasFence) {
			insideCodeFence = !insideCodeFence;
			continue;
		}

		if (insideCodeFence) {
			continue;
		}

		for (const match of lineText.matchAll(TOKEN_PATTERN)) {
			const token = match[0];
			const from = match.index ?? -1;
			if (!token || from < 0) {
				continue;
			}

			const candidate = buildCandidate(file, lineText, line, { from, to: from + token.length }, settings, options);
			if (!candidate) {
				continue;
			}

			candidates.set(candidateKey(candidate), candidate);
		}
	}

	return [...candidates.values()];
}

export function scanDocumentCandidates(
	view: MarkdownView,
	settings: BetterCorrectSettings,
	options?: { manual?: boolean },
): CandidateContext[] {
	const lineCount = view.editor?.lineCount() ?? 0;
	if (lineCount === 0) {
		return [];
	}

	return scanDocumentCandidatesInRange(view, settings, 0, lineCount - 1, options);
}

export function detectCandidateAtCursor(
	view: MarkdownView,
	settings: BetterCorrectSettings,
	options?: { manual?: boolean },
): CandidateContext | null {
	const editor = view.editor;
	const file = view.file;
	if (!editor || editor.somethingSelected() || !file) {
		return null;
	}

	const cursor = editor.getCursor();
	const lineText = editor.getLine(cursor.line);
	const range = getTokenBounds(lineText, cursor.ch);
	if (!range) {
		return null;
	}

	let insideCodeFence = false;
	for (let line = 0; line <= cursor.line; line += 1) {
		if (lineHasCodeFence(editor.getLine(line))) {
			insideCodeFence = !insideCodeFence;
		}
	}
	if (insideCodeFence) {
		return null;
	}

	return buildCandidate(file, lineText, cursor.line, range, settings, options);
}

export function candidateKey(candidate: CandidateContext): string {
	return [
		candidate.filePath,
		candidate.line,
		candidate.range.from,
		candidate.range.to,
		candidate.normalizedWord.toLowerCase(),
	].join(":");
}

export function cacheKey(candidate: EnrichedCandidateContext): string {
	return [candidate.normalizedWord.toLowerCase(), candidate.filePath, candidate.sentence.toLowerCase()].join("::");
}
