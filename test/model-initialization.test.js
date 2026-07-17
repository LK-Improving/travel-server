import assert from 'node:assert/strict';
import test from 'node:test';
import RagServer from '../src/services/ragServer.js';
import TravelAgentServer from '../src/services/travelAgentServer.js';
import TravelServer from '../src/services/travelServer.js';

function createStreamCollector() {
  const events = [];

  return {
    events,
    send(type, data) {
      events.push({ type, data });
    },
    isAborted() {
      return false;
    },
  };
}

function createFakeLlm(reply) {
  return {
    async *stream() {
      yield { content: reply };
    },
    async invoke() {
      return {
        content: JSON.stringify({
          toolCalls: [
            {
              name: 'search_poi',
              arguments: { city: '杭州', limit: 1 },
            },
          ],
        }),
      };
    },
  };
}

test('RAG chat initializes the LLM through TravelServer before streaming', async (t) => {
  const originalSearch = RagServer.searchWithFallback;
  const originalGetLLM = TravelServer.getLLM;
  const originalLLM = TravelServer.llm;
  const fakeLlm = createFakeLlm('RAG 回答');

  t.after(() => {
    RagServer.searchWithFallback = originalSearch;
    TravelServer.getLLM = originalGetLLM;
    TravelServer.llm = originalLLM;
  });

  RagServer.searchWithFallback = async () => ({
    data: [],
    fallback: false,
    message: '',
  });
  TravelServer.llm = null;
  TravelServer.getLLM = () => fakeLlm;

  const chunks = [];
  const result = await RagServer.chat('帮我规划西湖路线', {}, (chunk) => chunks.push(chunk));

  assert.equal(result.success, true);
  assert.equal(result.reply, 'RAG 回答');
  assert.deepEqual(chunks, ['RAG 回答']);
});

test('Agent chat initializes the LLM through TravelServer before planning and streaming', async (t) => {
  const originalGetLLM = TravelServer.getLLM;
  const originalLLM = TravelServer.llm;
  const fakeLlm = createFakeLlm('Agent 回答');

  t.after(() => {
    TravelServer.getLLM = originalGetLLM;
    TravelServer.llm = originalLLM;
  });

  TravelServer.llm = null;
  TravelServer.getLLM = () => fakeLlm;

  const stream = createStreamCollector();
  const result = await TravelAgentServer.chat({ message: '杭州怎么玩' }, stream);

  assert.equal(result.success, true);
  assert.equal(result.reply, 'Agent 回答');
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(
    stream.events.filter((event) => event.type === 'chunk').map((event) => event.data.content),
    ['Agent 回答'],
  );
});
