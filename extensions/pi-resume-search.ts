import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerResumeSearch } from "../src/command";

export default function resumeSearchExtension(pi: ExtensionAPI): void {
  registerResumeSearch(pi);
}
