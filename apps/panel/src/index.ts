import type { PanelTransport } from "../../../packages/contracts/src/index.js";
import { createInkController } from "./ink/controller.js";
import { mountInk } from "./ink/app.js";
export function mountPanel(transport: PanelTransport) {
  const element = document.getElementById("app");
  if (!element) throw new Error("Agora panel container is missing.");
  return mountInk(element, createInkController(transport));
}
