# Travel Server 前端对接文档

## 1. 基础信息

后端本地地址：

```txt
http://localhost:3000
```

Swagger 在线文档：

```txt
http://localhost:3000/api-docs
```

Apifox OpenAPI 导入地址：

```txt
http://localhost:3000/api-docs.json
```

## 2. 登录态约定

登录和注册成功后，后端会返回 `token`。

前端需要保存 token，并在需要登录的接口中携带：

```http
Authorization: Bearer <token>
```

建议前端保存：

```js
localStorage.setItem('token', token)
localStorage.setItem('user', JSON.stringify(user))
```

遇到 `401` 时，表示未登录、token 失效或账号不可用，前端应清理登录态并跳转登录页。

## 3. 用户注册

```http
POST /api/auth/register
Content-Type: application/json
```

请求体：

```json
{
  "email": "user@example.com",
  "username": "travel_user",
  "password": "12345678",
  "nickname": "旅行用户"
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `email` | 是 | 邮箱，唯一 |
| `username` | 否 | 用户名，唯一，仅支持字母、数字、下划线，长度 3-32 位 |
| `password` | 是 | 密码，长度 8-64 位 |
| `nickname` | 否 | 昵称 |

成功响应：

```json
{
  "success": true,
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "username": "travel_user",
    "nickname": "旅行用户",
    "avatarUrl": null,
    "role": "user",
    "status": "active",
    "lastLoginAt": null,
    "createdAt": "2026-07-14T00:00:00.000Z",
    "updatedAt": "2026-07-14T00:00:00.000Z"
  },
  "token": "token"
}
```

失败响应：

```json
{
  "success": false,
  "error": "邮箱或用户名已被注册"
}
```

## 4. 用户登录

```http
POST /api/auth/login
Content-Type: application/json
```

请求体：

```json
{
  "account": "user@example.com",
  "password": "12345678"
}
```

说明：

- `account` 可以传邮箱或用户名。
- 也可以传 `email` 字段代替 `account`。

成功响应：

```json
{
  "success": true,
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "username": "travel_user",
    "nickname": "旅行用户",
    "avatarUrl": null,
    "role": "user",
    "status": "active",
    "lastLoginAt": "2026-07-14T00:00:00.000Z",
    "createdAt": "2026-07-14T00:00:00.000Z",
    "updatedAt": "2026-07-14T00:00:00.000Z"
  },
  "token": "token"
}
```

失败响应：

```json
{
  "success": false,
  "error": "账号或密码错误"
}
```

## 5. 获取当前用户

用于刷新页面后恢复登录状态。

```http
GET /api/auth/me
Authorization: Bearer <token>
```

成功响应：

```json
{
  "success": true,
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "username": "travel_user",
    "nickname": "旅行用户",
    "avatarUrl": null,
    "role": "user",
    "status": "active",
    "lastLoginAt": "2026-07-14T00:00:00.000Z",
    "createdAt": "2026-07-14T00:00:00.000Z",
    "updatedAt": "2026-07-14T00:00:00.000Z"
  }
}
```

## 6. 退出登录

```http
POST /api/auth/logout
Authorization: Bearer <token>
```

响应：

```json
{
  "success": true,
  "message": "已退出登录"
}
```

当前 token 是无状态 token，退出登录主要由前端删除本地 token 完成。

## 7. 收藏功能

收藏功能必须登录。未登录调用会返回 `401`。

### 7.1 获取收藏列表

```http
GET /api/favorites?limit=20&offset=0
Authorization: Bearer <token>
```

查询参数：

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `limit` | 否 | 20 | 每页条数，范围 1-100 |
| `offset` | 否 | 0 | 偏移量 |

成功响应：

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "userId": "uuid",
      "targetType": "travel_plan",
      "targetId": "plan_001",
      "title": "杭州西湖半日路线",
      "content": "上午西湖，下午灵隐寺...",
      "metadata": {
        "city": "杭州"
      },
      "createdAt": "2026-07-14T00:00:00.000Z",
      "updatedAt": "2026-07-14T00:00:00.000Z"
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0
  }
}
```

### 7.2 新增或更新收藏

```http
POST /api/favorites
Authorization: Bearer <token>
Content-Type: application/json
```

请求体：

```json
{
  "targetType": "travel_plan",
  "targetId": "plan_001",
  "title": "杭州西湖半日路线",
  "content": "上午西湖，下午灵隐寺...",
  "metadata": {
    "city": "杭州",
    "days": 1
  }
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `targetType` | 否 | 收藏类型，默认 `travel_plan` |
| `targetId` | 否 | 业务对象 ID；有值时，同一用户同类型同 ID 会更新已有收藏 |
| `title` | 是 | 收藏标题 |
| `content` | 否 | 收藏正文 |
| `metadata` | 否 | 前端可自由扩展的 JSON 信息 |

成功响应：

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "userId": "uuid",
    "targetType": "travel_plan",
    "targetId": "plan_001",
    "title": "杭州西湖半日路线",
    "content": "上午西湖，下午灵隐寺...",
    "metadata": {
      "city": "杭州",
      "days": 1
    },
    "createdAt": "2026-07-14T00:00:00.000Z",
    "updatedAt": "2026-07-14T00:00:00.000Z"
  }
}
```

