// Benchmarks only: the test suite runs on node:test (`npm test`), not vitest.
import { defineConfig } from "vitest/config";
import codspeedPlugin from "@codspeed/vitest-plugin";

export default defineConfig({
  plugins: [codspeedPlugin()],
  test: {
    benchmark: {
      include: ["benchmarks/**/*.bench.js"],
    },
  },
});
