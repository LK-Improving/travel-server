/**
 * 第三方库缺失/未声明的类型补充。
 * pdf-parse 与 mammoth 未随包发布类型声明，这里给出实际用到的最小签名。
 */

declare module 'pdf-parse' {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    text: string;
    version: string;
  }
  function pdfParse(data: Buffer, options?: Record<string, unknown>): Promise<PdfParseResult>;
  export default pdfParse;
}

/**
 * MCP SDK 是可选依赖（高德 MCP 回退路径才用），未安装时运行期 import 会失败并回退 REST。
 * 这里只声明用到的形状，避免未安装就编译不过。
 */
declare module '@modelcontextprotocol/sdk/client/index.js' {
  export class ClientSession {
    constructor(read: unknown, write: unknown);
    initialize(): Promise<void>;
    callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  }
}

declare module '@modelcontextprotocol/sdk/client/streamableHttp.js' {
  export function streamableHttpClient(url: string): Promise<{ read: unknown; write: unknown }>;
}

declare module 'mammoth' {
  export interface MammothMessage {
    type: string;
    message: string;
  }
  export interface MammothResult {
    value: string;
    messages: MammothMessage[];
  }
  export function extractRawText(input: { buffer: Buffer }): Promise<MammothResult>;
  export function convertToHtml(input: { buffer: Buffer }): Promise<MammothResult>;
}
