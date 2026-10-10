import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/fork/*.test.ts"],
    environment: "node",
  },
});
