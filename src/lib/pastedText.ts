/** Thresholds for collapsing pasted text into a compact snippet chip. */
export const LONG_PASTE_CHAR_THRESHOLD = 2000;
export const LONG_PASTE_LINE_THRESHOLD = 40;

/** Locale-independent inline reference placed in the composer textarea. */
export const PASTE_TOKEN_RE = /\[\[paste:#(\d+)\]\]/g;

export type PastedSnippet = {
  id: string;
  content: string;
  lineCount: number;
  /** 1-based display index assigned at creation time. */
  index: number;
};

export function countLines(text: string): number {
  if (!text) return 0;
  // Trailing newline should not inflate the count beyond real lines of content.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.length === 0) return 0;
  const parts = normalized.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') {
    return parts.length - 1;
  }
  return parts.length;
}

export function isLongPastedText(text: string): boolean {
  if (!text) return false;
  if (text.length >= LONG_PASTE_CHAR_THRESHOLD) return true;
  return countLines(text) >= LONG_PASTE_LINE_THRESHOLD;
}

export function createPastedSnippet(
  content: string,
  nextIndex: number,
  idFactory: () => string = () => `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
): PastedSnippet {
  return {
    id: idFactory(),
    content,
    lineCount: countLines(content),
    index: nextIndex,
  };
}

export function formatPasteToken(index: number): string {
  return `[[paste:#${index}]]`;
}

/**
 * Insert a paste reference token at the current selection (or replace the selection).
 * Returns the new value and caret position after the inserted token.
 */
export function insertPasteTokenAtSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  index: number,
): { value: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const token = formatPasteToken(index);
  const next = `${value.slice(0, start)}${token}${value.slice(end)}`;
  return { value: next, caret: start + token.length };
}

/** Remove every `[[paste:#index]]` occurrence from the composer text. */
export function removePasteTokens(value: string, index: number): string {
  const token = formatPasteToken(index);
  if (!value.includes(token)) return value;
  // Drop whole lines that only contain the token, then strip any leftover inline uses.
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineOnly = new RegExp(`^[ \\t]*${escaped}[ \\t]*\\n?`, 'gm');
  return value
    .replace(lineOnly, '')
    .split(token)
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n');
}

/** Replace every `[[paste:#index]]` with the given content (e.g. expand back into the textarea). */
export function replacePasteTokensWithContent(
  value: string,
  index: number,
  content: string,
): string {
  const token = formatPasteToken(index);
  if (!value.includes(token)) {
    // Token was already deleted by the user — append so expand still surfaces the text.
    if (!value) return content;
    const needsGap = !value.endsWith('\n');
    return `${value}${needsGap ? '\n' : ''}${content}`;
  }
  return value.split(token).join(content);
}

function formatSnippetBlock(snippet: PastedSnippet): string {
  const header = `[Pasted text #${snippet.index} · ${snippet.lineCount} lines]`;
  return `---\n${header}\n${snippet.content}\n---`;
}

/**
 * Expand inline `[[paste:#N]]` tokens in order, then append any orphan snippets
 * (present in state but missing from the text) so content is never silently dropped.
 */
export function mergePastedSnippetsIntoContent(
  userText: string,
  snippets: PastedSnippet[],
): string {
  if (snippets.length === 0) return userText.trim();

  const byIndex = new Map(snippets.map((s) => [s.index, s]));
  const referenced = new Set<number>();

  // Rebuild with tokens expanded; missing snippets drop their tokens silently.
  let result = '';
  let lastIndex = 0;
  const re = new RegExp(PASTE_TOKEN_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(userText)) !== null) {
    result += userText.slice(lastIndex, match.index);
    const idx = Number(match[1]);
    const snippet = byIndex.get(idx);
    if (snippet) {
      referenced.add(idx);
      result += formatSnippetBlock(snippet);
    }
    // else: drop dangling token
    lastIndex = match.index + match[0].length;
  }
  result += userText.slice(lastIndex);

  const orphans = snippets.filter((s) => !referenced.has(s.index));
  if (orphans.length > 0) {
    const orphanBlocks = orphans.map((s) => formatSnippetBlock(s)).join('\n\n');
    const trimmed = result.trim();
    result = trimmed ? `${trimmed}\n\n${orphanBlocks}` : orphanBlocks;
  }

  return result.trim();
}
