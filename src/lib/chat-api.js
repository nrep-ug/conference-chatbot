import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import {
  ApiError,
  apiInteger,
  getIntegrationStore,
} from "./api-integrations.js";
import { validateChatQuestion } from "./chat-conversation.js";

export function apiErrorResponse(error, requestId, versioned = true) {
  const known = error instanceof ApiError;
  const status = known ? error.status : 503;
  const message = known ? error.message : "The API is temporarily unavailable.";
  const code = known ? error.code : "service_unavailable";
  return Response.json(
    { error: versioned ? { code, message } : message, code, requestId },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
        ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
        ...(error.retryAfter
          ? { "Retry-After": String(error.retryAfter) }
          : {}),
      },
    },
  );
}

export async function readApiJson(request, maxBytes = 32768) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") || "",
    )
  ) {
    throw new ApiError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
  }
  if (
    request.headers.get("content-encoding") &&
    request.headers.get("content-encoding") !== "identity"
  ) {
    throw new ApiError(
      415,
      "unsupported_encoding",
      "Compressed request bodies are not supported.",
    );
  }
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new ApiError(413, "body_too_large", "Request body is too large.");
  const reader = request.body?.getReader();
  if (!reader)
    throw new ApiError(400, "invalid_json", "A JSON request body is required.");
  const chunks = [];
  let bytes = 0;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
  const cancel = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes)
        throw new ApiError(413, "body_too_large", "Request body is too large.");
      chunks.push(Buffer.from(value));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Not an object");
    return body;
  } catch (error) {
    cancel();
    if (error instanceof ApiError) throw error;
    if (signal.aborted)
      throw new ApiError(
        408,
        "request_timeout",
        "The request body was not received in time.",
      );
    throw new ApiError(
      400,
      "invalid_json",
      "Request body must be a JSON object.",
    );
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function checkAdminOrigin(request) {
  const origin = request.headers.get("origin");
  const expected = process.env.ADMIN_APP_ORIGIN || new URL(request.url).origin;
  if (
    !origin ||
    origin !== expected ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new ApiError(
      403,
      "origin_denied",
      "A same-origin admin request is required.",
    );
  }
}

function publicIdentity(request) {
  // Opt in only when the proxy overwrites this header and Node's port is private.
  const header = (process.env.CHAT_API_TRUSTED_IP_HEADER || "")
    .trim()
    .toLowerCase();
  const value = header ? (request.headers.get(header) || "").trim() : "";
  return isIP(value) ? value : "shared-public-client";
}

export function validateApiBody(body, strict = true) {
  if (
    strict &&
    Object.keys(body).some(
      (key) => !["question", "history", "stream"].includes(key),
    )
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "Only question, history and stream are supported.",
    );
  }
  const validation = validateChatQuestion(body.question, {
    maxChars: apiInteger("CHAT_MAX_QUESTION_CHARS", 4000),
  });
  if (!validation.valid)
    throw new ApiError(400, "invalid_question", validation.error);
  if ("stream" in body && typeof body.stream !== "boolean")
    throw new ApiError(400, "invalid_request", "stream must be a boolean.");
  if (strict && body.history !== undefined) {
    const history = body.history;
    if (
      !Array.isArray(history) ||
      history.length > apiInteger("CHAT_HISTORY_MAX_MESSAGES", 8) ||
      history.some(
        (item) =>
          !item ||
          !["user", "assistant"].includes(item.role) ||
          typeof item.content !== "string" ||
          item.content.length >
            apiInteger("CHAT_HISTORY_MAX_MESSAGE_CHARS", 1200) ||
          Object.keys(item).some((key) => !["role", "content"].includes(key)),
      ) ||
      history.reduce((sum, item) => sum + item.content.length, 0) >
        apiInteger("CHAT_HISTORY_MAX_TOTAL_CHARS", 4800)
    ) {
      throw new ApiError(
        400,
        "invalid_history",
        "History must contain bounded user/assistant messages with role and content only.",
      );
    }
  }
}

const eventBytes = (encoder, code, message, requestId) =>
  encoder.encode(
    "event: error\ndata: " +
      JSON.stringify({ error: message, code, requestId }) +
      "\n\n",
  );

