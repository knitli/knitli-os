import { describe, expect, it } from "vitest";
import {
  commitStagedCredentials,
  discardStagedCredentials,
  peekStagedCredentials,
  stageCredentials,
  STAGED_CREDENTIALS_KEY,
} from "../src/credential-stage";
import { OAUTH_NONCE_LIFETIME_MS } from "../src/connect-nonce";
import { fakeKv } from "./fake-kv";

type Grant = { accessToken: string; scopes: string[] };
const GRANT: Grant = { accessToken: "new-token", scopes: ["repo"] };
const stageKey = (stageId: string) => `${STAGED_CREDENTIALS_KEY}:${stageId}`;

describe("credential stage", () => {
  it("pins the durable key", () => {
    expect(STAGED_CREDENTIALS_KEY).toBe("stagedCredentials");
  });

  it("commits what was staged exactly once, to the id it handed out", () => {
    const kv = fakeKv();
    const stageId = stageCredentials(kv, GRANT, 1_000);

    expect(stageId).toMatch(/^[0-9a-f]{64}$/);
    expect(kv.keys()).toEqual([stageKey(stageId), "stagedCredentials:index"]);
    expect(commitStagedCredentials<Grant>(kv, 2_000, stageId)).toEqual(GRANT);
    expect(kv.keys()).toEqual(["stagedCredentials:index"]);
    expect(commitStagedCredentials<Grant>(kv, 2_000, stageId)).toBeNull();
  });

  it("lets overlapping stages commit independently, each to its own ticket", () => {
    // Two reconnects overlapped: the owner's and one a phished victim finished. Each ticket
    // still activates only its own stage's credentials — but neither flow invalidates the other.
    const kv = fakeKv();
    const first = stageCredentials(kv, { ...GRANT, accessToken: "first" }, 1_000);
    const second = stageCredentials(kv, { ...GRANT, accessToken: "second" }, 1_200);
    expect(first).not.toBe(second);

    expect(commitStagedCredentials<Grant>(kv, 1_500, "wrong-stage")).toBeNull();
    expect(commitStagedCredentials<Grant>(kv, 1_500, first)).toEqual({
      ...GRANT, accessToken: "first",
    });
    expect(commitStagedCredentials<Grant>(kv, 1_500, second)).toEqual({
      ...GRANT, accessToken: "second",
    });
  });

  it("migrates a record left by the single-stage layout so it still commits", () => {
    const kv = fakeKv();
    kv.put(STAGED_CREDENTIALS_KEY, { creds: GRANT, stageId: "legacy-stage", expiresAt: 5_000 });

    expect(commitStagedCredentials<Grant>(kv, 1_000, "legacy-stage")).toEqual(GRANT);
    expect(kv.keys()).toEqual(["stagedCredentials:index"]);
  });

  it("discards an expired stage rather than committing it, leaving the others", () => {
    const kv = fakeKv();
    const stale = stageCredentials(kv, GRANT, 1_000);
    const fresh = stageCredentials(kv, GRANT, 1_000 + OAUTH_NONCE_LIFETIME_MS - 10);

    expect(commitStagedCredentials<Grant>(kv, 1_000 + OAUTH_NONCE_LIFETIME_MS, stale)).toBeNull();
    expect(commitStagedCredentials<Grant>(kv, 1_000 + OAUTH_NONCE_LIFETIME_MS, fresh)).toEqual(GRANT);
  });

  it("drops an expired stage only by its exact id, for disposal", () => {
    const kv = fakeKv();
    const stageId = stageCredentials(kv, GRANT, 1_000, 100);
    const live = stageCredentials(kv, GRANT, 1_000);

    // A cleanup an earlier flow scheduled must not drop another flow's stage.
    expect(discardStagedCredentials<Grant>(kv, "wrong-stage")).toBeNull();
    expect(kv.keys()).toContain(stageKey(stageId));
    expect(kv.keys()).toContain(stageKey(live));
    // Past its TTL nothing can commit or read it, but its own flow can still dispose of it.
    expect(peekStagedCredentials<Grant>(kv, 1_200)?.stageId).toBe(live);
    expect(discardStagedCredentials<Grant>(kv, stageId)).toEqual(GRANT);
    expect(kv.keys()).toContain(stageKey(live));
    expect(kv.keys()).not.toContain(stageKey(stageId));
  });

  it("honours a caller-chosen lifetime", () => {
    const kv = fakeKv();
    const stageId = stageCredentials(kv, GRANT, 1_200, 500);

    expect(peekStagedCredentials<Grant>(kv, 1_600)?.creds).toEqual(GRANT);
    expect(peekStagedCredentials<Grant>(kv, 1_700)).toBeNull();
    expect(commitStagedCredentials<Grant>(kv, 1_600, stageId)).toEqual(GRANT);
  });

  it("peeks the newest live stage without consuming, failing closed on a bad clock", () => {
    const kv = fakeKv();
    expect(peekStagedCredentials<Grant>(kv, 1_000)).toBeNull();
    const first = stageCredentials(kv, { ...GRANT, accessToken: "first" }, 1_000);
    const second = stageCredentials(kv, { ...GRANT, accessToken: "second" }, 1_100);

    expect(peekStagedCredentials<Grant>(kv, 1_500)).toEqual({
      creds: { ...GRANT, accessToken: "second" }, stageId: second,
    });
    expect(peekStagedCredentials<Grant>(kv, 1_500)?.stageId).toBe(second);
    expect(peekStagedCredentials<Grant>(kv, Number.NaN)).toBeNull();
    // Neither peek consumed anything: both stages still commit.
    expect(commitStagedCredentials<Grant>(kv, 1_500, first)).not.toBeNull();
    expect(commitStagedCredentials<Grant>(kv, 1_500, second)).not.toBeNull();
  });

  it("drops a record no caller could use, whichever reader finds it", () => {
    const kv = fakeKv();
    kv.put(STAGED_CREDENTIALS_KEY, null);

    expect(discardStagedCredentials<Grant>(kv)).toBeNull();
    expect(kv.keys()).toEqual([]);

    kv.put(STAGED_CREDENTIALS_KEY, "garbage");
    expect(peekStagedCredentials<Grant>(kv, 1_000)).toBeNull();
    expect(kv.keys()).toEqual([]);

    kv.put(STAGED_CREDENTIALS_KEY, { stageId: "abc", expiresAt: 5_000 });
    expect(discardStagedCredentials<Grant>(kv)).toBeNull();
    expect(kv.keys()).toEqual([]);

    // A record written before stages carried an id is unusable, not committable by anyone.
    kv.put(STAGED_CREDENTIALS_KEY, { creds: GRANT, expiresAt: 5_000 });
    expect(peekStagedCredentials<Grant>(kv, 1_000)).toBeNull();
    expect(commitStagedCredentials<Grant>(kv, 1_000, "")).toBeNull();
    expect(kv.keys()).toEqual([]);
  });

  it("drops every stage when no id is named, touching nothing else", () => {
    const kv = fakeKv();
    kv.put("tokens", { access_token: "live" });
    stageCredentials(kv, { ...GRANT, accessToken: "first" }, 1_000);
    stageCredentials(kv, { ...GRANT, accessToken: "second" }, 1_100);

    expect(discardStagedCredentials<Grant>(kv)).toEqual({ ...GRANT, accessToken: "second" });
    expect(kv.keys()).toEqual(["stagedCredentials:index", "tokens"]);
    expect(discardStagedCredentials<Grant>(kv)).toBeNull();
  });
});
