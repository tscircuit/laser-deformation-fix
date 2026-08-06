import handler from "vinext/server/app-router-entry"

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

export default {
  fetch(
    request: Request,
    env: Parameters<typeof handler.fetch>[1],
    context: WorkerContext,
  ) {
    return handler.fetch(request, env, context)
  },
}
