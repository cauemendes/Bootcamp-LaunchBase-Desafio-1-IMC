#!/usr/bin/env node
/**
 * Entrada do servidor MCP.
 *
 * Transporte stdio: o Claude Code sobe este processo e conversa por stdin/stdout.
 * Nada pode ser escrito em stdout além do protocolo — por isso todo log vai para
 * stderr, que o Claude Code mostra separado.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Bridge } from "../src/bridge.js";
import { createServer } from "../src/server.js";

const bridge = new Bridge();

// Restos de uma sessão anterior seriam executados assim que o painel abrisse —
// mexendo no projeto sem que ninguém tivesse pedido agora.
const descartados = bridge.cleanup();
if (descartados > 0) {
  console.error(`[vectorize-ae] descartei ${descartados} arquivo(s) de sessão anterior`);
}

console.error(`[vectorize-ae] ponte em ${bridge.dir}`);

const server = createServer({ bridge });
await server.connect(new StdioServerTransport());

console.error("[vectorize-ae] servidor pronto");
