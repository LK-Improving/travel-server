import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

function runServerlessHealthCheck() {
  const script = `
    import app from './api/index.js';
    const server = app.listen(0, async () => {
      const { port } = server.address();
      const response = await fetch('http://127.0.0.1:' + port + '/api/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      console.log(response.status);
      server.close();
    });
  `;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MODEL_PROVIDE: '',
        DEEPSEEK_API_KEY: '',
        DEEPSEEK_BASE_URL: '',
        DEEPSEEK_MODEL: '',
        GJLD_API_KEY: '',
        GJLD_BASE_URL: '',
        GJLD_MODEL: '',
        XIAOMI_API_KEY: '',
        XIAOMI_BASE_URL: '',
        XIAOMI_MODEL: '',
      },
    });
    let output = '';

    child.stdout.on('data', (chunk) => {
      output += chunk;
    });

    child.on('close', (code) => {
      resolve({ code, output });
    });
  });
}

test('serverless entry starts health check without model credentials', async () => {
  const result = await runServerlessHealthCheck();

  assert.equal(result.code, 0);
  assert.match(result.output, /200/);
});

test('untrusted origin receives no CORS permission', async () => {
  const { default: app } = await import('../api/index.js');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/heartbeat`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://untrusted.example',
        'Access-Control-Request-Method': 'POST',
      },
    });

    assert.equal(response.ok, true);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  } finally {
    server.close();
  }
});
