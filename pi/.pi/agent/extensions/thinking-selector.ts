/**
 * Adds a Ctrl+Shift+T shortcut for choosing the active model's thinking level.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ThinkingSelectorComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Filters levels by name prefix, so "hi" matches "high" but not "xhigh". */
class PrefixThinkingSelector extends ThinkingSelectorComponent {
  applyFilter(query: string) {
    const self = this as any;
    const q = query.trim().toLowerCase();
    const filtered = q
      ? self.allItems.filter((item: { value: string }) => item.value.toLowerCase().startsWith(q))
      : self.allItems;
    const selectedValue = self.selectList.getSelectedItem()?.value;
    const newList = self.buildSelectList(filtered, selectedValue);
    self.children[self.selectListChildIndex] = newList;
    self.selectList = newList;
  }
}

export default function thinkingSelector(pi: ExtensionAPI) {
  const openSelector = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("No model is selected", "warning");
      return;
    }

    const levels = getSupportedThinkingLevels(model);
    const selected = await ctx.ui.custom<ThinkingLevel | null>((_tui, _theme, _keybindings, done) => {
      return new PrefixThinkingSelector(
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
