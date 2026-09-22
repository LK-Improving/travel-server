import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Travel RAG Platform',
  description: '智能旅行 RAG 平台服务端',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, "Microsoft YaHei", sans-serif' }}>
        {children}
      </body>
    </html>
  );
}
