// [AUMFE-ASTRO-CLIENT-1] Public API of the AstrologyAPI connector (REST + cache + geo + MCP).
export { astroCall, ASTRO_HOSTS, type AstroOpts, type AstroResult, type AstroHost } from "./client";
export { cachePurgeExpired, nextIstMidnight, type AstroTtl } from "./cache";
export { geoLookup, tzoneFor, type GeoPlace } from "./geo";
export { mcpListTools, mcpCallTool, toGeminiFunctionDeclarations, toGeminiSchema, type McpTool } from "./mcp";
export { ASTRO_ENDPOINTS, SUN_SIGNS, type AstroEndpoint, type AstroEndpointKey, type NatalBody } from "./endpoints";
