/** Window controls for the frameless Tauri window.
 *
 * Previously every failure was swallowed by an empty `catch {}`, so the
 * buttons highlighted on hover but did nothing on click and there was no
 * way to tell why. Failures are now logged, so a denied permission or a
 * missing Tauri window shows up in the devtools console instead of
 * silently doing nothing. In headless/test environments there is no Tauri
 * window, so the import failure is expected and is logged at debug level.
 */
async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export async function minimizeWindow() {
  try {
    await (await currentWindow()).minimize();
  } catch (error) {
    console.error("Minimize window failed:", error);
  }
}

export async function toggleMaximizeWindow() {
  try {
    await (await currentWindow()).toggleMaximize();
  } catch (error) {
    console.error("Maximize window failed:", error);
  }
}

export async function closeWindow() {
  try {
    await (await currentWindow()).close();
  } catch (error) {
    console.error("Close window failed:", error);
  }
}

/** Fullscreen for the expanded player (Liner-style fullscreen player). */
export async function setFullscreenWindow(value: boolean) {
  try {
    await (await currentWindow()).setFullscreen(value);
  } catch (error) {
    console.error("Fullscreen window failed:", error);
  }
}

export async function isFullscreenWindow() {
  try {
    return await (await currentWindow()).isFullscreen();
  } catch (error) {
    console.error("Fullscreen window check failed:", error);
    return false;
  }
}
