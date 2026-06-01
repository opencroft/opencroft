export interface AgentToolData {
  name: string;
  description: string;
  inputSchema: string;    // JSON Schema as string
  requireApproval: boolean;
}
