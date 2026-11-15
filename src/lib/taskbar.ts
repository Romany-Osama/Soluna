import { invoke } from "@tauri-apps/api/core";

export function taskbarInvoke(
  command: "plugin:taskbar|initialize" | "plugin:taskbar|set_playback_state" | "plugin:taskbar|set_navigation_enabled",
  args?: Record<string, unknown>,
) {
  return invoke(command, args);
}
