# Developer Guide: REC Chat API

This guide takes you from your first API request to a website chat, a mobile
chat, or a server-to-server integration. It assumes you know how to run your
application but not necessarily how API authentication or streaming works.

The examples target the current **REC Chat API v1** at
`https://chat.nrep.ug/api/v1/chat`. They use the same public conference
knowledge as the chatbot website. The API is for questions and answers, not
for reading arbitrary Appwrite tables or administering the chatbot.

For the exact machine-readable contract, see the
[OpenAPI specification](../public/rec-chat.openapi.json). For operational
limits, storage, and deployment details, see the [API reference](chat-api.md).

## Contents

1. [How the integration works](#how-the-integration-works)
2. [Get a key and make your first request](#get-a-key-and-make-your-first-request)
3. [Understand requests, answers, and conversation history](#understand-requests-answers-and-conversation-history)
4. [Build a website integration](#build-a-website-integration)
5. [Build a mobile integration](#build-a-mobile-integration)
6. [Connect other backends and jobs](#connect-other-backends-and-jobs)
7. [Stream the answer](#stream-the-answer)
8. [Handle errors and protect capacity](#handle-errors-and-protect-capacity)
9. [Use the attached Postman workspace](#use-the-attached-postman-workspace)
10. [Release checklist and troubleshooting](#release-checklist-and-troubleshooting)

## How the integration works

An **API key** is a secret identifying your application backend. It is not a
visitor login, and it must never be sent to a visitor's browser or packaged
into a mobile app. The safe route is:

```text
Browser / mobile app / other client
        |
        | request using YOUR app's login or public-session controls
        v
Your application backend
        |
        | HTTPS POST with the secret REC integration key
        v
https://chat.nrep.ug/api/v1/chat
        |
        | JSON answer or an SSE stream
        v
Your backend -> your client
```

"Your backend" can be a Next.js Route Handler, Express server, FastAPI app,
Laravel application, ASP.NET Core API, Spring service, or a mobile app's
existing server. Its responsibilities are to:

- keep the REC key in server-side secrets;
- authenticate visitors or enforce anonymous-session protections;
- limit requests per user/session, validate input, and prevent abuse;
- send only `question`, bounded `history`, and `stream` to the REC API;
- pass the answer and safe source metadata back to the client.

The REC API does **not** currently provide a browser SDK, cross-origin access,
a hosted widget, mobile-user tokens, or a conversation-storage service. A
floating chat button is a UI you build on your site; it calls your own backend.
Giving a visitor the REC key to "make it work" would let them use your quota.
The versioned route also rejects requests containing an `Origin` header.

All registered integrations initially share the same public REC knowledge.
Register separate keys for separate backends so you can set independent limits
and rotate one key without taking down the others.

## Get a key and make your first request

### 1. Register an integration

An owner or administrator signs in at `https://chat.nrep.ug/admin`, opens
**API integrations**, and creates an integration for your **backend** (for
example, "conference website production API"). Choose the quota, concurrent
request limit, and expiry appropriate for that backend. The default key
lifetime is 90 days. Copy the new key when it appears: it is shown only once.
Store it in your backend's secret manager as `REC_CHAT_API_KEY`. The chatbot's
own `.env.local` is **not** where a separate application puts its integration
key.

### 2. Set the secret locally

For an initial terminal test, set a shell environment variable. These commands
only set a value in your current shell session; do not commit it to Git.

```bash
# Bash / zsh: paste the key without saving it to a source file.
read -rs REC_CHAT_API_KEY
export REC_CHAT_API_KEY
```

```powershell
# PowerShell: prompts without displaying the pasted key.
$secureKey = Read-Host "REC API key" -AsSecureString
$env:REC_CHAT_API_KEY = [System.Net.NetworkCredential]::new("", $secureKey).Password
```

If your deployment uses `.env`, add this variable only to the **calling
backend's private environment**. In a Next.js application, do not prefix it
with `NEXT_PUBLIC_`. In a Flutter/Android/iOS project, do not put it in a
build-time configuration file shipped with the app.

### 3. Make a simple JSON request

Use `POST`, a Bearer header, and a JSON body. `stream: false` is the simplest
way to begin. The "hello" check does not require model inference; use a
conference-specific question for the first actual answer test.

```bash
curl --fail-with-body https://chat.nrep.ug/api/v1/chat \
  -H "Authorization: Bearer $REC_CHAT_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"question":"When will the conference take place?","stream":false}'
```

```powershell
$body = @{ question = "When will the conference take place?"; stream = $false } | ConvertTo-Json
Invoke-RestMethod -Uri "https://chat.nrep.ug/api/v1/chat" -Method Post `
  -Headers @{ Authorization = "Bearer $env:REC_CHAT_API_KEY" } `
  -ContentType "application/json" -Body $body
```

The response will look like this; the answer text and source list depend on
current conference data:

```json
{
  "answer": "The conference begins on ...",
  "sources": [
    { "source": "REC public data snapshot", "sourceType": "conference_snapshot" }
  ],
  "cached": false,
  "requestId": "00000000-0000-0000-0000-000000000000"
}
```

The example values above are illustrative, not guaranteed facts. In
particular, some sources have a `source` label rather than a `title` or URL.

## Understand requests, answers, and conversation history

### Request contract

The endpoint is `POST /api/v1/chat` over HTTPS with:

```http
Authorization: Bearer <the key issued in admin>
Content-Type: application/json
```

The JSON object can contain **only** these fields:

| Field | What to send | Default limit |
| --- | --- | --- |
| `question` | Required user question string | 2-4,000 characters |
| `history` | Optional recent messages | 8 messages; 1,200 characters each; 4,800 total |
| `stream` | Optional boolean: `true` for SSE, `false` for JSON | `false` |

Limits can be changed by deployment settings; those listed here are the
current defaults. A JSON body is limited to 32 KiB by default. A request with
unknown fields, invalid roles, query parameters, a compressed body, or an
oversized payload is rejected. Keep private customer information out of
questions unless you have approved it under your own data-handling policy.

### What a successful JSON answer contains

- `answer` is a Markdown string. It can be a direct fact, a reasoned
  recommendation based on conference evidence, or an explicit statement that
  information is not published.
- `sources` is an array of public attribution objects. Its objects are not a
  guaranteed uniform shape: use `title` or `source` as a display label when
  available, and link only a validated HTTP(S) `url` when present.
- `requestId` identifies this call and is useful when reporting a problem.
  The same ID is also in the `X-Request-Id` response header.
- `cached` is optional and means an existing answer was reused. Cached calls
  still consume quota.
- `validationFallback` is optional. If true, the assistant used a verified
  fallback because model synthesis could not be validated; treat it as a
  degraded answer, not a fresh model explanation.

Render the answer with a Markdown renderer that does not execute raw HTML or
allow `javascript:`/other unsafe links. Do not insert `answer` directly into
`innerHTML` or React's `dangerouslySetInnerHTML`. On native mobile, plain text
is a safe first step; add a safe Markdown renderer later if needed.

### Keep a multi-turn conversation

The REC API is **stateless**: it does not issue conversation IDs or remember
your visitor's messages. Your app keeps the conversation and sends a bounded
window of **completed** previous turns with each new question:

```json
{
  "question": "And which hall is that in?",
  "history": [
    { "role": "user", "content": "Tell me about the EU Business Forum" },
    { "role": "assistant", "content": "The published forum runs on ..." }
  ],
  "stream": false
}
```

Use `role: "user"` or `role: "assistant"` only. Each history item has only
`role` and `content`. Do not include the **current** question a second time in
history. Send a recent, relevant window rather than every message since the
first visit. For a simple client, keep at most the last four turns and trim
each saved message to 1,200 characters; four such turns fit the 4,800-character
total limit. For more elaborate clients, count the total characters and drop
oldest messages until the window fits. Keep each user's history separate, and
clear it when they begin a new chat.

### Ask about the right knowledge

The API can answer from the current conference, published previous editions,
visitor guidance, public media and reports, programme, venue, sponsors, and
related conference context. It may give practical advice grounded in those
materials, but it cannot guarantee unpublished details (for example, a Wi-Fi
password not entered by an administrator). Ask it to distinguish published
facts from suggested preparation. Do not treat its prose as a booking,
registration, payment, or emergency-service confirmation.

## Build a website integration

### Next.js backend (TypeScript)

In a Next.js App Router project, place a Route Handler at
`app/api/rec-chat/route.ts`. This is a **template**: replace the imported
`requireUser` with your application's real authentication/session function.
For a public visitor chat, use a rate-limited anonymous session instead and
enforce limits before the upstream call. Do not deploy this route without an
access-control and per-user/session rate-limit implementation.

```ts
// app/api/rec-chat/route.ts, in YOUR website application
import { requireUser } from "@/lib/auth"; // Adapt to your own auth implementation.

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });

  // Enforce your own rate limit for user.id here, before calling REC.
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = input as { question?: unknown; history?: unknown };
  if (typeof body?.question !== "string" || body.question.trim().length < 2 ||
      body.question.length > 4000) {
    return Response.json({ error: "Question must be 2-4000 characters" }, { status: 400 });
  }

  const key = process.env.REC_CHAT_API_KEY;
  if (!key) return Response.json({ error: "Chat unavailable" }, { status: 503 });

  // Allowlist fields; never forward arbitrary JSON or user-supplied headers.
  const payload = {
    question: body.question,
    history: Array.isArray(body.history) ? body.history.slice(-8) : [],
    stream: false,
  };

  try {
    const upstream = await fetch("https://chat.nrep.ug/api/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: request.signal,
    });
    const result = await upstream.json();
    if (!upstream.ok) {
      // Log requestId and status server-side, but never the key or full prompt.
      console.error("REC API error", upstream.status, result.requestId);
      return Response.json(
        { error: upstream.status === 429 ? "Chat is busy; please retry shortly" : "Chat unavailable",
          requestId: result.requestId },
        { status: upstream.status === 429 ? 429 : 502,
          headers: upstream.headers.get("Retry-After")
            ? { "Retry-After": upstream.headers.get("Retry-After")! } : {} },
      );
    }
    return Response.json({ answer: result.answer, sources: result.sources,
      requestId: result.requestId, validationFallback: result.validationFallback });
  } catch {
    return Response.json({ error: "Chat unavailable" }, { status: 502 });
  }
}
```

`requireUser` and the per-user limiter are intentionally application-specific:
the REC key authenticates your **backend**, not a visitor. Configure your
website's hosting platform to permit a long-running request. The REC answer
deadline is 180 seconds by default, although simple fact questions may finish
much sooner. A platform with a shorter function deadline needs an appropriate
streaming or dedicated-server deployment.

This pattern follows the current Next.js [Route Handler
convention](https://nextjs.org/docs/app/getting-started/route-handlers).

### React browser UI (TypeScript)

Your browser calls `/api/rec-chat` on **your website**, never the REC host.
This small component demonstrates a conversation and Markdown display. Install
`react-markdown` in your **website project** with your project's package
manager if you want formatted answers. Its default URL handling should not be
replaced with an unsafe transform, and `skipHtml` discards raw HTML. See the
[react-markdown documentation](https://github.com/remarkjs/react-markdown/blob/main/readme.md).

```tsx
"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";

type Turn = { role: "user" | "assistant"; content: string };

export function RecChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function ask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = question.trim();
    if (text.length < 2 || busy) return;
    setBusy(true);
    setError("");
    setQuestion("");
    const history = turns.slice(-4).map((turn) => ({
      role: turn.role, content: turn.content.slice(0, 1200),
    }));
    setTurns((old) => [...old, { role: "user", content: text }]);

    try {
      const response = await fetch("/api/rec-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, history }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Chat unavailable");
      setTurns((old) => [...old, { role: "assistant", content: data.answer }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Chat unavailable");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Conference chat">
      <div aria-live="polite">
        {turns.map((turn, index) => (
          <div key={index}>
            <strong>{turn.role === "user" ? "You" : "REC Assistant"}</strong>
            {turn.role === "assistant"
              ? <ReactMarkdown skipHtml>{turn.content}</ReactMarkdown>
              : <p>{turn.content}</p>}
          </div>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={ask}>
        <label htmlFor="rec-question">Your question</label>
        <input id="rec-question" value={question} maxLength={4000}
          onChange={(event) => setQuestion(event.target.value)} />
        <button type="submit" disabled={busy || question.trim().length < 2}>
          {busy ? "Thinking" : "Send"}
        </button>
      </form>
    </section>
  );
}
```

For a bottom-right floating chat, put this component in a panel controlled by
a visible chat button. The panel should be keyboard-accessible, labelled,
closable, usable on narrow screens, and should not auto-send when opened.
Persist conversation in your own application only if your privacy policy and
retention rules allow it. Avoid storing unbounded transcripts in the browser.

### Express / Node.js backend

If your site already has an Express server, install Express in **that**
project and use its normal JSON middleware. The `requireUser` and `limitUser`
middleware below stand for your existing authentication and per-user limiter;
register them on this route before the handler.

```js
// server.mjs, in YOUR Express backend
import express from "express";

const app = express();
app.use(express.json({ limit: "32kb" }));

app.post("/api/rec-chat", requireUser, limitUser, async (req, res) => {
  const { question, history = [] } = req.body ?? {};
  if (typeof question !== "string" || question.trim().length < 2 ||
      question.length > 4000 || !Array.isArray(history)) {
    return res.status(400).json({ error: "Invalid question or history" });
  }

  try {
    const upstream = await fetch("https://chat.nrep.ug/api/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REC_CHAT_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ question, history: history.slice(-8), stream: false }),
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      console.error("REC API error", upstream.status, data.requestId);
      return res.status(upstream.status === 429 ? 429 : 502)
        .json({ error: "Chat unavailable", requestId: data.requestId });
    }
    return res.json(data);
  } catch {
    return res.status(502).json({ error: "Chat unavailable" });
  }
});
```

Define or import `requireUser` and `limitUser` using your project's existing
middleware; this is a route template, not a complete public authentication
system. In particular, an unprotected public endpoint that forwards to REC
lets anyone spend your quota. See the [Express routing
guide](https://expressjs.com/en/guide/routing/) for route middleware.

## Build a mobile integration

### Mobile architecture

An app binary can be inspected. Its API key, even if "obfuscated" or hashed,
would not stay secret. Create a `/api/rec-chat` endpoint on **your mobile
app's backend** using one of the server examples above. The app sends its
normal user/session credential to that backend. Your backend obtains the REC
key from its secrets and sends the versioned REC request.

For an app without logins, your backend should issue short-lived anonymous
session tokens and limit by session plus abuse signals. The REC API does not
issue such tokens for mobile users. Treat your mobile chat like any other
public-facing endpoint, not like a trusted server-to-server call.

The samples below use `https://api.example.org/api/rec-chat` as **your**
backend URL, not `chat.nrep.ug`. Replace it with your own HTTPS host. Each
sample asks for JSON (`stream: false` on your backend) and should be run off
the UI thread where the platform requires it.

### Flutter / Dart

In your Flutter project, add the `http` package (`flutter pub add http`).
Android and iOS may need their usual network permissions/configuration. The
`sessionToken` below is your app's user token, **not** the REC integration key.
Follow the [Dart HTTP package documentation](https://pub.dev/packages/http).

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

Future<String> askRec(String question, String sessionToken) async {
  final response = await http.post(
    Uri.parse('https://api.example.org/api/rec-chat'),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer $sessionToken',
    },
    body: jsonEncode({'question': question}),
  ).timeout(const Duration(seconds: 195));
  final data = jsonDecode(response.body) as Map<String, dynamic>;
  if (response.statusCode != 200) {
    throw Exception(data['error'] ?? 'Chat unavailable');
  }
  return data['answer'] as String; // Markdown; render safely or as plain text.
}
```

Keep recent turns in your view model or state manager and send bounded
`history` if you want follow-up questions to work. If your backend uses a
secure session cookie rather than a token, adapt the header accordingly.

### Android / Kotlin

This example uses the built-in `HttpURLConnection` and `org.json.JSONObject`
to avoid making a specific networking library mandatory. Call it from an I/O
coroutine, not from the main thread. Add
`<uses-permission android:name="android.permission.INTERNET" />` to the app
manifest. `appToken` is your app's user/session token.

```kotlin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

suspend fun askRec(question: String, appToken: String): String = withContext(Dispatchers.IO) {
    val connection = URL("https://api.example.org/api/rec-chat")
        .openConnection() as HttpURLConnection
    try {
        connection.requestMethod = "POST"
        connection.setRequestProperty("Content-Type", "application/json")
        connection.setRequestProperty("Authorization", "Bearer $appToken")
        connection.connectTimeout = 10_000
        connection.readTimeout = 195_000
        connection.doOutput = true
        val body = JSONObject().put("question", question).toString()
        connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        val input = if (connection.responseCode in 200..299)
            connection.inputStream else connection.errorStream
        val data = JSONObject(input.bufferedReader().use { it.readText() })
        if (connection.responseCode !in 200..299) {
            throw IllegalStateException(data.optString("error", "Chat unavailable"))
        }
        data.getString("answer")
    } finally {
        connection.disconnect()
    }
}
```

Tune mobile request timeouts to your own backend's deployment and UX.
Cancel the coroutine when the chat screen closes. Android's [network
guidance](https://developer.android.com/develop/connectivity/network-ops/connecting)
also explains permissions and thread requirements.

### iOS / Swift

Use `URLSession` and your own backend's login token. This is async Swift and
returns the Markdown answer as a string. Do not put the REC key in your Xcode
project or `Info.plist`. See Apple's [URLSession
documentation](https://developer.apple.com/documentation/foundation/urlsession).

```swift
import Foundation

struct RecReply: Decodable {
    let answer: String
}

func askRec(question: String, appToken: String) async throws -> String {
    var request = URLRequest(url: URL(string: "https://api.example.org/api/rec-chat")!)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(appToken)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 195
    request.httpBody = try JSONSerialization.data(withJSONObject: ["question": question])

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse,
          (200..<300).contains(httpResponse.statusCode) else {
        throw URLError(.badServerResponse)
    }
    return try JSONDecoder().decode(RecReply.self, from: data).answer
}
```

For a mobile chat UI, keep the last turns in state, show a loading/cancel
control, and use a safe native Markdown renderer or plain text. Treat any
link in an answer as untrusted and open only HTTP(S) destinations.

### React Native / Expo

The same mobile rule applies: `fetch` from the app calls **your backend** with
your app's session credential. Never set an environment variable containing
the REC key in an Expo public config or include it in `fetch` from the app.

```ts
async function askRec(question: string, appToken: string): Promise<string> {
  const response = await fetch("https://api.example.org/api/rec-chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${appToken}`,
    },
    body: JSON.stringify({ question }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Chat unavailable");
  return data.answer;
}
```

## Connect other backends and jobs

If your integration already runs on a server and does not expose its key to
clients, it can call REC directly. Scheduled jobs should still avoid creating
large bursts: the default global capacity is two simultaneous admitted chat
requests, and every admitted request consumes quota.

### Node.js server script

Node 22+ has built-in `fetch`. Put the key in the server environment. The
script below is a complete one-off example: save it in **your backend** as a
`.mjs` file and run it with your key available in the environment.

```js
// ask-rec.mjs
const key = process.env.REC_CHAT_API_KEY;
if (!key) throw new Error("Set REC_CHAT_API_KEY in the server environment");

const response = await fetch("https://chat.nrep.ug/api/v1/chat", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ question: "Which sessions are on Day 2?", stream: false }),
  signal: AbortSignal.timeout(195_000),
});
const data = await response.json();
if (!response.ok) {
  throw new Error(`REC API ${response.status} (${data.code}): ${data.error?.message}`);
}
console.log(data.answer);
console.log("Request ID:", data.requestId);
```

### Python / HTTPX or FastAPI

Install `httpx` in your **Python backend**. This function can be called by a
FastAPI endpoint after you authenticate the visitor and enforce your own
quota, or by a server-side job. It keeps the REC key out of the web/mobile
client. See the [HTTPX quickstart](https://www.python-httpx.org/quickstart/).

```python
import os
import httpx

def ask_rec(question: str, history: list[dict] | None = None) -> dict:
    key = os.environ["REC_CHAT_API_KEY"]
    with httpx.Client(timeout=195.0) as client:
        response = client.post(
            "https://chat.nrep.ug/api/v1/chat",
            headers={"Authorization": f"Bearer {key}"},
            json={"question": question, "history": (history or [])[-8:], "stream": False},
        )
    data = response.json()
    if response.is_error:
        raise RuntimeError(
            f"REC API {response.status_code}, request {data.get('requestId')}: "
            f"{data.get('code')}"
        )
    return data
```

In FastAPI, do not expose this helper through an unauthenticated path. Use
your existing user dependency or a rate-limited anonymous session **before**
calling it. Because this sample uses a synchronous client, call it from a
normal `def` endpoint or use `httpx.AsyncClient` in an `async def` endpoint.
FastAPI's [security tools](https://fastapi.tiangolo.com/tutorial/security/)
cover user authentication separately from the REC integration key.

### PHP / Laravel

In a Laravel backend, put `REC_CHAT_API_KEY` in that backend's private
environment and read it via a server-side config entry in production. The
HTTP client sends the JSON request. This service method should be called only
after your controller has applied its user/session authorization and limiter.
See the [Laravel HTTP client](https://laravel.com/docs/13.x/http-client).

```php
<?php

use Illuminate\Support\Facades\Http;

function askRec(string $question, array $history = []): array
{
    $response = Http::withToken(config('services.rec_chat.key'))
        ->acceptJson()
        ->timeout(195)
        ->post('https://chat.nrep.ug/api/v1/chat', [
            'question' => $question,
            'history' => array_slice($history, -8),
            'stream' => false,
        ]);

    if ($response->failed()) {
        // Log status and requestId, not the key or the visitor's full question.
        throw new RuntimeException('REC API unavailable: ' . $response->status());
    }
    return $response->json();
}
```

Add `services.rec_chat.key` in `config/services.php` as
`'rec_chat' => ['key' => env('REC_CHAT_API_KEY')]`. This keeps the example
working when Laravel configuration is cached.

### C# / ASP.NET Core

Use ASP.NET Core's `IHttpClientFactory` rather than creating a new
`HttpClient` for every request. This example is server-side; obtain the key
from a server secret store through configuration. Call it only from a
protected or rate-limited controller/endpoint. See Microsoft's
[HttpClientFactory guidance](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/http-requests).

```csharp
// Program.cs: builder.Services.AddHttpClient();
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

public sealed class RecChatClient(IHttpClientFactory factory, IConfiguration config)
{
    public async Task<string> AskAsync(string question, CancellationToken cancellation)
    {
        var key = config["REC_CHAT_API_KEY"]
            ?? throw new InvalidOperationException("REC API key not configured");
        using var client = factory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(195);
        using var request = new HttpRequestMessage(HttpMethod.Post,
            "https://chat.nrep.ug/api/v1/chat");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        request.Content = JsonContent.Create(new { question, stream = false });

        using var response = await client.SendAsync(request, cancellation);
        using var document = JsonDocument.Parse(
            await response.Content.ReadAsStringAsync(cancellation));
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"REC API returned {(int)response.StatusCode}");
        return document.RootElement.GetProperty("answer").GetString() ?? "";
    }
}
```

Set an appropriate client timeout (above the REC server deadline by default)
and preserve the caller's cancellation token. Prefer a named/typed client if
you already use one in your application.

### Java / Spring Boot

Spring's `WebClient` can call the API from a server-side service. Keep the key
in your server's environment/configuration and do not expose the service as
an unrestricted public endpoint. The `ChatReply` record ignores optional
response fields; add `sources` if your application displays attribution.
See Spring's [WebClient retrieve
documentation](https://docs.spring.io/spring-framework/reference/web/webflux-webclient/client-retrieve.html).

```java
// Add Spring WebFlux client support to your backend if it is not already present.
import org.springframework.http.MediaType;
import org.springframework.web.reactive.function.client.WebClient;

record ChatReply(String answer) {}

WebClient client = WebClient.create("https://chat.nrep.ug");
String key = System.getenv("REC_CHAT_API_KEY");
if (key == null) throw new IllegalStateException("REC API key not configured");

ChatReply reply = client.post()
    .uri("/api/v1/chat")
    .contentType(MediaType.APPLICATION_JSON)
    .headers(headers -> headers.setBearerAuth(key))
    .bodyValue(java.util.Map.of("question", "What happens on Day 3?", "stream", false))
    .retrieve()
    .bodyToMono(ChatReply.class)
    .block(java.time.Duration.ofSeconds(195));

System.out.println(reply.answer());
```

In a reactive Spring application, return or compose the `Mono` instead of
blocking a request thread. Configure timeouts and handle HTTP errors in your
service layer.

## Stream the answer

`stream: true` returns a **Server-Sent Events (SSE)** response. SSE is a text
format with named events. Unlike a WebSocket, the stream is one request and
one response. In this API it is a `POST` with a JSON body and Bearer header;
the browser's `EventSource` API cannot make this request directly. Use
`fetch`/a streaming HTTP client from your backend and, if you want live text
in the browser, forward a stream through your own route.

```bash
curl -N https://chat.nrep.ug/api/v1/chat \
  -H "Authorization: Bearer $REC_CHAT_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"question":"Tell me about the sessions","stream":true}'
```

The stream begins with a `: connected` comment and may send `: keepalive`
comments while the assistant works. Events are separated by a blank line:

```text
: connected

event: sources
data: [{"source":"REC public data snapshot"}]

event: token
data: "**REC26 & EXPO**"

event: done
data: {"cached":false}

```

The `data:` part is **JSON**, even for a `token` string. The four event types
your application should handle are:

| Event | What it means |
| --- | --- |
| `sources` | Set/replace the source attribution array |
| `token` | Append the decoded string to the visible answer |
| `done` | Complete answer; inspect `cached` and possible `validationFallback` |
| `error` | Failed stream; inspect `error`, `code`, and possible `requestId` |

Do not assume that one network chunk equals one SSE event. A chunk can end in
the middle of a UTF-8 character or frame. A model answer may be verified
before **any** token arrives, so show a loading state during heartbeats. The
HTTP status may remain `200` after a streaming `error`; success requires a
`done` event. Ending without `done` or `error` is an incomplete response.
Cancelling the client request cancels the upstream operation.

### Parsing a forwarded SSE stream with browser `fetch`

Your site's `/api/rec-chat-stream` should authenticate and rate-limit the
visitor, send `stream: true` to REC using its **server-only** key, check for
pre-stream JSON errors, and forward `text/event-stream` unbuffered. The
following **browser-side** function reads that route; it never sees the key.

A minimal Next.js gateway template follows. As in the JSON example,
`requireUser` and a per-user/session limiter must be provided by **your app**
before the route is deployed. The chatbot's nginx proxy and your own proxy
must also disable streaming response buffering.

```ts
// app/api/rec-chat-stream/route.ts, in YOUR website application
import { requireUser } from "@/lib/auth"; // Adapt to your own auth implementation.

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  // Enforce your own rate limit for user.id here.

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = input as { question?: unknown; history?: unknown } | null;
  if (typeof body?.question !== "string" || body.question.trim().length < 2 ||
      body.question.length > 4000) {
    return Response.json({ error: "Invalid question" }, { status: 400 });
  }
  const key = process.env.REC_CHAT_API_KEY;
  if (!key) return Response.json({ error: "Chat unavailable" }, { status: 503 });

  try {
    const upstream = await fetch("https://chat.nrep.ug/api/v1/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        question: body.question,
        history: Array.isArray(body.history) ? body.history.slice(-8) : [],
        stream: true,
      }),
      cache: "no-store",
      signal: request.signal,
    });
    const contentType = upstream.headers.get("Content-Type") || "";
    if (!upstream.ok || !contentType.includes("text/event-stream")) {
      const error = await upstream.json().catch(() => ({}));
      console.error("REC stream error", upstream.status, error.requestId);
      return Response.json(
        { error: "Chat unavailable", requestId: error.requestId },
        { status: upstream.status === 429 ? 429 : 502,
          headers: upstream.headers.get("Retry-After")
            ? { "Retry-After": upstream.headers.get("Retry-After")! } : {} },
      );
    }
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return Response.json({ error: "Chat unavailable" }, { status: 502 });
  }
}
```

```ts
async function streamRec(
  question: string,
  history: { role: "user" | "assistant"; content: string }[],
  onToken: (text: string) => void,
  onSources: (sources: unknown[]) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/rec-chat-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, history }),
    signal,
  });
  if (!response.ok) throw new Error(`Chat request failed: ${response.status}`);
  if (!response.body) throw new Error("Streaming is not available");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n"); // Also handles CR/LF split across chunks.
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith(":")) continue; // connected / keepalive
        const event = frame.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
        const raw = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (!event || raw === undefined) continue;
        const data = JSON.parse(raw);
        if (event === "sources") onSources(data);
        if (event === "token") onToken(data);
        if (event === "error") throw new Error(data.error || "Stream failed");
        if (event === "done") complete = true;
      }
    }
    if (!complete) throw new Error("The answer ended before completion");
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
```

This is tailored to the current API's single-line JSON event frames. If your
gateway rewrites SSE or you integrate another provider, use a full SSE parser.
The browser should append the assistant turn to history only after `done`.
Use an `AbortController` to let the user cancel. MDN's [Fetch streaming
guide](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch)
explains why a reader/decoder is needed.

### Streaming gateway considerations

Your backend must not call `response.json()` on a successful SSE response.
Check its `Content-Type`; if REC sends JSON with a non-200 status, handle that
before returning streaming headers to your client. If you relay the upstream
body, forward cancellation, disable buffering at your reverse proxy, and set
proxy/read timeouts beyond the chatbot answer deadline. For the chatbot's
nginx host, `/api/v1/chat` needs its own unbuffered location because the
existing `/api/chat` location does not match the versioned route. Do not add
`Access-Control-Allow-Origin` to the REC API to work around the backend-only
design.

For v1, prefer JSON until your UI needs visible partial answers. Streaming
improves perceived responsiveness for long answers but adds event framing,
completion, error, and cancellation work.

## Handle errors and protect capacity

Before a stream starts, an API failure is a non-200 HTTP response with JSON:

```json
{
  "error": { "code": "rate_limit_exceeded", "message": "Request limit reached for this minute." },
  "code": "rate_limit_exceeded",
  "requestId": "00000000-0000-0000-0000-000000000000"
}
```

Your backend can record the **status, code, requestId, duration, and
integration name**. Never log the REC key. Be deliberate about logging
visitor prompts, answers, or app login tokens. Show a short user-friendly
message, and use the request ID when asking an administrator to investigate.

| Status | Likely cause | What your integration should do |
| --- | --- | --- |
| `400` | Invalid question/history, unknown fields, or query string | Fix the caller; do not retry unchanged |
| `401` | Missing, malformed, rotated, or revoked REC key | Fix server secret; do not ask visitor to retry repeatedly |
| `403` | Disabled/expired integration or Origin-bearing direct browser call | Fix integration or backend architecture |
| `408` | Request body upload timed out | Check network/body size; retry only cautiously |
| `413` / `415` | Too large; wrong content type/encoding | Send a smaller JSON body without compression |
| `429` | Minute/day/concurrency limit for this integration | Honor `Retry-After`; apply own backpressure |
| `503` | Shared capacity or API store unavailable | Show busy/unavailable; honor `Retry-After` if present |
| `504` | Answer deadline exceeded | Cancel, explain delay; let user ask a narrower question |
| `500` | Downstream/answer failure | Record request ID and investigate; do not loop retries |

Headers on admitted requests include `X-RateLimit-Limit` and
`X-RateLimit-Remaining` for the current fixed UTC minute. Capacity/quota
responses may include `Retry-After` in **seconds**. On `429` or retryable
`503`, wait that long plus a little random jitter; cap attempts and avoid
retry storms. Do not automatically retry `400`, `401`, or `403`. A retry is a
**new** request: there is no idempotency replay, and cancelled/timed-out
admitted calls and cached answers still consume quota.

The current deployment defaults to **two simultaneous admitted chat
requests globally**, including the public `/api/chat` route. Your own backend
should limit concurrent chat attempts and reject or delay excessive user
requests without opening an unbounded queue. Avoid automatic "send on each
keystroke" behavior; send only on a deliberate user command. The default
answer deadline is 180 seconds, so your own proxy/function/client timeouts
need to be planned accordingly.

## Use the attached Postman workspace

The attached [`postman/`](../postman/globals/workspace.globals.yaml) directory
contains empty workspace globals, and [`.postman/resources.yaml`](../.postman/resources.yaml)
links the workspace to [`public/rec-chat.openapi.json`](../public/rec-chat.openapi.json).
There is **no saved request collection or environment with a key** in these
attachments. You can generate a collection from the OpenAPI file:

1. In Postman, choose **Import**.
2. Select `public/rec-chat.openapi.json` from this repository, or import
   `https://chat.nrep.ug/rec-chat.openapi.json` if your deployed site serves
   the static specification.
