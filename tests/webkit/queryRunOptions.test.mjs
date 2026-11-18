import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer } from "vite";

// Run on macOS with node --test tests/webkit/queryRunOptions.test.mjs.
test("WebKit run options support mouse and keyboard ANALYZE confirmation", {
  skip: process.platform !== "darwin",
}, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "dbdock-run-options-"));
  const server = await createServer({ logLevel: "silent", server: { host: "127.0.0.1", port: 0, hmr: false } });
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
      runner, `http://127.0.0.1:${port}/tests/webkit/queryRunOptions.html`,
    ], { timeout: 30_000 });
    assert.equal(stdout.trim(), "ok");
  } finally {
    await server.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
