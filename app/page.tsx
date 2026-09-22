const ENDPOINT_GROUPS = [
  { title: '系统', items: ['POST /api/heartbeat'] },
  {
    title: '鉴权',
    items: ['POST /api/auth/login'],
  },
  {
    title: '运营',
    items: [
      '/api/admin/knowledge-bases',
      '/api/admin/documents',
      '/api/admin/suggested-questions',
      '/api/admin/retrieval-debug',
      '/api/admin/audit-logs',
      '/api/admin/evaluations',
      '/api/admin/projects',
    ],
  },
  { title: '公开项目', items: ['/api/public/projects/{projectId}'] },
  { title: '平台 Agent', items: ['POST /api/platform/agent/chat'] },
  { title: 'RAG 兼容', items: ['GET /api/rag/tools', 'GET /api/rag/skills', 'POST /api/rag/chat'] },
];

export default function Home() {
  return (
    <main style={{ padding: 32, maxWidth: 880, margin: '0 auto', lineHeight: 1.7 }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Travel RAG Platform</h1>
      <p style={{ color: '#555', marginTop: 0 }}>
        Next.js App Router 服务端。OpenAPI 描述见 <a href="/api-docs.json">/api-docs.json</a>，交互式文档见{' '}
        <a href="/api-docs">/api-docs</a>。
      </p>
      {ENDPOINT_GROUPS.map((group) => (
        <section key={group.title} style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>{group.title}</h2>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {group.items.map((item) => (
              <li key={item}>
                <code style={{ fontSize: 13 }}>{item}</code>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
