import { describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_CONFIG, defaultOutputFormatId, enabledResourcePatterns, filterEnabledResources, isResourceDisabled, parseAdminConfig, reorderFormats, resolveFormatOutput, sanitizeOutputOverrides, serializeAdminConfig } from "../src/admin-config.js";

describe("parseAdminConfig", () => {
  it("backfills fields missing from a config persisted before they existed", () => {
    // A config written before `formats` was added. Every consumer indexes into these, so a missing
    // field must come back as its default rather than undefined.
    let stored = JSON.stringify({ signupsEnabled: false, siteName: "acme" });
    let config = parseAdminConfig(stored);

    expect(config.signupsEnabled).toBe(false);
    expect(config.siteName).toBe("acme");
    expect(config.formats).toEqual([]);
    for (let key of Object.keys(DEFAULT_ADMIN_CONFIG)) {
      expect(config[key as keyof typeof config], key).toBeDefined();
    }
  });

  it("drops malformed format entries rather than the whole list", () => {
    let config = parseAdminConfig(JSON.stringify({
      formats: [
        { blueprintId: "good", enabled: true, agentHint: "  prefer me  " },
        { enabled: true },                       // no blueprintId
        "nonsense",
        { blueprintId: "defaults-enabled" },     // enabled omitted
      ],
    }));

    expect(config.formats).toEqual([
      { blueprintId: "good", enabled: true, agentHint: "prefer me" },
      { blueprintId: "defaults-enabled", enabled: true },
    ]);
  });

  // Everything downstream keys formats by blueprint id; setFormatOrder() in particular treats the
  // list as a set and refuses every reordering if it isn't one. A duplicate would make the menu
  // permanently unorderable, so it can't be allowed to survive a read.
  it("keeps only the first entry for a repeated blueprint", () => {
    let config = parseAdminConfig(JSON.stringify({
      formats: [
        { blueprintId: "dup", enabled: true, agentHint: "first" },
        { blueprintId: "other", enabled: true },
        { blueprintId: "dup", enabled: false, agentHint: "second" },
      ],
    }));

    expect(config.formats).toEqual([
      { blueprintId: "dup", enabled: true, agentHint: "first" },
      { blueprintId: "other", enabled: true },
    ]);
  });
});

describe("reorderFormats", () => {
  let promoted = [
    { blueprintId: "a", enabled: true },
    { blueprintId: "b", enabled: true },
    { blueprintId: "c", enabled: true },
  ];

  it("rearranges into the order given", () => {
    expect(reorderFormats(promoted, ["c", "a", "b"]).map(f => f.blueprintId))
        .toEqual(["c", "a", "b"]);
  });

  // A repeated id passes both a length and a membership test, so without an explicit uniqueness
  // check it would drop "b" and leave a duplicate that makes every later reorder throw.
  it("refuses a repeated id", () => {
    expect(() => reorderFormats(promoted, ["a", "a", "c"])).toThrow(/exactly once/);
  });

  it("refuses a short list, a long list, and an unknown id", () => {
    expect(() => reorderFormats(promoted, ["a", "b"])).toThrow(/exactly once/);
    expect(() => reorderFormats(promoted, ["a", "b", "c", "a"])).toThrow(/exactly once/);
    expect(() => reorderFormats(promoted, ["a", "b", "z"])).toThrow(/exactly once/);
  });
});

describe("format presentation", () => {
  let declared = { id: "presentation", noun: "Slides", plural: "Slides", icon: "presentation" } as const;

  it("applies overrides over the blueprint's own declaration", () => {
    expect(resolveFormatOutput(declared, { noun: "Briefing", plural: "Briefings" }))
        .toEqual({ ...declared, noun: "Briefing", plural: "Briefings" });
  });

  it("has no format to offer when neither side supplies a complete one", () => {
    expect(resolveFormatOutput(undefined, { noun: "Briefing" })).toBeUndefined();
    expect(resolveFormatOutput(undefined, undefined)).toBeUndefined();
  });

  it("keeps only well-formed override fields", () => {
    expect(sanitizeOutputOverrides({ noun: "  Deck  ", icon: "notAnIcon", plural: "" }))
        .toEqual({ noun: "Deck" });
    expect(sanitizeOutputOverrides({ icon: "notAnIcon" })).toBeUndefined();
    expect(sanitizeOutputOverrides({ noun: "x".repeat(41) })).toBeUndefined();
  });

  it("derives a stable, valid grouping id without asking the admin for one", () => {
    expect(defaultOutputFormatId("acme.contract-memo")).toBe("acme.contract-memo");
    let long = "acme." + "contract-".repeat(8);
    expect(defaultOutputFormatId(long)).toBe(defaultOutputFormatId(long));
    expect(defaultOutputFormatId(long)).toHaveLength(40);
    expect(defaultOutputFormatId(long)).not.toBe(defaultOutputFormatId(long + "other"));
  });
});

