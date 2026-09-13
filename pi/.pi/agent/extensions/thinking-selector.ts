/**
 * Adds a Ctrl+T shortcut for choosing the active model's thinking level.
 */
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ThinkingSelectorComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function thinkingSelector(pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+t", {
    description: "Open thinking level selector",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;

      const model = ctx.model;
      if (!model) {
        ctx.ui.notify("No model is selected", "warning");
        return;
      }

      const levels = getSupportedThinkingLevels(model);
      const selected = await ctx.ui.custom<string | null>((_tui, _theme, _keybindings, done) => {
        return new ThinkingSelectorComponent(
          pi.getThinkingLevel(),
          levels,
          (level) => done(level),
          () => done(null),
        );
      });

      if (selected) {
        pi.setThinkingLevel(selected);
        ctx.ui.notify(`Thinking level: ${selected}`, "info");
      }
    },
  });
}
