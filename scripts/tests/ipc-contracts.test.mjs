import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { ipcContractState } from "../lib/ipc-contracts.mjs";

test("every registered IPC command has a complete contract shape", () => {
  const { contracts, problems } = ipcContractState();
  assert.deepEqual(problems, []);
  assert.equal(contracts.length, 105);
  for (const contract of contracts) {
    assert.equal(contract.malformedArgumentCoverage, true, contract.name);
    assert.equal(contract.oversizedArgumentCoverage, true, contract.name);
    assert.equal(contract.happyPathShape, true, contract.name);
  }
});

test("authenticated command contracts identify the account boundary", () => {
  const { contracts } = ipcContractState();
  const spotify = contracts.filter(({ auth }) => auth === "spotify");
  assert.ok(spotify.length > 0);
  assert.ok(contracts.some(({ auth }) => auth === "google"));
  assert.ok(contracts.some(({ auth }) => auth === "none"));
});

test("application code does not bypass the generated IPC entry point", () => {
  const output = execFileSync("rg", ["-l", 'import.*invoke.*from "@tauri-apps/api/core"', "src"], {
    encoding: "utf8",
  });
  assert.deepEqual(output.trim().split("\n").sort(), ["src/ipc/bindings.ts", "src/lib/taskbar.ts"]);
});
