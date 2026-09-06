// Test-only transport probe. All application requests and named Worker exports remain real.
import original from "../gatekeeper-test/.wrangler/validate/src/test-gatekeeper.js";
export * from "../gatekeeper-test/.wrangler/validate/src/test-gatekeeper.js";

export default {
  ...original,
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__test/reload-generation") {
      return Response.json({ generation: env.OPENAPI_ACCEPTANCE_RELOAD ?? null }, { headers: { "Cache-Control": "no-store" } });
    }
    return original.fetch(request, env, ctx);
  },
};
