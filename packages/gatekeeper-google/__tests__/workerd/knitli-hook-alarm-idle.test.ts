// A hook driver with no hooks left must return to empty storage after its last alarm: the alarm
// guard's counter is deleted once a run leaves no alarm armed (see docs/alarm-audit.md).

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {expect, it} from "vitest";

const testEnv = env as unknown as {
  ChatHookDriver: DurableObjectNamespace;
  GmailHookDriver: DurableObjectNamespace;
};

for (const name of ["ChatHookDriver", "GmailHookDriver"] as const) {
  it(`${name} leaves no guard counter behind once it is idle`, async () => {
    const namespace = testEnv[name];
    const driver = namespace.get(namespace.idFromName(`idle-${crypto.randomUUID()}`));
    const keys = await runInDurableObject(driver, async (instance: {alarm(): Promise<void>}, state) => {
      await instance.alarm();
      return {
        keys: [...state.storage.kv.list()].map(([key]) => key),
        alarm: await state.storage.getAlarm(),
      };
    });
    expect(keys).toEqual({keys: [], alarm: null});
  });
}
