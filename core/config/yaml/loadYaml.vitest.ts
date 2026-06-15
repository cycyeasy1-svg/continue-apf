import {
  AssistantUnrolledNonNullable,
  parseConfigYaml,
  validateConfigYaml,
} from "@continuedev/config-yaml";
import { describe, expect, it } from "vitest";

describe("MCP Server cwd configuration", () => {
  describe("YAML schema validation", () => {
    it("should accept valid MCP server with cwd", () => {
      const config: AssistantUnrolledNonNullable = {
        name: "test-agent",
        version: "1.0.0",
        mcpServers: [
          {
            name: "test-server",
            command: "node",
            args: ["server.js"],
            env: { NODE_ENV: "production" },
            cwd: "/path/to/project",
            connectionTimeout: 5000,
          },
        ],
      };

      const errors = validateConfigYaml(config);
      expect(errors).toHaveLength(0);
    });

    it("should accept MCP server without cwd", () => {
      const config: AssistantUnrolledNonNullable = {
        name: "test-agent",
        version: "1.0.0",
        mcpServers: [
          {
            name: "test-server",
            command: "python",
            args: ["-m", "server"],
          },
        ],
      };

      const errors = validateConfigYaml(config);
      expect(errors).toHaveLength(0);
    });

    it("should accept relative paths in cwd", () => {
      const config: AssistantUnrolledNonNullable = {
        name: "test-agent",
        version: "1.0.0",
        mcpServers: [
          {
            name: "test-server",
            command: "cargo",
            args: ["run"],
            cwd: "./rust-project",
          },
        ],
      };

      const errors = validateConfigYaml(config);
      expect(errors).toHaveLength(0);
    });

    it("should accept empty string cwd", () => {
      const config: AssistantUnrolledNonNullable = {
        name: "test-agent",
        version: "1.0.0",
        mcpServers: [
          {
            name: "test-server",
            command: "deno",
            args: ["run", "server.ts"],
            cwd: "",
          },
        ],
      };

      const errors = validateConfigYaml(config);
      expect(errors).toHaveLength(0);
    });
  });

  describe("MCP server configuration examples", () => {
    it("should support common MCP server patterns with cwd", () => {
      const configs = [
        {
          name: "Local project MCP server",
          server: {
            name: "project-mcp",
            command: "npm",
            args: ["run", "mcp-server"],
            cwd: "/Users/developer/my-project",
          },
        },
        {
          name: "Python MCP with virtual environment",
          server: {
            name: "python-mcp",
            command: "python",
            args: ["-m", "my_mcp_server"],
            env: { PYTHONPATH: "./src" },
            cwd: "/home/user/python-project",
          },
        },
        {
          name: "Relative path MCP server",
          server: {
            name: "relative-mcp",
            command: "node",
            args: ["index.js"],
            cwd: "../mcp-servers/filesystem",
          },
        },
      ];

      configs.forEach(({ name, server }) => {
        const config: AssistantUnrolledNonNullable = {
          name: "test-agent",
          version: "1.0.0",
          mcpServers: [server],
        };

        const errors = validateConfigYaml(config);
        expect(errors).toHaveLength(0);
      });
    });
  });
});

describe("Top-level tabAutocompleteModel", () => {
  it("should preserve a single top-level tabAutocompleteModel when parsing YAML", () => {
    const yaml = [
      "name: test-agent",
      'version: "1.0.0"',
      "tabAutocompleteModel:",
      "  provider: gemini",
      "  name: Autocomplete",
      "  model: gemini-3.5-flash",
      '  apiKey: ""',
      "  apiBase: https://example.com/proxy",
    ].join("\n");

    const parsed = parseConfigYaml(yaml);

    // Before the fix this field was stripped by the schema (undefined).
    expect(parsed.tabAutocompleteModel).toBeDefined();
    expect(parsed.tabAutocompleteModel).toMatchObject({
      provider: "gemini",
      name: "Autocomplete",
      model: "gemini-3.5-flash",
    });
  });

  it("should preserve an array of top-level tabAutocompleteModel entries when parsing YAML", () => {
    const yaml = [
      "name: test-agent",
      'version: "1.0.0"',
      "tabAutocompleteModel:",
      "  - provider: gemini",
      "    name: Autocomplete",
      "    model: gemini-3.5-flash",
    ].join("\n");

    const parsed = parseConfigYaml(yaml);

    expect(Array.isArray(parsed.tabAutocompleteModel)).toBe(true);
    expect(parsed.tabAutocompleteModel).toHaveLength(1);
  });
});
