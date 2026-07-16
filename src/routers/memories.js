import express from 'express';
import UserMemoryServer from '../services/userMemoryServer.js';
import { requireAuth } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const result = await UserMemoryServer.list(req.auth.user.id, req.query.conversationId, {
      limit: req.query.limit,
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || '获取记忆失败',
    });
  }
});

router.delete('/:conversationId?', async (req, res) => {
  try {
    const result = await UserMemoryServer.clear(req.auth.user.id, req.params.conversationId);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || '清空记忆失败',
    });
  }
});

export default router;
