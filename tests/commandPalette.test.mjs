import test from "node:test";
import assert from "node:assert/strict";
import { filterCommands } from "../src/commandPalette.ts";

const commands = [
  { id: "new", label: "新建连接", category: "连接", keywords: "create connection", shortcut: "⌘N", run() {} },
  { id: "theme", label: "主题: 深色", category: "设置", keywords: "appearance theme dark", run() {} },
];

test("command search accepts localized text, aliases and multiple terms", () => {
  assert.deepEqual(filterCommands(commands, "  ").map(c => c.id), ["new", "theme"]);
  assert.deepEqual(filterCommands(commands, "连接").map(c => c.id), ["new"]);
  assert.deepEqual(filterCommands(commands, "THEME dark").map(c => c.id), ["theme"]);
  assert.deepEqual(filterCommands(commands, "⌘n").map(c => c.id), ["new"]);
  assert.deepEqual(filterCommands(commands, "missing"), []);
});
