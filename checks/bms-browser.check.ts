import { BrowserCheck, Frequency } from "checkly/constructs";

new BrowserCheck("bms-spiderman-prasads-browser-check", {
  name: "BMS Spider-Man Prasads Browser Monitor",
  activated: true,
  frequency: Frequency.EVERY_10M,
  locations: ["ap-southeast-1"],
  code: {
    entrypoint: "./bms-browser.spec.ts"
  }
});
