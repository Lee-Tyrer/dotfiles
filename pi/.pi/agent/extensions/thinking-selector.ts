/**
 * Adds a Ctrl+Shift+T shortcut for choosing the active model's thinking level.
 */
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ThinkingSelectorComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function thinkingSelector(pi: ExtensionAPI) {
  const openSelector = async (ctx: ExtensionContext) => {
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
  };

  const shortcut = { description: "Open thinking level selector", handler: openSelector };
  pi.registerShortcut("ctrl+shift+t", shortcut);
  pi.registerShortcut("ctrl+t", shortcut);
}
