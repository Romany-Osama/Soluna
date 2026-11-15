import { readFileSync } from "node:fs";
import { registeredCommands, readRustSource } from "./ui-invariants.mjs";

const VALIDATED_TYPES = new Set([
  "Text",
  "Name",
  "LongText",
  "Keyword",
  "Token",
  "VideoId",
  "YtId",
  "LibraryId",
  "SpotifyId",
  "SpotifyUri",
]);
const STRUCTURED_TYPES = new Set(["YtItem", "DetailPage", "Option<YtItem>", "Option<VideoId>"]);

function splitTopLevel(value) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if ("<([{".includes(value[index])) depth += 1;
    if (">)]}".includes(value[index])) depth -= 1;
    if (value[index] === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (value.slice(start).trim()) parts.push(value.slice(start).trim());
  return parts;
}

function matchingParen(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    if (source[index] === ")" && --depth === 0) return index;
  }
  throw new Error(`unclosed argument list at ${open}`);
}

function commandSource() {
  const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
  const registered = registeredCommands(lib);
  const source = readRustSource();
  const commands = new Map();
  for (const match of source.matchAll(/#\[tauri::command\][\s\S]*?\bfn\s+(\w+)\s*\(/g)) {
    const name = match[1];
    if (!registered.includes(name)) continue;
    const open = match.index + match[0].lastIndexOf("(");
    const close = matchingParen(source, open);
    const signatureEnd = source.slice(close + 1).search(/\{/);
    if (signatureEnd < 0) continue;
    const bodyStart = close + 1 + signatureEnd + 1;
    const next = source.slice(bodyStart).search(/\n#\[tauri::command\]/);
    const body = source.slice(bodyStart, next < 0 ? source.length : bodyStart + next);
    const args = splitTopLevel(source.slice(open + 1, close))
      .map((argument) => {
        const separator = argument.indexOf(":");
        if (separator < 0) return null;
        const name = argument.slice(0, separator).trim();
        const type = argument.slice(separator + 1).trim();
        if (/^(tauri::State|tauri::AppHandle|AppHandle)/.test(type)) return null;
        return { name, type };
      })
      .filter(Boolean);
    const returnType = source.slice(close + 1, bodyStart - 1).trim();
    commands.set(name, { args, body, returnType });
  }
  return { registered, commands };
}

function isValidatedType(type) {
  const inner = type.match(/^(?:Opt|Option)<(.+)>$/)?.[1] ?? type;
  if (VALIDATED_TYPES.has(inner) || STRUCTURED_TYPES.has(inner)) return true;
  if (/^Vec<(.+)>$/.test(inner)) return isValidatedType(inner.match(/^Vec<(.+)>$/)[1]);
  return ["bool", "i32", "i64", "usize"].includes(inner);
}

export function ipcContractState() {
  const { registered, commands } = commandSource();
  const problems = [];
  const contracts = registered.map((name) => {
    const command = commands.get(name);
    if (!command) {
      problems.push(`${name} has no command source`);
      return null;
    }
    if (!command.returnType.includes("IpcResult<")) problems.push(`${name} does not return IpcResult`);
    const invalid = command.args.filter(({ type }) => !isValidatedType(type));
    if (invalid.length)
      problems.push(
        `${name} has uncontracted argument types: ${invalid.map(({ name, type }) => `${name}: ${type}`).join(", ")}`,
      );
    const requiresSpotify = command.body.includes("spotify_token(&state)");
    const requiresGoogle =
      command.body.includes("auth_session(&state)?") &&
      (command.body.includes("Some(&session)") || command.body.includes("session.ok_or"));
    return {
      name,
      args: command.args,
      malformedArgumentCoverage: invalid.length === 0,
      oversizedArgumentCoverage: invalid.length === 0,
      happyPathShape: command.returnType.includes("IpcResult<"),
      unauthenticatedPath: requiresSpotify || requiresGoogle,
      auth: requiresSpotify ? "spotify" : requiresGoogle ? "google" : "none",
    };
  });
  return { contracts: contracts.filter(Boolean), problems };
}
