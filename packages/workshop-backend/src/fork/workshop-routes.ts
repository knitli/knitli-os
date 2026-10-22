// Fork-owned (Tier 1). The routes server.ts serves, as data.
//
// Why it exists: knitli-site's WAF route check compares the Worker's routes with the schema it
// declares in waf/os-workshop.openapi.yaml. It used to regex-scan server.ts for them. It now reads
// workshop-routes.json, which __tests__/knitli-workshop-routes.test.ts snapshots from this table.
//
// server.ts is upstream's and keeps its own `url.pathname` tests; nothing here is imported by it.
// __tests__/knitli-workshop-routes.test.ts keeps the table true: every row is answered by its
// handler, and every route literal server.ts dispatches on has a row. `method` is what the route
// accepts. `/api` also takes a WebSocket upgrade, which a method cannot express.
import { BLUEPRINT_SCREENSHOT_PATH_PREFIX, ROUTER_TAG_PROBE_PATH } from "@gadgets/workshop-shared/api";
import { SITE_LOGO_PATH } from "../site-logo.js";

/** One served route. `name` is unique. */
export type WorkshopRoute = Readonly<{ name: string; method: string; path: string }>;

/** Every route the Workshop Worker serves itself. */
export const WORKSHOP_ROUTES = [
  { name: "routerTagProbe", method: "POST", path: ROUTER_TAG_PROBE_PATH },
  { name: "siteLogo", method: "GET", path: SITE_LOGO_PATH },
  { name: "blueprintScreenshot", method: "GET", path: `${BLUEPRINT_SCREENSHOT_PATH_PREFIX}:blueprintId` },
  { name: "clientErrors", method: "POST", path: "/api/client-errors" },
  { name: "mcp", method: "POST", path: "/api/mcp/:gadgetId/:gatekeeperId" },
  { name: "voice", method: "GET", path: "/api/voice/:sessionId" },
  { name: "deviceSessionCallback", method: "POST", path: "/api/device-session/callback" },
  { name: "rpc", method: "POST", path: "/api" },
] as const satisfies readonly WorkshopRoute[];
