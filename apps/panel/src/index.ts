import type { PanelTransport } from "../../../packages/contracts/src/index.js";
import { createPanelController } from "./editor/controller.js";
import { mountEditor } from "./editor/app.js";
export function mountPanel(transport: PanelTransport) {
  const element = document.getElementById("app");
  if (!element) throw new Error("Agora panel container is missing.");
  return mountEditor(element, createPanelController(transport));
}
