import { closeWindow, minimizeWindow, toggleMaximizeWindow } from "../lib/windowControls";

export function WindowControls() {
  // The top bar is a Tauri drag region (-webkit-app-region: drag), so clicks
  // on anything inside it are treated as a drag unless the element itself
  // opts out. The parent .topbar-actions only had data-tauri-drag-region
  // on some ancestors, which is why the buttons highlighted on hover but
  // did nothing on click. Every button opts out explicitly here.
  return (
    <div
      className="window-controls"
      role="group"
      aria-label="Window management"
      data-tauri-drag-region="false"
    >
      <button
        type="button"
        className="window-control-button minimize"
        data-tauri-drag-region="false"
        onClick={() => void minimizeWindow()}
        title="Minimize window"
        aria-label="Minimize window"
      >
        &#x2500;
      </button>
      <button
        type="button"
        className="window-control-button maximize"
        data-tauri-drag-region="false"
        onClick={() => void toggleMaximizeWindow()}
        title="Maximize window"
        aria-label="Maximize window"
      >
        &#x25A1;
      </button>
      <button
        type="button"
        className="window-control-button close"
        data-tauri-drag-region="false"
        onClick={() => void closeWindow()}
        title="Close window"
        aria-label="Close window"
      >
        &#x2715;
      </button>
    </div>
  );
}
