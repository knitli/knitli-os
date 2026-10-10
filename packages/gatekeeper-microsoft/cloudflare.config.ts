import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-microsoft",
  entrypoint: ".wrangler/validate/src/microsoft.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "OutlookMailGatekeeperImpl"] },
  { tag: "v1", new_sqlite_classes: ["TeamsGatekeeperImpl"] },
];