describe("admin config site logo", () => {
  it("defaults legacy and malformed values to no custom logo", () => {
    expect(parseAdminConfig("{}").siteLogoConfigured).toBe(false);
    expect(parseAdminConfig('{"siteLogoConfigured":"yes"}').siteLogoConfigured).toBe(false);
  });

  it("round-trips configured logo state", () => {
    let config = parseAdminConfig('{"siteLogoConfigured":true}');
    expect(config.siteLogoConfigured).toBe(true);
    expect(parseAdminConfig(serializeAdminConfig(config))).toEqual(config);
  });
});

const MAIL = { urlPattern: "https://graph.microsoft.com/#segment=mail", title: "Mail", description: "" };
const CALENDAR = { urlPattern: "https://graph.microsoft.com/#segment=calendar", title: "Calendar", description: "" };

describe("resource allow-list", () => {
  it("treats every resource as off until an admin turns it on", () => {
    let config = parseAdminConfig(null);
    expect(config.enabledResources).toEqual({});
    expect(filterEnabledResources(config, "msgraph", [MAIL, CALENDAR])).toEqual([]);
    expect(isResourceDisabled(config, "msgraph", MAIL.urlPattern)).toBe(true);
  });

  it("keeps only the resources the admin enabled, per vendor", () => {
    let config = parseAdminConfig(JSON.stringify({ enabledResources: { msgraph: [MAIL.urlPattern] } }));
    expect(filterEnabledResources(config, "msgraph", [MAIL, CALENDAR])).toEqual([MAIL]);
    expect(filterEnabledResources(config, "linear", [MAIL])).toEqual([]);
    expect(isResourceDisabled(config, "msgraph", MAIL.urlPattern)).toBe(false);
    expect(isResourceDisabled(config, "msgraph", CALENDAR.urlPattern)).toBe(true);
  });

  it("matches the vendor id case-insensitively, the way setResourceEnabled stores it", () => {
    let config = parseAdminConfig(JSON.stringify({ enabledResources: { msgraph: [MAIL.urlPattern] } }));
    expect(filterEnabledResources(config, "MsGraph", [MAIL, CALENDAR])).toEqual([MAIL]);
    expect(isResourceDisabled(config, "MSGRAPH", MAIL.urlPattern)).toBe(false);
  });

  it("lowercases a stored key at parse time, so a hand-edited mixed-case key still matches", () => {
    let config = parseAdminConfig(JSON.stringify({ enabledResources: { MsGraph: [MAIL.urlPattern] } }));
    expect(config.enabledResources).toEqual({ msgraph: [MAIL.urlPattern] });
    expect(filterEnabledResources(config, "msgraph", [MAIL, CALENDAR])).toEqual([MAIL]);
  });

  it("lets an ambient (auto-provisioning) vendor through untouched, since it has no toggles", () => {
    let config = parseAdminConfig(null);
    expect(filterEnabledResources(config, "context", [MAIL, CALENDAR], true)).toEqual([MAIL, CALENDAR]);
    expect(isResourceDisabled(config, "context", MAIL.urlPattern, true)).toBe(false);
  });

  it("ignores the retired deny-list rather than turning anything on", () => {
    let config = parseAdminConfig(JSON.stringify({ disabledResources: { msgraph: [CALENDAR.urlPattern] } }));
    expect(filterEnabledResources(config, "msgraph", [MAIL, CALENDAR])).toEqual([]);
    expect("disabledResources" in config).toBe(false);
  });

  it("round-trips the allow-list through serialize/parse", () => {
    let config = { ...DEFAULT_ADMIN_CONFIG, enabledResources: { msgraph: [MAIL.urlPattern] } };
    expect(parseAdminConfig(serializeAdminConfig(config)).enabledResources).toEqual({ msgraph: [MAIL.urlPattern] });
  });

  it("keeps special vendor keys as ordinary own entries", () => {
    let config = parseAdminConfig('{"enabledResources":{"__proto__":["https://graph.microsoft.com/#segment=mail"],"constructor":["constructor"],"toString":["toString"]}}');
    expect(Object.hasOwn(config.enabledResources, "__proto__")).toBe(true);
    expect(enabledResourcePatterns(config, "__proto__")).toEqual([MAIL.urlPattern]);
    expect(isResourceDisabled(config, "__proto__", MAIL.urlPattern)).toBe(false);
    expect(enabledResourcePatterns(config, "constructor")).toEqual(["constructor"]);
    expect(enabledResourcePatterns(config, "toString")).toEqual(["toString"]);
    expect(enabledResourcePatterns(parseAdminConfig(null), "constructor")).toEqual([]);
    expect(enabledResourcePatterns(parseAdminConfig(null), "toString")).toEqual([]);
  });
});
