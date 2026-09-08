import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { resolveEvaluationEndpoint, waitForChatApi } from "./evaluate-chat.js";

const { values } = parseArgs({ options: {
  "public-url": { type: "string" },
  "validate-only": { type: "boolean", default: false },
} });

try {
  // Read PORT from the same file/parser as PM2, not an inherited shell override.
  const require = createRequire(import.meta.url);
  const { apps } = require("../pm2/ecosystem.config.js");
  const app = apps.find((entry) => entry.name === "rec-expo-chatbot");
  if (!app?.env?.PORT) throw new Error("PM2 must define rec-expo-chatbot with PORT from .env.local");
  const endpoints = [resolveEvaluationEndpoint(undefined, { PORT: app.env.PORT })];
  if (values["public-url"]) endpoints.push(resolveEvaluationEndpoint(values["public-url"]));
  if (values["validate-only"]) {
    console.log("Deployment endpoint configuration is valid.");
  } else {
    for (const endpoint of new Set(endpoints)) {
      const result = await waitForChatApi(endpoint);
      console.log(`Chat API ready: ${endpoint} (${result.durationMs}ms, ${result.attempts} probes)`);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
