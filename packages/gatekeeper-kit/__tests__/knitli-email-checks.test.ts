import { describe, expect, it } from "vitest";
import {
  addresses, displayName, isAddress, messageIds, singleLine,
} from "../src/fork/email-checks.js";

describe("isAddress / addresses", () => {
  it.each(["alice@example.com", "a.b+tag@sub.example.co", "x@a-b.example"])("accepts %s", value => {
    expect(isAddress(value)).toBe(true);
  });

  it.each([
    "Alice <alice@example.com>", "a..b@example.com", ".a@example.com", "al\u0000ice@example.com",
    "alice@localhost", `a@${"x".repeat(64)}.com`, `${"a".repeat(65)}@example.com`, "a b@example.com", "@example.com",
  ])("refuses %j", value => {
    expect(isAddress(value)).toBe(false);
  });

  it("trims, defaults to none, and names the field on a bad entry", () => {
    expect(addresses("to", undefined)).toEqual([]);
    expect(addresses("to", [" a@example.com "])).toEqual(["a@example.com"]);
    expect(() => addresses("cc", ["nope"])).toThrow(/^cc: "nope" is not a plain email/);
    expect(() => addresses("to", "a@example.com" as unknown as string[])).toThrow(/array of addresses/);
  });
});

describe("messageIds", () => {
  it("normalises whitespace and enforces the count", () => {
    expect(messageIds("references", "  <a@x.com>   <b@x.com> ", 20)).toBe("<a@x.com> <b@x.com>");
    expect(messageIds("inReplyTo", undefined, 1)).toBeNull();
    expect(() => messageIds("inReplyTo", "<a@x.com> <b@x.com>", 1)).toThrow(/a Message-ID/);
    expect(() => messageIds("references", "a@x.com", 20)).toThrow(/Message-IDs/);
    expect(() => messageIds("inReplyTo", "<a\u0000@x.com>", 1)).toThrow(/Message-ID/);
  });
});

describe("singleLine / displayName", () => {
  it("refuses line breaks, control characters and over-long values", () => {
    expect(singleLine("subject", "Hi", 10)).toBe("Hi");
    for (let bad of ["Hi\r\nBcc: x@evil.com", "Hi\nthere", "Hi\rthere"]) {
      expect(() => singleLine("subject", bad, 100)).toThrow(/subject must not contain line breaks/);
    }
    expect(() => singleLine("subject", "Hi\u0000", 100)).toThrow(/control characters/);
    expect(() => singleLine("subject", "Hi\u0085", 100)).toThrow(/control characters/);
    expect(() => singleLine("subject", "x".repeat(11), 10)).toThrow(/longer than 10/);
  });

  it("keeps a display name from posing as an address", () => {
    expect(displayName("fromName", "Alice B.", 100)).toBe("Alice B.");
    for (let bad of ["ceo@bank.com", "A <b>", 'A"B', "A\\B"]) {
      expect(() => displayName("fromName", bad, 100)).toThrow(/fromName must not contain < > @/);
    }
    expect(() => displayName("fromName", "A\nB", 100)).toThrow(/line breaks/);
  });
});
