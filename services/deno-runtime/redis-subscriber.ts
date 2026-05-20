import { default as Redis } from "npm:ioredis@5.10.1";
import { invalidateCache } from "./function-loader.ts";

export function startRedisSubscriber(): void {
  const redisUrl = Deno.env.get("REDIS_URL");
  if (!redisUrl) {
    console.warn("[Redis] REDIS_URL not set — cache invalidation via pub/sub disabled");
    return;
  }

  const sub = new Redis(redisUrl);

  sub.subscribe("function:invalidate", (err) => {
    if (err) {
      console.error("[Redis] Failed to subscribe to function:invalidate:", err);
      return;
    }
    console.log("[Redis] Subscribed to function:invalidate channel");
  });

  sub.on("message", (_channel: string, message: string) => {
    try {
      const { app_id, function_name } = JSON.parse(message);
      invalidateCache(app_id, function_name);
      console.log(`[Redis] Cache invalidated: ${app_id}:${function_name}`);
    } catch (err) {
      console.error("[Redis] Failed to process invalidation message:", err);
    }
  });

  sub.on("error", (err: Error) => {
    console.error("[Redis] Subscriber error:", err.message);
  });
}