// The injected runner is the shared chat engine, not a second HTTP request.
export async function serveChatApi(
  request,
  {
    versioned = false,
    run,
    store: suppliedStore,
    timeoutMs: suppliedTimeout,
  } = {},
) {
  const requestId = randomUUID();
  let store,
    lease,
    finished = false,
    timer,
    onAbort;
  const operation = new AbortController();
  const signal = AbortSignal.any([request.signal, operation.signal]);
  const finish = (outcome) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (lease) {
      try {
        store.finish(requestId, outcome);
      } catch {
        console.error(
          JSON.stringify({ event: "api_accounting_error", requestId }),
        );
      }
    }
  };
  try {
    let key;
    if (versioned) {
      if (new URL(request.url).search)
        throw new ApiError(
          400,
          "invalid_request",
          "Query parameters are not supported. Send credentials only in the Authorization header.",
        );
      if (request.headers.has("origin"))
        throw new ApiError(
          403,
          "browser_access_denied",
          "Use this API from your backend, not directly from a browser or mobile app.",
        );
      const authorization = request.headers.get("authorization") || "";
      if (!/^Bearer rec_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$/i.test(authorization)) {
        throw new ApiError(
          401,
          "invalid_api_key",
          "A valid Bearer API key is required.",
        );
      }
      key = authorization.slice(7);
      store = suppliedStore || getIntegrationStore();
      store.authenticate(key);
    }
    const body = await readApiJson(
      request,
      apiInteger("CHAT_API_MAX_BODY_BYTES", 32768, 262144),
    );
    validateApiBody(body, versioned);
    store ||= suppliedStore || getIntegrationStore();
    const timeoutMs =
      suppliedTimeout || apiInteger("CHAT_API_TIMEOUT_MS", 180000, 600000);
    signal.throwIfAborted();
    lease = store.admit({
      key,
      publicIdentity: publicIdentity(request),
      requestId,
      timeoutMs,
      globalMax: apiInteger("CHAT_API_MAX_CONCURRENT", 2, 32),
      publicMinute: apiInteger("CHAT_PUBLIC_REQUESTS_PER_MINUTE", 20),
      publicDay: apiInteger("CHAT_PUBLIC_REQUESTS_PER_DAY", 500),
    });
    timer = setTimeout(
      () =>
        operation.abort(
          new DOMException("Request deadline exceeded", "TimeoutError"),
        ),
      timeoutMs,
    );
    timer.unref?.();
    const forwarded = new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    // Bound non-cooperating downstream dependencies as well as normal abort-aware I/O.
    const aborted = new Promise((_, reject) => {
      onAbort = () =>
        reject(
          new ApiError(
            504,
            "response_timeout",
            "The assistant exceeded the response deadline.",
          ),
        );
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const response = await Promise.race([
      run(forwarded, { requestId, integrationId: lease.integrationId }),
      aborted,
    ]);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store, no-transform");
    headers.set("X-Request-Id", requestId);
    headers.set("X-RateLimit-Limit", String(lease.limit));
    headers.set("X-RateLimit-Remaining", String(lease.remaining));
    if (
      !body.stream ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      const payload = await Promise.race([response.json(), aborted]);
      finish(
        response.ok
          ? payload.validationFallback
            ? "degraded"
            : "completed"
          : "failed",
      );
      if (!response.ok && versioned)
        return apiErrorResponse(
          new ApiError(
            response.status,
            "answer_failed",
            payload.error || "Unable to answer.",
          ),
          requestId,
        );
      return Response.json(versioned ? { ...payload, requestId } : payload, {
        status: response.status,
        headers,
      });
    }
    signal.removeEventListener("abort", onAbort);
    const reader = response.body.getReader(),
      decoder = new TextDecoder(),
      encoder = new TextEncoder();
    let buffer = "",
      terminal = false,
      outcome = "failed",
      closed = false;
    const stream = new ReadableStream({
      start(controller) {
        onAbort = () => {
          if (closed) return;
          closed = true;
          const timedOut = operation.signal.aborted;
          if (timedOut)
            controller.enqueue(
              eventBytes(
                encoder,
                "response_timeout",
                "The assistant exceeded the response deadline.",
                requestId,
              ),
            );
          controller.close();
          reader.cancel().catch(() => {});
          finish(timedOut ? "failed" : "cancelled");
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      },
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (closed) return;
          if (done) {
            closed = true;
            if (!terminal)
              controller.enqueue(
                eventBytes(
                  encoder,
                  "incomplete_response",
                  "The response ended before completion.",
                  requestId,
                ),
              );
            controller.close();
            finish(outcome);
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (frame.startsWith("event: done\n")) {
              terminal = true;
              const data = JSON.parse(frame.slice(frame.indexOf("data: ") + 6));
              outcome = data.validationFallback ? "degraded" : "completed";
            } else if (frame.startsWith("event: error\n")) {
              terminal = true;
              outcome = "failed";
            }
          }
          if (buffer.length > 262144) throw new Error("Oversized stream event");
          controller.enqueue(value);
          // Consumers commonly cancel immediately after the terminal event,
          // without another read for EOF. That is a completed response.
          if (terminal) finish(outcome);
        } catch {
          if (!closed) {
            closed = true;
            controller.enqueue(
              eventBytes(
                encoder,
                "stream_failed",
                "The response stream failed.",
                requestId,
              ),
            );
            controller.close();
          }
          operation.abort();
          reader.cancel().catch(() => {});
          finish("failed");
        }
      },
      cancel() {
        closed = true;
        operation.abort();
        reader.cancel().catch(() => {});
        finish("cancelled");
      },
    });
    return new Response(stream, { headers });
  } catch (error) {
    finish(request.signal.aborted ? "cancelled" : "failed");
    if (!(error instanceof ApiError))
      console.error(JSON.stringify({ event: "api_request_error", requestId }));
    return apiErrorResponse(error, requestId, versioned);
  }
}
