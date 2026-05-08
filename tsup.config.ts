import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "esnext",
  dts: true,
  sourcemap: true,
  bundle: true,
  clean: true,
  outDir: "dist",
});
