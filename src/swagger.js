import swaggerJSDoc from 'swagger-jsdoc';

export const openapiSpec = swaggerJSDoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Travel Server API',
      version: '1.0.0',
      description: '旅游助手后端接口文档，包含认证、收藏、记忆和旅游对话接口。',
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: '本地开发环境',
      },
    ],
    tags: [
      { name: 'Auth', description: '用户注册、登录和当前用户' },
      { name: 'Favorites', description: '登录用户收藏功能' },
      { name: 'Memories', description: '登录用户对话记忆功能' },
      { name: 'Travel', description: '旅游推荐和流式对话' },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: '请先登录' },
          },
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', example: 'user@example.com' },
            username: { type: 'string', nullable: true, example: 'travel_user' },
            nickname: { type: 'string', nullable: true, example: '旅行用户' },
            avatarUrl: { type: 'string', nullable: true },
            role: { type: 'string', example: 'user' },
            status: { type: 'string', example: 'active' },
            lastLoginAt: { type: 'string', nullable: true },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
          },
        },
        AuthResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
            user: { $ref: '#/components/schemas/User' },
            token: { type: 'string', example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
          },
        },
        Favorite: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
            targetType: { type: 'string', example: 'travel_plan' },
            targetId: { type: 'string', nullable: true, example: 'plan_001' },
            title: { type: 'string', example: '杭州西湖半日路线' },
            content: { type: 'string', nullable: true, example: '上午西湖，下午灵隐寺...' },
            metadata: { type: 'object', additionalProperties: true },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
          },
        },
        Memory: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            conversationId: { type: 'string', example: 'default' },
            role: { type: 'string', enum: ['user', 'assistant', 'system'] },
            content: { type: 'string', example: '我喜欢自然风光和轻松路线' },
            metadata: { type: 'object', additionalProperties: true },
            createdAt: { type: 'string' },
          },
        },
      },
    },
    paths: {
      '/api/auth/register': {
        post: {
          tags: ['Auth'],
          summary: '用户注册',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  properties: {
                    email: { type: 'string', example: 'user@example.com' },
                    username: { type: 'string', example: 'travel_user' },
                    password: { type: 'string', minLength: 8, example: '12345678' },
                    nickname: { type: 'string', example: '旅行用户' },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: '注册成功', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } } },
            400: { description: '注册失败', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/auth/login': {
        post: {
          tags: ['Auth'],
          summary: '用户登录',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['account', 'password'],
                  properties: {
                    account: { type: 'string', example: 'user@example.com' },
                    password: { type: 'string', example: '12345678' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: '登录成功', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } } },
            401: { description: '登录失败', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/auth/me': {
        get: {
          tags: ['Auth'],
          summary: '获取当前登录用户',
          security: [{ BearerAuth: [] }],
          responses: {
            200: { description: '当前用户', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, user: { $ref: '#/components/schemas/User' } } } } } },
            401: { description: '未登录', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/favorites': {
        get: {
          tags: ['Favorites'],
          summary: '获取收藏列表',
          security: [{ BearerAuth: [] }],
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          ],
          responses: {
            200: { description: '收藏列表', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { $ref: '#/components/schemas/Favorite' } } } } } } },
            401: { description: '未登录', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
        post: {
          tags: ['Favorites'],
          summary: '新增或更新收藏',
          security: [{ BearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title'],
                  properties: {
                    targetType: { type: 'string', example: 'travel_plan' },
                    targetId: { type: 'string', example: 'plan_001' },
                    title: { type: 'string', example: '杭州西湖半日路线' },
                    content: { type: 'string', example: '上午西湖，下午灵隐寺...' },
                    metadata: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: '收藏成功', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { $ref: '#/components/schemas/Favorite' } } } } } },
            401: { description: '未登录', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/favorites/{id}': {
        delete: {
          tags: ['Favorites'],
          summary: '删除收藏',
          security: [{ BearerAuth: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          ],
          responses: {
            200: { description: '删除成功' },
            401: { description: '未登录', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            404: { description: '收藏不存在' },
          },
        },
      },
      '/api/memories': {
        get: {
          tags: ['Memories'],
          summary: '获取当前用户对话记忆',
          security: [{ BearerAuth: [] }],
          parameters: [
            { name: 'conversationId', in: 'query', schema: { type: 'string', default: 'default' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 6 } },
          ],
          responses: {
            200: { description: '记忆列表', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, conversationId: { type: 'string' }, data: { type: 'array', items: { $ref: '#/components/schemas/Memory' } } } } } } },
            401: { description: '未登录', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/memories/{conversationId}': {
        delete: {
          tags: ['Memories'],
          summary: '清空指定会话记忆',
          security: [{ BearerAuth: [] }],
          parameters: [
            { name: 'conversationId', in: 'path', required: true, schema: { type: 'string', default: 'default' } },
          ],
          responses: {
            200: { description: '清空成功' },
            401: { description: '未登录', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          },
        },
      },
      '/api/travel/chat': {
        post: {
          tags: ['Travel'],
          summary: '旅游流式对话，登录后自动启用用户记忆',
          description: '返回 text/event-stream。未登录时照常对话但不读取、不保存记忆；登录时携带 Bearer token 后会使用最近对话记忆。',
          security: [{ BearerAuth: [] }, {}],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['message'],
                  properties: {
                    message: { type: 'string', example: '帮我规划杭州两天轻松路线' },
                    conversationId: { type: 'string', example: 'default' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'SSE 流式响应', content: { 'text/event-stream': { schema: { type: 'string' } } } },
            400: { description: '参数错误' },
            401: { description: 'token 无效' },
          },
        },
      },
    },
  },
  apis: [],
});
