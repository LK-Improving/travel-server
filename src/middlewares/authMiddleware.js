import { verifyAuthToken } from '../services/authToken.js';
import AuthServer from '../services/authServer.js';

function getBearerToken(req) {
  const authorization = req.headers.authorization || '';
  const [scheme, token] = authorization.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

export async function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    const payload = verifyAuthToken(token);
    const profile = await AuthServer.getProfile(payload.sub);

    req.auth = {
      tokenPayload: payload,
      user: profile.user,
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: error.message || '请先登录',
    });
  }
}

export async function optionalAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) {
    req.auth = null;
    return next();
  }

  try {
    const payload = verifyAuthToken(token);
    const profile = await AuthServer.getProfile(payload.sub);

    req.auth = {
      tokenPayload: payload,
      user: profile.user,
    };

    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: error.message || '认证失败',
    });
  }
}
