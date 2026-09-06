import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const packageRequire = createRequire(resolve(root, "packages/workshop-backend/package.json"));
const validatorRequire = createRequire(packageRequire.resolve("capnweb-validate/esbuild"));
const { build } = validatorRequire("esbuild");
const cjsEntrypoint = packageRequire.resolve("capnweb-validate/esbuild");
const esmEntrypoint = cjsEntrypoint.replace(/\.cjs$/, ".mjs");
assert.notEqual(esmEntrypoint, cjsEntrypoint);
const { default: esmPlugin } = await import(esmEntrypoint);
const cjsPlugin = packageRequire("capnweb-validate/esbuild");

for (const [entrypoint, capnwebValidate] of [
  ["esm", esmPlugin],
  ["cjs", cjsPlugin],
] as const) {
  test(`${entrypoint}: native returned capabilities preserve transport while capnweb retains nested validation`, async () => {
    const dir = await realpath(await mkdtemp(resolve(tmpdir(), "capnweb-native-validation-")));
    try {
      await symlink(
        resolve(root, "packages/workshop-backend/node_modules"),
        resolve(dir, "node_modules"),
      );
      await writeFile(
        resolve(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            skipLibCheck: true,
            types: [],
          },
          include: [
            "fixture.ts",
            resolve(root, "packages/workshop-backend/worker-configuration.d.ts"),
          ],
        }),
      );
      await writeFile(
        resolve(dir, "fixture.ts"),
        `
import { RpcTarget as NativeTarget, RpcStub as NativeStub } from "cloudflare:workers";
import { RpcTarget as CapnwebTarget, RpcStub as CapnwebStub } from "capnweb";
import { validateRpc } from "capnweb-validate";
interface NativeContract extends NativeTarget { check(value: string): void; }
interface CapnwebContract extends CapnwebTarget { check(value: string): void; }
@validateRpc()
export class NativeEndpoint extends NativeTarget implements NativeContract {
  check(value: string): void {}
  native(): NativeStub<NativeContract> { throw new Error("fixture"); }
  capnweb(): CapnwebStub<CapnwebContract> { throw new Error("fixture"); }
}
`,
      );
      const result = await build({
        absWorkingDir: dir,
        entryPoints: ["fixture.ts"],
        bundle: false,
        write: false,
        format: "esm",
        platform: "neutral",
        plugins: [capnwebValidate({ cwd: dir, tsconfig: "tsconfig.json" })],
      });
      const code = result.outputFiles[0].text;
      assert.match(code, /"native": \{ args: \[\], returns: __cw\.v\.stub \}/);
      assert.match(code, /"capnweb": \{ args: \[\], returns: __cw\.v\.stubOf\(/);
      assert.match(code, /check[\s\S]*?args: [^\n]*\.string/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${entrypoint}: zero-argument dispatch authority is decorated`, async () => {
    const cwd = await realpath(resolve(root, "packages/workshop-backend"));
    const result = await build({
      absWorkingDir: cwd,
      entryPoints: ["src/fork/openapi-dispatch-binding.ts"],
      bundle: false,
      write: false,
      format: "esm",
      platform: "neutral",
      plugins: [capnwebValidate({ cwd, tsconfig: "tsconfig.json" })],
    });
    const code = result.outputFiles[0].text;
    assert.match(
      code,
      /@__cw\.__validateRpcClass\([^)]*\)\s*class OpenApiHostDispatchUseAuthority/,
    );
    assert.match(code, /"assertActive": \{ args: \[\], returns:/);
  });
}
