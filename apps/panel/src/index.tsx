import { createRoot } from "react-dom/client";
import type { PanelTransport } from "../../../packages/contracts/src/index.js";
import { Workbench } from "./workbench.js";

export function mountPanel(transport: PanelTransport) {
  const element = document.getElementById("app");
  if (!element) throw new Error("Agora panel container is missing.");
  const root = createRoot(element);
  root.render(<Workbench transport={transport} />);
  return () => root.unmount();
}