### 7.3 删除收藏

```http
DELETE /api/favorites/{id}
Authorization: Bearer <token>
```

成功响应：

```json
{
  "success": true,
  "id": "uuid"
}
```

## 8. 旅游流式对话与登录记忆

接口：

```http
POST /api/travel/chat
Content-Type: application/json
Accept: text/event-stream
```

### 8.1 未登录调用

不携带 `Authorization`。

```json
{
  "message": "帮我规划杭州两天轻松路线"
}
```

效果：

- 正常流式对话。
- 不读取历史记忆。
- 不保存本轮问答。

### 8.2 已登录调用

携带 token：

```http
Authorization: Bearer <token>
```

请求体：

```json
{
  "message": "帮我规划杭州两天轻松路线",
  "conversationId": "default"
}
```

效果：

- 后端读取该用户最近几轮对话作为 LangChain messages 上下文。
- 回答完成后保存本轮用户问题和模型回答。
- 不同 `conversationId` 可以隔离不同会话。

### 8.3 SSE 事件格式

当前普通对话接口返回 `text/event-stream`，常见事件数据：

```json
{
  "type": "chunk",
  "content": "可以先安排..."
}
```

完成事件：

```json
{
  "type": "complete",
  "data": {
    "success": true,
    "reply": "完整回答",
    "memory": {
      "enabled": true,
      "conversationId": "default"
    }
  }
}
```

## 9. 记忆管理

记忆接口必须登录。

### 9.1 查询记忆

```http
GET /api/memories?conversationId=default&limit=6
Authorization: Bearer <token>
```

成功响应：

```json
{
  "success": true,
  "conversationId": "default",
  "data": [
    {
      "id": "uuid",
      "conversationId": "default",
      "role": "user",
      "content": "我喜欢轻松路线",
      "metadata": {},
      "createdAt": "2026-07-14T00:00:00.000Z"
    },
    {
      "id": "uuid",
      "conversationId": "default",
      "role": "assistant",
      "content": "已记住你的偏好",
      "metadata": {
        "source": "travel_chat"
      },
      "createdAt": "2026-07-14T00:00:00.000Z"
    }
  ]
}
```

### 9.2 清空记忆

```http
DELETE /api/memories/default
Authorization: Bearer <token>
```

成功响应：

```json
{
  "success": true,
  "conversationId": "default"
}
```

## 10. 前端 Axios 封装建议

建议在 `travel-web` 的 `infra/http.ts` 或统一请求封装里加请求拦截器。

```js
axios.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')

  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }

  return config
})
```

响应拦截器：

```js
axios.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      // 跳转登录页
    }

    return Promise.reject(error)
  }
)
```

## 11. SSE 前端读取建议

`/api/travel/chat` 是流式接口，不建议用普通 Axios 请求。

建议使用 `fetch + ReadableStream`：

```js
async function chatStream({ message, conversationId, token, onChunk, onComplete, onError }) {
  const response = await fetch('http://localhost:3000/api/travel/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      message,
      conversationId,
    }),
  })

  if (!response.ok) {
    throw new Error(`请求失败：${response.status}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const events = buffer.split('\n\n')
    buffer = events.pop() || ''

    for (const eventText of events) {
      const dataLine = eventText
        .split('\n')
        .find((line) => line.startsWith('data: '))

      if (!dataLine) continue

      const payload = JSON.parse(dataLine.slice(6))

      if (payload.type === 'chunk') {
        onChunk?.(payload.content)
      }

      if (payload.type === 'complete') {
        onComplete?.(payload.data)
      }

      if (payload.type === 'error') {
        onError?.(payload.message)
      }
    }
  }
}
```

## 12. Apifox 联调建议

1. 打开 Apifox。
2. 选择导入 OpenAPI。
3. 输入：

```txt
http://localhost:3000/api-docs.json
```

4. 调用登录接口获取 token。
5. 在 Apifox 的认证配置中选择 Bearer Token，填入 token。
6. 再调试收藏、记忆、当前用户等需要登录的接口。

说明：

- Swagger 和 Apifox 适合调试普通 JSON 接口。
- SSE 流式接口可以看参数定义，但完整流式效果建议在前端页面或专门的流式调试工具里验证。

## 13. 常见状态码

| 状态码 | 说明 |
| --- | --- |
| `200` | 请求成功 |
| `201` | 创建成功 |
| `400` | 参数错误或业务校验失败 |
| `401` | 未登录、token 无效或 token 过期 |
| `404` | 资源不存在 |
| `500` | 服务端异常 |

