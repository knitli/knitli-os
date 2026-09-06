// Test-only transport probe. All application requests and named Worker exports remain real.
import original from "../../../workshop-backend/.wrangler/validate/src/server.js";
export * from "../../../workshop-backend/.wrangler/validate/src/server.js";

export default {
  ...original,
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__test/reload-generation") {
      return Response.json({ generation: env.OPENAPI_ACCEPTANCE_RELOAD ?? null }, { headers: { "Cache-Control": "no-store" } });
    }
    return original.fetch(request, env, ctx);
  },
};