3. Choose the option to create a **Postman Collection** from the OpenAPI
   specification. The generated request is `POST /api/v1/chat`.
4. Create a private local environment with `rec_chat_base_url` set to
   `https://chat.nrep.ug`. Set the request URL to
   `{{rec_chat_base_url}}/api/v1/chat`.
5. Store the key in **Postman Vault** as `rec_chat_api_key` and configure the
   Bearer token value as `{{vault:rec_chat_api_key}}`. If you use an
   environment variable instead, keep its value local/secure and never sync
   or export the secret. Leave the attached workspace globals empty.
6. In **Body -> raw -> JSON**, enter
   `{"question":"When will the conference take place?","stream":false}`.
   Set `Content-Type: application/json`, then click **Send**.
7. Test `stream: true` separately. Postman may display an SSE stream
   differently from a browser or `curl -N`; verify `sources`, `token`, and
   terminal `done` events rather than only the HTTP status.

These steps follow Postman's official [OpenAPI import
guide](https://learning.postman.com/docs/design-apis/api-builder/importing-an-api)
and [Vault secret guide](https://learning.postman.com/docs/use/postman-vault/use-vault-secrets).
Postman is a **developer test tool** here, not a safe way to hand a REC key to
all visitors. Do not include a real key in a collection exported or committed
to this repository.

## Release checklist and troubleshooting

Before your integration goes live:

- [ ] Register a separate integration for each application backend and
      deployment environment; choose quotas and expiry.
- [ ] Store the key in server-only secrets; exclude it from web bundles,
      mobile builds, repositories, URLs, analytics, and logs.
- [ ] Authenticate users or secure anonymous sessions on your backend;
      implement per-user/session rate limits and abuse controls.
- [ ] Send only allowlisted request fields and bounded conversation history.
- [ ] Render Markdown and links safely; show source labels only when present.
- [ ] Handle non-200 JSON errors, `Retry-After`, timeouts, cancellation, and
      incomplete SSE streams if streaming is enabled.
- [ ] Keep backend and proxy timeouts/stream buffering compatible with REC's
      deadline and SSE behavior.
- [ ] Try `hello`, a conference question, a follow-up with history, a bad
      question, and a streamed request with a **test** integration key.
- [ ] Rotate a test key and verify the old one stops working; keep a plan for
      rotating the production secret.

Common symptoms:

- **`401 invalid_api_key`**: the backend is sending no key, the wrong value,
  or an old key after rotation. Check the backend secret store, not browser
  developer tools.
- **`403 browser_access_denied`**: your app called the REC host from browser
  JavaScript. Route through your own backend. Removing the `Origin` header
  client-side is not an authentication design.
- **`400 invalid_history`**: history has too many messages, unsupported
  roles/fields, or too many characters. Trim oldest completed turns.
- **Follow-up ignores earlier answer**: include both the earlier user turn
  and assistant answer in `history`; the API does not remember them itself.
- **`429` or capacity `503`**: check the integration limits and global
  concurrency; respect `Retry-After`. Creating more keys does not raise the
  global ceiling.
- **SSE looks frozen**: heartbeats may arrive while the answer is being
  verified. Confirm no proxy is buffering and wait for `token`/`done` or
  `error`.
- **SSE status is `200` but no answer**: inspect terminal events. An
  `error` event or a connection without `done` is not success.

The [API reference](chat-api.md) covers VPS configuration and SQLite backup.
The [OpenAPI specification](../public/rec-chat.openapi.json) can be imported
into other API tooling and used to generate typed clients, but generated
clients must still run **server-side** when using the REC key.
