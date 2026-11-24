import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer } from "vite";

// Run on macOS with node --test tests/webkit/webkit.test.mjs.
async function runFixture(filename) {
  const scratch = await mkdtemp(join(tmpdir(), "dbdock-webkit-"));
  const server = await createServer({ logLevel: "silent", server: { host: "127.0.0.1", port: 0, hmr: false, ws: false } });
  try {
    const runner = join(scratch, "WebKitTest.swift");
    await writeFile(runner, `
import AppKit
import WebKit

final class ResultReceiver: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        print(message.body)
        exit(0)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let configuration = WKWebViewConfiguration()
configuration.userContentController.add(ResultReceiver(), name: "result")
let frame = NSRect(x: 0, y: 0, width: 800, height: 500)
let window = NSWindow(contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
let webView = WKWebView(frame: frame, configuration: configuration)
window.contentView = webView
window.orderBack(nil)
webView.load(URLRequest(url: URL(string: CommandLine.arguments[1])!))
DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
    fputs("Timed out waiting for the WebKit fixture", stderr)
    exit(1)
}
app.run()
`);
    await server.listen();
    const { port } = server.httpServer.address();
    const { stdout } = await promisify(execFile)("/usr/bin/swift", [
      runner, `http://127.0.0.1:${port}/tests/webkit/${filename}`,
    ], { timeout: 30_000 });
    assert.equal(stdout.trim(), "ok");
  } finally {
    await server.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

const macOSOnly = { skip: process.platform !== "darwin" };

test("WebKit run options support mouse and keyboard ANALYZE confirmation", macOSOnly, () => runFixture("queryRunOptions.html"));

test("WebKit command palette lets the input method commit text before running a command", macOSOnly, () => runFixture("commandPalette.html"));

test("WebKit reconnect ignores a late result from the cancelled connection", macOSOnly, () => runFixture("workspaceLifecycle.html?case=reconnect"));

test("WebKit closing a table tab cancels only its own reads", macOSOnly, () => runFixture("workspaceLifecycle.html?case=close-table"));

test("WebKit switching workspace tabs preserves SQL drafts, results and pending edits", macOSOnly, () => runFixture("workspaceLifecycle.html?case=switch-tabs"));

test("WebKit a failed imported connection does not reopen the import dialog", macOSOnly, () => runFixture("workspaceLifecycle.html?case=no-import-replay"));

test("WebKit a single URL fills a new connection and saves only on confirmation", macOSOnly, () => runFixture("workspaceLifecycle.html?case=new-url"));

test("WebKit routes native menu events and shortcuts and cleans up listeners", macOSOnly, () => runFixture("workspaceLifecycle.html?case=menu-shortcuts"));

test("WebKit restores palette focus on dismissal and executes commands after closing", macOSOnly, () => runFixture("workspaceLifecycle.html?case=palettes-focus"));

test("WebKit refreshes connections and groups and clears health after saving", macOSOnly, () => runFixture("workspaceLifecycle.html?case=save-reload"));

test("WebKit confirms quitting with open work and blocks it during commits", macOSOnly, () => runFixture("workspaceLifecycle.html?case=quit-guard"));

test("WebKit can disable automatic checks and still manually check, install and restart", macOSOnly, () => runFixture("workspaceLifecycle.html?case=app-update"));
