import type { Env } from './env';
import { refreshStep } from './refresh';
import { handleRequest } from './routes';

/**
 * Finocus API.
 *
 * Two entry points with opposite jobs:
 *   fetch()     — serve precomputed JSON out of KV. Fast, no upstream calls.
 *   scheduled() — pull, parse and compute everything. Slow, runs on cron.
 *
 * Scheduled invocations get far more CPU headroom than request invocations,
 * which is the reason the split exists: parsing 28 managers' 13F XML on the
 * request path would be both slow and liable to hit the CPU limit.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (e) {
      // Never leak an upstream URL (and its api_key) in an error body.
      console.error('unhandled', e);
      return new Response(JSON.stringify({ error: 'internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // One step per tick — see refresh.ts for why the work is sharded.
    ctx.waitUntil(
      refreshStep(env).then((report) => {
        console.log('refresh', JSON.stringify(report));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
