import { requireOwnerToken } from '../auth/owner-token.js';
import { runNoeDoctor } from '../../runtime/NoeDoctor.js';

export function registerNoeDoctorRoutes(app, {
  sendError,
  doctor = runNoeDoctor,
  root = process.cwd(),
  env = process.env,
} = {}) {
  app.get('/api/noe/doctor', requireOwnerToken, async (req, res) => {
    try {
      const includeNetwork = req.query?.network === '1' || req.query?.network === 'true';
      const result = await doctor({ root, env, skipNetwork: !includeNetwork });
      return res.status(result.ok ? 200 : 503).json(result);
    } catch (e) {
      return sendError(res, e);
    }
  });
}

