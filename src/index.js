import express from 'express';
import swaggerUi from 'swagger-ui-express';
import travelRouter from './routers/travel.js';
import travelRagRouter from './routers/travelRag.js';
import travelAgentRouter from './routers/travelAgent.js';
import authRouter from './routers/auth.js';
import favoritesRouter from './routers/favorites.js';
import memoriesRouter from './routers/memories.js';
import { openapiSpec } from './swagger.js';
import 'dotenv/config.js';
import cors from 'cors';

const app = express();
const port = process.env.PORT;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors()); 



app.post('/api/heartbeat', (req, res) => {
  console.log('res.query :>> ', req.query);
  console.log('res.body :>> ', req.body);
  res.send({
    code: 200,
    msg: '服务正常启动',
    timestamp: Date.now(),
  });
});

app.get('/api-docs.json', (_req, res) => {
  res.json(openapiSpec);
});
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, { explorer: true }));

app.use('/api/travel', travelRouter);
app.use('/api/travel-rag', travelRagRouter);
app.use('/api/travel-agent', travelAgentRouter);
app.use('/api/auth', authRouter);
app.use('/api/favorites', favoritesRouter);
app.use('/api/memories', memoriesRouter);

app.listen(port, () => {
  console.log(`服务地址： http://localhost:${port}`);
});
