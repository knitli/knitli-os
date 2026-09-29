import {
  isOutputIcon,
  type MessageFormatRef,
  type OutputIcon,
  type SlashCommandChoice,
  type SlashCommandId,
} from "@gadgets/workshop-shared/api";

const COMPOSER_DRAFT_PREFIX = "gadgets:composer-draft:v1";

export type ComposerDraftCapsule = {
  start: number;
  length: number;
  url: string;
};

export type ComposerDraftFormat = {
  start: number;
  length: number;
  noun: string;
  icon: OutputIcon;
};

export type ComposerDraftSlashCommand = {
  start: number;
  length: number;
  choice: SlashCommandChoice;
};

type StoredComposerDraftSlashCommand = {
  position: number;
  length: number;
  choice: SlashCommandChoice;
};

export type StoredComposerDraftSpeechRange = {
  position: number;
  length: number;
};

export type StoredComposerDraft = {
  version: 1;
  text: string;
  formats: MessageFormatRef[];
  command?: StoredComposerDraftSlashCommand;
  hasSpeech?: boolean;
  /** Exact text spans originating in Dictate; absent records use the legacy whole-text marker. */
  speechRanges?: StoredComposerDraftSpeechRange[];
};

export type RestoredComposerDraft = {
  text: string;
  formats: Array<ComposerDraftFormat & { logo?: string }>;
  command?: ComposerDraftSlashCommand;
};

export function composerDraftStorageKey(userId: string, scope: string): string {
  return `${COMPOSER_DRAFT_PREFIX}:${userId}:${scope}`;
}

export function serializeComposerDraft(
  text: string,
  capsules: readonly ComposerDraftCapsule[],
  formats: readonly ComposerDraftFormat[],
  command?: ComposerDraftSlashCommand,
  hasSpeech?: boolean,
  speechRanges?: readonly { start: number; end: number }[],
): StoredComposerDraft {
  const tokens: Array<
    | (ComposerDraftCapsule & { kind: "capsule" })
    | (ComposerDraftFormat & { kind: "format" })
    | (ComposerDraftSlashCommand & { kind: "command" })
  > = [
    ...capsules.map((capsule) => ({ ...capsule, kind: "capsule" as const })),
    ...formats.map((format) => ({ ...format, kind: "format" as const })),
    ...(command ? [{ ...command, kind: "command" as const }] : []),
  ].toSorted((a, b) => a.start - b.start);

  let normalized = "";
  let cursor = 0;
  const storedFormats: MessageFormatRef[] = [];
  let storedCommand: StoredComposerDraftSlashCommand | undefined;
  const replacements: Array<{ start: number; end: number; normalizedStart: number; normalizedEnd: number }> = [];
  for (const token of tokens) {
    if (token.start < cursor || token.start < 0 || token.length < 0 ||
        token.start + token.length > text.length) {
      continue;
    }
    normalized += text.slice(cursor, token.start);
    // Capsule capability URLs restore as plain links, not chips.
    const replacement = token.kind === "capsule"
      ? token.url
      : token.kind === "format"
        ? token.noun
        : `/${token.choice.name}`;
    const normalizedStart = normalized.length;
    if (token.kind === "format") {
      storedFormats.push({
        position: normalized.length,
        length: replacement.length,
        noun: token.noun,
        icon: token.icon,
      });
    } else if (token.kind === "command") {
      storedCommand = {
        position: normalized.length,
        length: replacement.length,
        choice: token.choice,
      };
    }
    normalized += replacement;
    replacements.push({
      start: token.start,
      end: token.start + token.length,
      normalizedStart,
      normalizedEnd: normalized.length,
    });
    cursor = token.start + token.length;
  }
  normalized += text.slice(cursor);

  const mapSpeechPosition = (position: number, edge: "start" | "end") => {
    let delta = 0;
    for (const replacement of replacements) {
      if (position <= replacement.start) return position + delta;
      if (position < replacement.end) {
        return edge === "start" ? replacement.normalizedStart : replacement.normalizedEnd;
      }
      delta += replacement.normalizedEnd - replacement.normalizedStart -
        (replacement.end - replacement.start);
    }
    return position + delta;
  };
  const storedSpeechRanges = !hasSpeech ? [] : speechRanges?.flatMap((range) => {
    const start = Math.max(0, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    const position = mapSpeechPosition(start, "start");
    const mappedEnd = mapSpeechPosition(end, "end");
    return mappedEnd > position ? [{ position, length: mappedEnd - position }] : [];
  }) ?? [];

  return {
    version: 1,
    text: normalized,
    formats: storedFormats,
    ...(storedCommand && { command: storedCommand }),
    ...(hasSpeech && { hasSpeech: true }),
    ...(storedSpeechRanges.length > 0 && { speechRanges: storedSpeechRanges }),
  };
}

export function decorateComposerDraft(
  draft: StoredComposerDraft,
  logos: readonly (string | undefined)[],
  logoSlot: string,
): RestoredComposerDraft {
  let text = "";
  let cursor = 0;
  const formats: RestoredComposerDraft["formats"] = [];
  const command = draft.command && {
    start: draft.command.position,
    length: draft.command.length,
    choice: draft.command.choice,
  };
  for (const [index, format] of draft.formats.entries()) {
    text += draft.text.slice(cursor, format.position);
    const logo = logos[index];
    const prefix = logo ? logoSlot : "";
    const start = text.length;
    text += prefix + format.noun;
    formats.push({
      start,
      length: prefix.length + format.length,
      noun: format.noun,
      icon: format.icon,
      ...(logo ? { logo } : {}),
    });
    if (command && format.position + format.length <= draft.command!.position) {
      command.start += prefix.length;
    }
    cursor = format.position + format.length;
  }
  text += draft.text.slice(cursor);
  if (!command) return { text, formats };

  const commandText = `/${command.choice.name}`;
  const commandEnd = command.start + command.length;
  const delta = commandText.length - command.length;
  text = text.slice(0, command.start) + commandText + text.slice(commandEnd);
  command.length = commandText.length;
  return {
    text,
    formats: formats.map(format => format.start >= commandEnd
      ? {...format, start: format.start + delta}
      : format),
    command,
  };
}

function readSlashCommandId(value: unknown): SlashCommandId | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.builtin === true) {
    return record.commandId === "compact" ? { builtin: true, commandId: "compact" } : undefined;
  }
  if (record.builtin !== undefined || !Number.isInteger(record.gatekeeperId) ||
      typeof record.commandId !== "string" || !record.commandId) {
    return undefined;
  }
  return { gatekeeperId: record.gatekeeperId as number, commandId: record.commandId };
}

