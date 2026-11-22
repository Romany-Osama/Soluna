import { closeWindow, minimizeWindow, toggleMaximizeWindow } from "../lib/windowControls";

export function WindowControls() {
  return (
    <div className="window-controls" role="group" aria-label="Window management">
      <button
        type="button"
        className="window-control-button minimize"
        onClick={() => void minimizeWindow()}
        title="Minimize window"
        aria-label="Minimize window"
      >
        &#x2500;
      </button>
      <button
        type="button"
        className="window-control-button maximize"
        onClick={() => void toggleMaximizeWindow()}
        title="Maximize window"
        aria-label="Maximize window"
      >
        &#x25A1;
      </button>
      <button
        type="button"
        className="window-control-button close"
        onClick={() => void closeWindow()}
        title="Close window"
        aria-label="Close window"
      >
        &#x2715;
      </button>
    </div>
  );
}
