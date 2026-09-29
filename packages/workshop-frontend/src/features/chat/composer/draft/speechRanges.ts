import type { ComposerTextEdit } from "../composerDocument";

export type SpeechRange = {
  start: number;
  end: number;
};

export type SpeechTextSelection = ComposerTextEdit;

export const speechRangesAfterTextEdit = (
  ranges: readonly SpeechRange[],
  previousText: string,
  nextText: string,
  selection?: SpeechTextSelection,
): SpeechRange[] => {
  let editStart: number;
  let previousEnd: number;
  let nextEnd: number;
  const selectionReplacementEnd = selection === undefined ? undefined : selection.start + nextText.length -
    (previousText.length - (selection.end - selection.start));
  if (selection !== undefined && selection.start >= 0 && selection.end >= selection.start &&
      selection.end <= previousText.length && selectionReplacementEnd !== undefined &&
      selectionReplacementEnd >= selection.start &&
      previousText.slice(0, selection.start) === nextText.slice(0, selection.start) &&
      previousText.slice(selection.end) === nextText.slice(selectionReplacementEnd)) {
    editStart = selection.start;
    previousEnd = selection.end;
    nextEnd = selectionReplacementEnd;
  } else {
    editStart = 0;
    while (editStart < previousText.length && editStart < nextText.length &&
        previousText[editStart] === nextText[editStart]) {
      editStart++;
    }
    previousEnd = previousText.length;
    nextEnd = nextText.length;
    while (previousEnd > editStart && nextEnd > editStart &&
        previousText[previousEnd - 1] === nextText[nextEnd - 1]) {
      previousEnd--;
      nextEnd--;
    }
  }
  const shift = nextEnd - previousEnd;
  return ranges.flatMap((range) => {
    if (range.end <= editStart) return [range];
    if (range.start >= previousEnd) return [{ start: range.start + shift, end: range.end + shift }];
    const survivors: SpeechRange[] = [];
    if (range.start < editStart) survivors.push({ start: range.start, end: editStart });
    if (range.end > previousEnd) {
      survivors.push({ start: nextEnd, end: nextEnd + range.end - previousEnd });
    }
    return survivors;
  });
};
