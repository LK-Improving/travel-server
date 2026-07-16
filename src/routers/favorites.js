import express from 'express';
import FavoriteServer from '../services/favoriteServer.js';
import { requireAuth } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const result = await FavoriteServer.list(req.auth.user.id, req.query);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || '获取收藏失败',
    });
  }
});

router.post('/', async (req, res) => {
  try {
    const result = await FavoriteServer.create(req.auth.user.id, req.body);
    return res.status(201).json(result);
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || '创建收藏失败',
    });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await FavoriteServer.remove(req.auth.user.id, req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(404).json({
      success: false,
      error: error.message || '删除收藏失败',
    });
  }
});

export default router;
