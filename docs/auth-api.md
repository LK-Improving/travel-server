# 用户登录体系前端对接文档

## 1. 接口概览

后端新增认证路由前缀：

```txt
/api/auth
```

当前实现采用账号密码登录，后端使用 PostgreSQL 保存用户资料和密码哈希。登录或注册成功后返回 Bearer token，前端后续请求在 Header 中携带：

```http
Authorization: Bearer <token>
```

## 2. 用户表

表名：`travel_users`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | UUID | 用户 ID，主键 |
| `email` | VARCHAR(255) | 邮箱，唯一 |
| `username` | VARCHAR(32) | 用户名，唯一，可为空 |
| `password_hash` | TEXT | 密码哈希，前端不展示 |
| `nickname` | VARCHAR(64) | 昵称 |
| `avatar_url` | TEXT | 头像地址 |
| `role` | VARCHAR(32) | `user` 或 `admin` |
| `status` | VARCHAR(16) | `active`、`disabled`、`locked` |
| `last_login_at` | TIMESTAMPTZ | 最近登录时间 |
| `created_at` | TIMESTAMPTZ | 创建时间 |
| `updated_at` | TIMESTAMPTZ | 更新时间 |

## 3. 注册

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
  "token": "jwt-like-token"
}
```

失败响应：

```json
{
  "success": false,
  "error": "邮箱或用户名已被注册"
}
```

## 4. 登录

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

`account` 可以传邮箱或用户名。也可以传 `email` 字段代替 `account`。

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
  "token": "jwt-like-token"
}
```

## 5. 获取当前用户

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

未登录或 token 无效：

```json
{
  "success": false,
  "error": "认证 token 已过期"
}
```

## 6. 退出登录

```http
POST /api/auth/logout
Authorization: Bearer <token>
```

当前 token 是无状态签名 token，退出登录由前端删除本地 token 完成。后端接口用于统一前端流程。

## 7. 前端接入建议

1. 登录成功后保存 `token`，例如 Pinia/Redux + localStorage。
2. Axios 请求拦截器统一追加：

```js
config.headers.Authorization = `Bearer ${token}`;
```

3. 响应拦截器遇到 `401` 时清理 token 并跳转登录页。
4. 注册和登录页面只展示 `error` 字段，不展示内部异常堆栈。

## 8. Swagger / 在线联调建议

已接入 Swagger：

```txt
http://localhost:3000/api-docs
```

Apifox 可以通过 OpenAPI JSON 导入：

```txt
http://localhost:3000/api-docs.json
```

Swagger 适合调试注册、登录、收藏、记忆这类 JSON 接口。SSE 流式接口可以在 Swagger 中查看参数和事件协议说明，但完整流式效果建议用前端页面、Postman、Apifox 或 fetch reader 联调。

## 9. 收藏接口

收藏功能必须登录，未携带 token 或 token 无效时返回 `401`。

### 获取收藏列表

```http
GET /api/favorites?limit=20&offset=0
Authorization: Bearer <token>
```

### 新增收藏

```http
POST /api/favorites
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "targetType": "travel_plan",
  "targetId": "plan_001",
  "title": "杭州西湖半日路线",
  "content": "上午西湖，下午灵隐寺...",
  "metadata": {
    "city": "杭州"
  }
}
```

### 删除收藏

```http
DELETE /api/favorites/{id}
Authorization: Bearer <token>
```

## 10. 登录态记忆

`POST /api/travel/chat` 支持可选登录态：

- 未登录：原有流式对话照常使用，不读取、不保存记忆。
- 已登录：请求头携带 `Authorization: Bearer <token>` 后，后端读取该用户最近几轮对话作为 LangChain messages 上下文，并在回答完成后保存本轮问答。

请求体可以增加 `conversationId`，用于区分不同会话：

```json
{
  "message": "帮我规划杭州两天轻松路线",
  "conversationId": "default"
}
```

查询记忆：

```http
GET /api/memories?conversationId=default&limit=6
Authorization: Bearer <token>
```

清空记忆：

```http
DELETE /api/memories/default
Authorization: Bearer <token>
```
