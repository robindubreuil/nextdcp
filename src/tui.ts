import { Plugin } from "@opencode/plugin/tui"
import { installPicker } from "./picker.ts"
import { installMemoryView } from "./memory-view.ts"

export default Plugin.define({ id: "nextdcp.tui", setup(ctx) {
  const picker = installPicker(ctx), memory = installMemoryView(ctx)
  return () => { memory(); picker() }
} })
