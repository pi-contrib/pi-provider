import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOpenCodeGoProvider } from "./providers/opencode-go.ts";

export default function (pi: ExtensionAPI): void {
  pi.registerProvider(createOpenCodeGoProvider());
}
