import { serveChatApi } from "@/lib/chat-api";
import { handleChatRequest } from "@/lib/chat-service";

export const runtime = "nodejs";

export function POST(request) {
  return serveChatApi(request, { versioned: true, run: handleChatRequest });
}
