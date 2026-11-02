import { Plugin } from "@opencode/plugin/tui"
import { installPicker } from "./picker.ts"

export default Plugin.define({ id: "nextdcp.tui", setup: installPicker })
