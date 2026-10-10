import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, bindings, defineGadgetsWorker,
  type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-email",
  entrypoint: ".wrangler/validate/src/email.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
  observability: OBSERVABILITY,
  env: {
    // Outbound mail for EmailSession.send(), always from the bound mailbox's address.
    SEND_EMAIL: bindings.sendEmail(),
  },
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UserAccount", "EmailGatekeeperImpl", "EmailAddress"] },
];
