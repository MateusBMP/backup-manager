import { render } from "ink";
import type { Services } from "../core/services.js";
import { App } from "./App.js";

/** Full-screen UI on the alternate screen; the terminal is restored on exit and Ctrl-C. */
export async function runUi(services: Services): Promise<number> {
  const app = render(<App services={services} />, {
    alternateScreen: true,
    maxFps: 30,
    exitOnCtrlC: true,
  });
  await app.waitUntilExit();
  return 0;
}
