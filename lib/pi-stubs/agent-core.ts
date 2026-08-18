export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | (string & {});
export type AgentMessage = any;
export type AgentOptions = any;
export type AgentTool = any;

export class Agent {
  constructor(..._args: any[]) {
    throw new Error("not implemented in foundation");
  }
}
