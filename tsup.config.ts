import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  // better-sqlite3 loads a compiled addon, so it must stay a real require at runtime
  // rather than being pulled into the bundle.
  external: ["better-sqlite3"],
});