function readSlashCommandChoice(value: unknown): SlashCommandChoice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const selection = readSlashCommandId(record.selection);
  if (!selection || typeof record.name !== "string" || !record.name ||
      "builtin" in selection && record.name !== selection.commandId ||
      typeof record.description !== "string" || typeof record.providerLabel !== "string" ||
      record.resourceLabel !== undefined && typeof record.resourceLabel !== "string") {
    return undefined;
  }
  return {
    selection,
    name: record.name,
    description: record.description,
    providerLabel: record.providerLabel,
    ...(record.resourceLabel !== undefined && { resourceLabel: record.resourceLabel as string }),
  };
}

export function readComposerDraft(key: string | undefined): StoredComposerDraft | undefined {
  if (!key) return undefined;
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || typeof record.text !== "string" ||
        !Array.isArray(record.formats)) {
      return undefined;
    }

    const formats: MessageFormatRef[] = [];
    let previousEnd = 0;
    for (const candidate of record.formats) {
      if (!candidate || typeof candidate !== "object") return undefined;
      const format = candidate as Record<string, unknown>;
      if (!Number.isInteger(format.position) || !Number.isInteger(format.length) ||
          typeof format.noun !== "string" || !isOutputIcon(format.icon)) {
        return undefined;
      }
      const position = format.position as number;
      const length = format.length as number;
      if (position < previousEnd || format.noun.length === 0 || length !== format.noun.length ||
          record.text.slice(position, position + length) !== format.noun) {
        return undefined;
      }
      formats.push({ position, length, noun: format.noun, icon: format.icon });
      previousEnd = position + length;
    }

    let command: StoredComposerDraftSlashCommand | undefined;
    if (record.command !== undefined) {
      if (!record.command || typeof record.command !== "object") return undefined;
      const candidate = record.command as Record<string, unknown>;
      const choice = readSlashCommandChoice(candidate.choice);
      if (!Number.isInteger(candidate.position) || !Number.isInteger(candidate.length) || !choice) {
        return undefined;
      }
      const position = candidate.position as number;
      const length = candidate.length as number;
      if (position < 0 || length !== choice.name.length + 1 ||
          record.text.slice(position, position + length) !== `/${choice.name}` ||
          formats.some(format => position < format.position + format.length &&
            format.position < position + length)) {
        return undefined;
      }
      command = { position, length, choice };
    }
    if (record.hasSpeech !== undefined && record.hasSpeech !== true) return undefined;
    let speechRanges: StoredComposerDraftSpeechRange[] | undefined;
    if (record.speechRanges !== undefined) {
      if (record.hasSpeech !== true || !Array.isArray(record.speechRanges)) return undefined;
      let previousEnd = 0;
      speechRanges = [];
      for (const candidate of record.speechRanges) {
        if (!candidate || typeof candidate !== "object") return undefined;
        const range = candidate as Record<string, unknown>;
        if (!Number.isInteger(range.position) || !Number.isInteger(range.length)) return undefined;
        const position = range.position as number;
        const length = range.length as number;
        if (position < previousEnd || length <= 0 || position + length > record.text.length) {
          return undefined;
        }
        speechRanges.push({ position, length });
        previousEnd = position + length;
      }
      if (speechRanges.length === 0) return undefined;
    }
    return { version: 1, text: record.text, formats, ...(command && { command }),
      ...(record.hasSpeech === true && { hasSpeech: true }),
      ...(speechRanges && { speechRanges }) };
  } catch {
    return undefined;
  }
}

export function writeComposerDraft(
  key: string | undefined,
  draft: StoredComposerDraft | undefined,
): void {
  if (!key) return;
  try {
    if (draft?.text) {
      window.sessionStorage.setItem(key, JSON.stringify(draft));
    } else {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Storage can be unavailable in restricted browser contexts. Draft recovery is best-effort.
  }
}
