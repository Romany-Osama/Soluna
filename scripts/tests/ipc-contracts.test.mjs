import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ipcContractState } from "../lib/ipc-contracts.mjs";

test("every registered IPC command has a complete contract shape", () => {
  const { contracts, problems } = ipcContractState();
  assert.deepEqual(problems, []);
  assert.equal(contracts.length, 110);
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
  const matches = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
        if (
          /import\s*\{[^}]*\binvoke\b[^}]*\}\s*from\s*["']@tauri-apps\/api\/core["']/.test(readFileSync(path, "utf8"))
        ) {
          matches.push(path.replaceAll("\\", "/"));
        }
      }
    }
  };
  visit("src");
  assert.deepEqual(matches.sort(), ["src/ipc/bindings.ts", "src/lib/taskbar.ts"]);
});
