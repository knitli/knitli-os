import { describe, expect, it } from "vitest";

import { discardInterruptedGatekeeperInitializations } from
  "../src/gatekeeper-initialization-recovery.js";

describe("discardInterruptedGatekeeperInitializations", () => {
  it("removes only interrupted provisional records and their named facets", () => {
    let records = new Map([
      [1, { id: 1 }],
      [2, { id: 2, initializing: true as const }],
      [3, { id: 3, initializing: true as const }],
    ]);
    let deletedFacets: string[] = [];

    discardInterruptedGatekeeperInitializations(
      {
        gatekeepers: {
          list: () => records.values(),
          delete: (id) => {
            records.delete(id);
          },
        },
      },
      {
        delete: (name) => {
          deletedFacets.push(name);
        },
      },
    );

    expect(deletedFacets).toEqual(["gatekeeper2", "gatekeeper3"]);
    expect([...records.keys()]).toEqual([1]);
  });
});
