import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Every test that touches the store or the paymaster uses its own in-memory database
    // or an injected fake, so tests never share state and never reach the network.
    restoreMocks: true,
  },
});
