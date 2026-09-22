import { route, successResponse } from '@/lib/http';

/** 健康检查。Python 版内联在 main.py，语义保持一致。 */
export const POST = route(async () => successResponse({ code: 200, msg: '服务正常启动', timestamp: Date.now() }));

export const GET = POST;
