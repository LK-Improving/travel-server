import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 文档上传走 Route Handler 的 multipart 解析，不依赖 Next.js 内置 body 解析。
  serverExternalPackages: ['pg', 'minio', 'bullmq', 'ioredis', '@zilliz/milvus2-sdk-node', 'exceljs', 'mammoth'],
  outputFileTracingIncludes: {
    '/api/**/*': ['./migrations/**/*'],
  },
};

export default nextConfig;
