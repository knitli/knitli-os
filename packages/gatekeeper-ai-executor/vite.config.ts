import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [capnwebValidate()],
  test: {
    environment: "node",
    include: ["__tests__/*.test.ts"],
  },
});
