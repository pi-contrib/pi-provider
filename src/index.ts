import type {
  ExtensionAPI,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  createOpenCodeGoProvider,
  OPENCODE_GO_CLASSIFIERS_PROVIDER_ID,
} from "./providers/opencode-go.ts";

export default function (pi: ExtensionAPI): void {
  let modelRegistry: ModelRegistry | undefined;

  pi.registerProvider(
    createOpenCodeGoProvider({
      getModelRegistry: () => modelRegistry,
    }),
  );

  pi.on("session_start", (_event, ctx) => {
    modelRegistry = ctx.modelRegistry;
    void ctx.modelRegistry
      .refresh({
        providers: [OPENCODE_GO_CLASSIFIERS_PROVIDER_ID],
        allowNetwork: false,
      })
      .catch(() => {});
  });

  pi.on("session_shutdown", () => {
    modelRegistry = undefined;
  });
}
