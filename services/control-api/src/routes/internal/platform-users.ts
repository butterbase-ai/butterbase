import type { FastifyPluginAsync } from 'fastify';

// Internal lookup used by the deno-runtime function-loader to resolve an
// app owner's email for ctx.appOwner. Cross-plane: apps.owner_id lives in
// the runtime DB; platform_users lives in the control DB. Gated by the
// internal-auth plugin (shared secret).
const platformUsersInternalRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    '/v1/internal/platform-users/:id/email',
    async (req, reply) => {
      const { id } = req.params;
      const result = await fastify.controlDb.query<{ email: string | null }>(
        'SELECT email FROM platform_users WHERE id = $1',
        [id],
      );
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return { email: result.rows[0].email };
    },
  );
};

export default platformUsersInternalRoutes;
