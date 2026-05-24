import net from "node:net";
import tls from "node:tls";

function readBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function readInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function encodeHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function dotStuff(value) {
  return String(value || "")
    .replace(/\r?\n/g, "\r\n")
    .replace(/^\./gm, "..");
}

function sanitizeCommand(command) {
  const text = String(command || "");

  if (/^AUTH\s+/i.test(text)) {
    const method = text.match(/^AUTH\s+(\S+)/i)?.[1] || "";
    return `AUTH ${method} <redacted>`.trim();
  }

  return text;
}

function buildMessage({ to, subject, text }) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || "";

  return [
    `From: ${encodeHeader(from)}`,
    `To: ${encodeHeader(to)}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    dotStuff(text),
  ].join("\r\n");
}

class SmtpConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.waiters = [];

    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this.flush();
    });
    socket.on("error", (error) => {
      while (this.waiters.length) {
        this.waiters.shift().reject(error);
      }
    });
  }

  flush() {
    while (this.waiters.length) {
      const response = this.takeResponse();
      if (!response) return;
      this.waiters.shift().resolve(response);
    }
  }

  takeResponse() {
    const lines = this.buffer.split(/\r?\n/);
    const complete = [];
    let consumed = 0;

    for (const line of lines) {
      if (!line) break;
      complete.push(line);
      consumed += line.length + 2;

      if (/^\d{3}\s/.test(line)) {
        this.buffer = this.buffer.slice(consumed);
        return complete.join("\n");
      }
    }

    return null;
  }

  readResponse() {
    const response = this.takeResponse();
    if (response) return Promise.resolve(response);

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async command(command, expected = /^[23]/, displayCommand = command) {
    this.socket.write(`${command}\r\n`);
    const response = await this.readResponse();

    if (!expected.test(response)) {
      const error = new Error(
        `SMTP command failed: ${sanitizeCommand(displayCommand)} -> ${response}`
      );
      error.smtpResponse = response;
      error.smtpCommand = sanitizeCommand(displayCommand);
      throw error;
    }

    return response;
  }

  end() {
    this.socket.end();
  }
}

async function connectSmtp() {
  const host = process.env.SMTP_HOST;
  const port = readInteger("SMTP_PORT", readBoolean("SMTP_SECURE", false) ? 465 : 587);
  const secure = readBoolean("SMTP_SECURE", port === 465);

  if (!host) {
    throw new Error("SMTP_HOST is not configured.");
  }

  const socket = secure
    ? tls.connect({ host, port, servername: host })
    : net.connect({ host, port });

  await new Promise((resolve, reject) => {
    socket.once(secure ? "secureConnect" : "connect", resolve);
    socket.once("error", reject);
  });

  return { connection: new SmtpConnection(socket), host, secure };
}

async function maybeStartTls(connection, host, secure) {
  if (secure) return connection;

  const requireTls = readBoolean("SMTP_STARTTLS", true);
  if (!requireTls) return connection;

  await connection.command("STARTTLS", /^220/);
  connection.socket.removeAllListeners("data");
  connection.socket.removeAllListeners("error");

  const securedSocket = tls.connect({
    socket: connection.socket,
    servername: host,
  });

  await new Promise((resolve, reject) => {
    securedSocket.once("secureConnect", resolve);
    securedSocket.once("error", reject);
  });

  return new SmtpConnection(securedSocket);
}

async function authenticate(connection) {
  const user = process.env.SMTP_USER || "";
  const password = process.env.SMTP_PASSWORD || "";

  if (!user && !password) return;

  const plain = Buffer.from(`\0${user}\0${password}`).toString("base64");

  try {
    await connection.command(`AUTH PLAIN ${plain}`, /^235/, "AUTH PLAIN");
    return;
  } catch (error) {
    if (!/^5/.test(error.smtpResponse || "")) {
      throw error;
    }
  }

  await connection.command("AUTH LOGIN", /^334/);
  await connection.command(
    Buffer.from(user).toString("base64"),
    /^334/,
    "AUTH LOGIN username"
  );
  await connection.command(
    Buffer.from(password).toString("base64"),
    /^235/,
    "AUTH LOGIN password"
  );
}

export async function sendMail({ to, subject, text }) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  if (!from) {
    throw new Error("SMTP_FROM or SMTP_USER is required.");
  }

  let smtp = await connectSmtp();
  let connection = smtp.connection;

  try {
    await connection.readResponse();
    await connection.command("EHLO rec-chatbot.local");
    connection = await maybeStartTls(connection, smtp.host, smtp.secure);

    if (!smtp.secure && connection !== smtp.connection) {
      await connection.command("EHLO rec-chatbot.local");
    }

    await authenticate(connection);
    await connection.command(`MAIL FROM:<${from}>`);
    await connection.command(`RCPT TO:<${to}>`);
    await connection.command("DATA", /^354/);
    await connection.command(`${buildMessage({ to, subject, text })}\r\n.`, /^250/);
    await connection.command("QUIT", /^221/);
  } finally {
    connection.end();
  }
}

export async function sendAdminLoginCode({ email, code, mode, expiresAt }) {
  const purpose = mode === "setup" ? "set up your admin account" : "sign in";

  await sendMail({
    to: email,
    subject: `REC Bot Admin verification code: ${code}`,
    text: [
      `Use this code to ${purpose}: ${code}`,
      "",
      `It expires at ${expiresAt}.`,
      "",
      "If you did not request this, ignore this email.",
    ].join("\n"),
  });
}
