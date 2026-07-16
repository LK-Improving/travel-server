import { createClient } from "@supabase/supabase-js";
import "dotenv/config.js";

function cleanEnv(value) {
  return typeof value === "string" ? value.trim() : value;
}

let supabaseClient = null;

export function getSupabaseConfig() {
  const url = cleanEnv(process.env.SUPABASE_URL);
  const publishableKey =
    cleanEnv(process.env.SUPABASE_PUBLISHABLE_KEY) ||
    cleanEnv(process.env.SUPABASE_ANON_KEY);

  if (!url || !publishableKey) {
    throw new Error("缺少 SUPABASE_URL 或 SUPABASE_PUBLISHABLE_KEY 配置");
  }

  return {
    url,
    publishableKey,
  };
}

export function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;

  const { url, publishableKey } = getSupabaseConfig();
  supabaseClient = createClient(url, publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return supabaseClient;
}
