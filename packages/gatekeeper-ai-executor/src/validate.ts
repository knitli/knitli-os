/**
 * Shape predicates shared by the three validators in this Worker: the wire protocol parser, the
 * runtime profile parser, and the persisted run-state parser. Each caller keeps its own error, so
 * a malformed request, a malformed profile, and malformed durable state stay distinguishable.
 */

const ENCODER = new TextEncoder();
/** C0 and C1 control characters, including DEL. */
const CONTROL_CHARACTER_RE = /\p{Cc}/u;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The first own key that is not allowed, or undefined when every key is. */
export function extraKey(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).length === expected.length && extraKey(value, expected) === undefined
  );
}

export function utf8Bytes(value: string): number {
  return ENCODER.encode(value).byteLength;
}

export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER_RE.test(value);
}
