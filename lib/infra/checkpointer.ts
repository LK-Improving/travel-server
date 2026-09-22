// LangGraph Postgres checkpoint（与 Python 版共用同一套 checkpoint 表）。
// @langchain/langgraph-checkpoint-postgres v1.0.5 与 Python langgraph-checkpoint-postgres 表结构兼容。
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { authDatabaseUrl } from '../config';

let saverPromise: Promise<PostgresSaver> | null = null;

export function getCheckpointer(): Promise<PostgresSaver> {
  if (!saverPromise) {
    saverPromise = (async () => {
      // 与业务库同源：复用 authDatabaseUrl（AUTH_DB_URL > PG_URL > DATABASE_URL），
      // 保证 Agent checkpoint 与会话数据在同一事务边界内可对齐。
      const saver = PostgresSaver.fromConnString(authDatabaseUrl());
      await saver.setup();
      return saver;
    })();
  }
  return saverPromise;
}
