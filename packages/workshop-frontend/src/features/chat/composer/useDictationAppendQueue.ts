import { useCallback, useRef, useState } from "react";

/** A finalized Dictate segment awaiting insertion into its originating chat's composer. */
export type DictationAppend = {
  token: number;
  text: string;
  chatKey: number | null;
  segmentId?: number;
  final?: boolean;
};

/**
 * Coordinates finalized Dictate text with a composer's passive append effect.
 *
 * Segments retain their originating chat and an acknowledgement can remove only its own token.
 */
export const useDictationAppendQueue = () => {
  const [appends, setAppends] = useState<readonly DictationAppend[]>([]);
  const nextToken = useRef(0);

  const enqueue = useCallback((text: string, chatKey: number | null, segmentId?: number, final = true) => {
    const append = {
      token: ++nextToken.current,
      text,
      chatKey,
      segmentId,
      final,
    };
    setAppends((current) => [...current, append]);
  }, []);

  const appendForChat = useCallback((chatKey: number | null) =>
    appends.find((append) => append.chatKey === chatKey) ?? null, [appends]);

  const acknowledge = useCallback((token: number) => {
    setAppends((current) => current.filter((append) => append.token !== token));
  }, []);

  return { enqueue, appendForChat, acknowledge };
};
