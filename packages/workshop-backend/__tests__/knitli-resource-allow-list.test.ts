// Fork: gatekeeper resources are opt-in (`enabledResources` legacy patterns plus
// `enabledResourceTypeIds`; unlisted is off), where upstream's are opt-out. See "Gatekeeper
// resources are opt-in" in docs/fork-maintenance.md.
import { describe, expect, it } from "vitest";
import { enabledResourcePatterns, filterEnabledResources, isResourceDisabled, normalizeAdminConfig, parseAdminConfig, serializeAdminConfig } from "../src/admin-config.js";
import { DEFAULT_ADMIN_CONFIG } from "../src/storage-schema/admin-settings-storage.js";

const MAIL = { urlPattern: "https://graph.microsoft.com/#segment=mail", title: "Mail", description: "" };
const CALENDAR = { urlPattern: "https://graph.microsoft.com/#segment=calendar", title: "Calendar", description: "" };
const CUSTOM = { urlPattern: "https://graph.microsoft.com/#tool=*", title: "Custom selection", description: "" };

describe("resource allow-list", () => {
  it("treats every resource as off until an admin turns it on", () => {
    let config = parseAdminConfig(null);
    expect(config.enabledResources).toEqual({});
    expect(filterEnabledResources(config, "msgraph", [MAIL, CALENDAR])).toEqual([]);
    expect(isResourceDisabled(config, "msgraph", MAIL, [MAIL])).toBe(true);
  });

  it("keeps only the resources the admin enabled, per vendor", () => {
    let config = parseAdminConfig(JSON.stringify({ enabledResources: { msgraph: [MAIL.urlPattern] } }));
    expect(filterEnabledResources(config, "msgraph", [MAIL, CALENDAR])).toEqual([MAIL]);
    expect(filterEnabledResources(config, "linear", [MAIL])).toEqual([]);
    expect(isResourceDisabled(config, "msgraph", MAIL, [MAIL])).toBe(false);
    expect(isResourceDisabled(config, "msgraph", CALENDAR, [CALENDAR])).toBe(true);
    expect(isResourceDisabled(config, "MsGraph", CUSTOM, [CUSTOM])).toBe(true);
  });

  it("matches the vendor id case-insensitively, the way setResourceEnabled stores it", () => {
    let config = parseAdminConfig(JSON.stringify({ enabledResources: { msgraph: [MAIL.urlPattern] } }));
    expect(filterEnabledResources(config, "MsGraph", [MAIL, CALENDAR])).toEqual([MAIL]);
    expect(isResourceDisabled(config, "MSGRAPH", MAIL, [MAIL])).toBe(false);
  });

  it("lowercases a stored key at parse time, so a hand-edited mixed-case key still matches", () => {
    let config = parseAdminConfig(JSON.stringify({ enabledResources: { MsGraph: [MAIL.urlPattern] } }));
    expect(config.enabledResources).toEqual({ msgraph: [MAIL.urlPattern] });
    expect(filterEnabledResources(config, "msgraph", [MAIL, CALENDAR])).toEqual([MAIL]);
  });

  it("lets an ambient (auto-provisioning) vendor through untouched, since it has no toggles", () => {
    let config = parseAdminConfig(null);
    expect(filterEnabledResources(config, "context", [MAIL, CALENDAR], undefined, true)).toEqual([MAIL, CALENDAR]);
    expect(isResourceDisabled(config, "context", MAIL, [MAIL], true)).toBe(false);
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
    expect(isResourceDisabled(config, "__proto__", MAIL, [MAIL])).toBe(false);
    expect(enabledResourcePatterns(config, "constructor")).toEqual(["constructor"]);
    expect(enabledResourcePatterns(config, "toString")).toEqual(["toString"]);
    expect(enabledResourcePatterns(parseAdminConfig(null), "constructor")).toEqual([]);
    expect(enabledResourcePatterns(parseAdminConfig(null), "toString")).toEqual([]);
  });
});

describe("resource allow-list by stable type ID", () => {
  const repository = { id: "repository", urlPattern: "https://git.example/:owner/:repo", title: "Repository", description: "" };
  const renamed = { ...repository, urlPattern: "https://git.example/repos/:owner/:repo" };
  const issue = { id: "issue", urlPattern: "https://git.example/:owner/:repo/issues/:issue", title: "Issue", description: "" };

  it("keeps an enabled ID enabled after its URL pattern changes", () => {
    const config = normalizeAdminConfig({ enabledResourceTypeIds: { git: ["repository"] } });
    expect(filterEnabledResources(config, "git", [renamed, issue])).toEqual([renamed]);
    expect(filterEnabledResources(config, "other-vendor", [renamed])).toEqual([]);
  });

  it("honors an exact legacy pattern grant, and an unmatched one enables nothing", () => {
    const config = normalizeAdminConfig({ enabledResources: { git: [repository.urlPattern] } });
    expect(filterEnabledResources(config, "git", [repository, issue])).toEqual([repository]);
    // Unlike upstream's opt-out restrictions, an unidentifiable entry fails closed without
    // blocking the rest of the vendor.
    expect(filterEnabledResources(config, "git", [renamed, issue])).toEqual([]);
  });

  it("lowercases the ID map's vendor keys on the KV-mirror read", () => {
    const config = parseAdminConfig(JSON.stringify({ enabledResourceTypeIds: { Git: ["issue"] } }));
    expect(config.enabledResourceTypeIds).toEqual({ git: ["issue"] });
    expect(filterEnabledResources(config, "GIT", [repository, issue])).toEqual([issue]);
  });
});
