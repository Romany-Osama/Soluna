import { execFileSync } from "node:child_process";
import test from "node:test";

test("IPC bindings are generated from the registered Rust command surface", () => {
  execFileSync(process.execPath, ["scripts/ipc-bindings.mjs", "--check"], { stdio: "pipe" });
});
