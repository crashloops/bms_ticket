import { defineConfig } from "checkly";
import { Frequency } from "checkly/constructs";

export default defineConfig({
  projectName: "bms-ticket-monitor",
  logicalId: "bms-ticket-monitor",
  repoUrl: "https://github.com/crashloops/bms_ticket",
  checks: {
    activated: true,
    muted: false,
    runtimeId: "2024.09",
    frequency: Frequency.EVERY_1H,
    locations: ["ap-southeast-1"],
    tags: ["bms", "bookmyshow", "tickets"]
  },
  cli: {
    runLocation: "ap-southeast-1"
  }
});
