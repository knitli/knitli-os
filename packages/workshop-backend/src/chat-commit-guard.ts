/**
 * Complete asynchronous chat preparation, then synchronously revalidate the caller before any
 * caller-controlled content is committed. `newChat()` and `sendChatMessage()` perform only
 * synchronous storage/start-agent work after this returns.
 *
 * @internal Exported only so the security-critical ordering has a narrow unit regression.
 */
export async function prepareAuthorizedChatCommit<T>(
  prepare: () => Promise<T>,
  commitGuard?: () => void,
): Promise<T> {
  let prepared = await prepare();
  commitGuard?.();
  return prepared;
}
