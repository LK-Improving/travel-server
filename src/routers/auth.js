import express from 'express';
import AuthServer from '../services/authServer.js';
import { requireAuth } from '../middlewares/authMiddleware.js';

const router = express.Router();

function sendError(res, error, fallback = '认证失败', status = 400) {
  return res.status(status).json({
    success: false,
    error: error.message || fallback,
  });
}

router.post('/register', async (req, res) => {
  try {
    const result = await AuthServer.register(req.body);
    return res.status(201).json(result);
  } catch (error) {
    return sendError(res, error, '注册失败');
  }
});

router.post('/login', async (req, res) => {
  try {
    const result = await AuthServer.login(req.body);
    return res.json(result);
  } catch (error) {
    return sendError(res, error, '登录失败', 401);
  }
});

router.get('/me', requireAuth, async (req, res) => {
  return res.json({
    success: true,
    user: req.auth.user,
  });
});

router.post('/logout', requireAuth, async (_req, res) => {
  return res.json({
    success: true,
    message: '已退出登录',
  });
});

export default router;
