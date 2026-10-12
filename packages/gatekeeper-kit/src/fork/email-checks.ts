// Address and header checks for outbound mail, extracted from gatekeeper-email/src/fork/send.ts
// (itself ported from michielappelman/cloudflare-os 162f9d7, Apache-2.0) so other fork packages
// that build mail headers can reuse them. Each check throws an Error naming the offending field.

// Deliberately strict: a bare ASCII addr-spec (RFC 5322 atext local part, LDH domain), no display
// name, comments, whitespace or control characters, so the approver sees exactly the address the
// mail goes to.
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
// A Message-ID as it appears in headers: `<local@domain>` in printable ASCII, never several at once.
const MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]+@[\x21-\x3b\x3d\x3f-\x7e]+>$/;
/** Any control character: C0, DEL and C1. */
export const CONTROL = /\p{Cc}/u;

/** True for a plain addr-spec within the RFC 5321 length limits. */
export function isAddress(value: string): boolean {
  let at = value.lastIndexOf("@");
  return at > 0 && at <= 64 && value.length <= 254 &&
      LOCAL_PART.test(value.slice(0, at)) && DOMAIN.test(value.slice(at + 1)) &&
      value.slice(at + 1).split(".").every(label => label.length <= 63);
}

/** Trimmed addresses of `value`, or `[]` when absent; throws naming `field` on any non-plain address. */
export function addresses(field: string, value: string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of addresses.`);
  return value.map(address => {
    if (typeof address !== "string" || !isAddress(address.trim())) {
      throw new Error(`${field}: ${JSON.stringify(address)} is not a plain email address ` +
          `such as "name@example.com".`);
    }
    return address.trim();
  });
}

/** `value` as space-joined Message-IDs (at most `max`), null when blank; throws otherwise. */
export function messageIds(field: string, value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  if (value.trim() === "") return null;
  let ids = value.trim().split(/\s+/);
  if (ids.length > max || !ids.every(id => id.length <= 255 && MESSAGE_ID.test(id))) {
    throw new Error(`${field} must be ${max === 1 ? "a Message-ID" : "Message-IDs"} such as ` +
        `"<abc@example.com>"${max === 1 ? "" : ` (at most ${max})`}.`);
  }
  return ids.join(" ");
}

/** `value` if it is a string within `max` characters with no line breaks or control characters. */
export function singleLine(field: string, value: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  if (/[\r\n]/.test(value)) throw new Error(`${field} must not contain line breaks.`);
  if (CONTROL.test(value)) throw new Error(`${field} must not contain control characters.`);
  if (value.length > max) throw new Error(`${field} is longer than ${max} characters.`);
  return value;
}

/**
 * A display name is the one free-form part of From; keep it from posing as an address. Same rules
 * as `singleLine`, and no `< > @ " \` or control characters.
 */
export function displayName(field: string, value: string, max: number): string {
  singleLine(field, value, max);
  if (/[<>@"\\]/.test(value) || CONTROL.test(value)) {
    throw new Error(`${field} must not contain < > @ " \\ or control characters.`);
  }
  return value;
}
