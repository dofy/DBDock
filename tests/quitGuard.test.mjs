import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
after(() => vite.close());
const { quitDecision } = await vite.ssrLoadModule("/src/quitGuard.ts");

test("quit protects open sessions, pending connections and editors", () => {
  assert.equal(quitDecision(0, 0, false, false), "exit");
  assert.equal(quitDecision(1, 0, false, false), "confirm");
  assert.equal(quitDecision(0, 1, false, false), "confirm");
  assert.equal(quitDecision(0, 0, true, false), "confirm");
  assert.equal(quitDecision(1, 0, true, true), "blocked");
});
