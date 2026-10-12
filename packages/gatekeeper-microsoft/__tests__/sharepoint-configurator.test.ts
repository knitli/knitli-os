import { describe, expect, it } from "vitest";

import spec from "../src/configurator/sharepoint-list-configurator-ui";

describe("SharePoint list configurator", () => {
  it("prefills the form from a concrete list URL, since the wildcard host seeds nothing", () => {
    const url = "https://contoso.sharepoint.com/sites/HR/Lists/Requests/AllItems.aspx";

    const values = spec.initialValuesFromResourceUrl({ resourceUrl: url } as never);

    expect(values).toEqual({ url });
    expect(spec.resourceUrl({ values } as never)).toBe(url);
    expect(spec.isReady({ values } as never)).toBe(true);
  });

  it("starts empty when no URL is supplied", () => {
    expect(spec.initialValuesFromResourceUrl({ resourceUrl: "" } as never)).toEqual({});
  });
});
