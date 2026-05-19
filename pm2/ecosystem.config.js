const fs = require("fs");
const path = require("path");

const appRoot = path.resolve(__dirname, "..");
const envPath = path.join(appRoot, ".env.local");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing environment file: ${filePath}`);
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .reduce((env, line) => {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        return env;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        return env;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      env[key] = value;
      return env;
    }, {});
}

const env = parseEnvFile(envPath);

if (!env.PORT) {
  throw new Error(`PORT must be set in ${envPath}`);
}

module.exports = {
  apps: [
    {
      name: "rec-expo-chatbot",
      script: "node_modules/next/dist/bin/next",
      args: `start -p ${env.PORT}`,
      cwd: appRoot,

      instances: 2,
      exec_mode: "cluster",

      env,

      max_memory_restart: "2G",

      error_file: path.join(appRoot, "logs", "pm2-error.log"),
      out_file: path.join(appRoot, "logs", "pm2-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss",

      watch: false,
      autorestart: true,
      restart_delay: 3000,
    },
  ],
};
