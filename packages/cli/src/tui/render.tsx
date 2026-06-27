import { render } from "ink";
import { App } from "./app";
import type { Store } from "./store";

// Mounts the Ink tree. The watch command builds the Store and wires Collector + WsClient into it;
// this module only turns that Store into a live terminal UI.

export interface TuiHandle {
  waitUntilExit: () => Promise<void>;
  unmount: () => void;
}

export function mountTui(store: Store, noColor: boolean, onQuit: () => void): TuiHandle {
  const instance = render(<App store={store} noColor={noColor} onQuit={onQuit} />);
  return {
    waitUntilExit: () => instance.waitUntilExit(),
    unmount: () => instance.unmount(),
  };
}
