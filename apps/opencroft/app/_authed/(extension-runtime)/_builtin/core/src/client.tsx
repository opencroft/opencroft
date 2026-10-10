import type { AppComponentProps } from '@opencroft/client/app'
import { GraphCanvas } from '@opencroft/client/canvas'
import { defineExtension } from '@opencroft/client/extension'

// The Graph App's client half is ONE host component: the same canvas surface
// the space's own page draws, pointed at this instance's graph. No defensive
// read -- this bundle ships with the host that exposes it, always in sync.
function GraphAppView({ instanceId }: AppComponentProps) {
  return <GraphCanvas instanceId={instanceId} />
}

import { linkResolver, mentionResolver, terminalResolver } from './markdown-resolvers'
import { AgentInspector, AgentNode, AgentProfileTab } from './nodes/agent'
import { AgentSpeechRecognitionTab } from './nodes/agent-asr'
import { AgentInstructionInspector, AgentInstructionNode } from './nodes/agent-instruction'
import { AgentMcpTab } from './nodes/agent-mcp'
import { AgentSkillsTab } from './nodes/agent-skills'
import { AgentSpeechTab } from './nodes/agent-speech'
import { AgentTokensTab } from './nodes/agent-tokens'
import { AGENT_TOOL_HANDLES, AgentToolInspector, AgentToolNode, agentToolExposeOutput } from './nodes/agent-tool'
import { API_ROUTE_HANDLES, ApiRouteInspector, ApiRouteNode, apiRouteExposeOutput } from './nodes/api-route'
import { EVENT_HANDLES, EventInspector, EventNode, eventExposeOutput } from './nodes/event'
import { KeyStoreInspector, KeyStoreNode } from './nodes/key-store'
import { LocalhostFilesTab, LocalhostInspector, LocalhostNode, LocalhostTerminalTab } from './nodes/localhost'
import { LOG_HANDLES, LogInspector, LogNode } from './nodes/log'
import { OpenAIAssistantInspector, OpenAIAssistantNode } from './nodes/openai-assistant'
import { OpenAIClientInspector, OpenAIClientNode } from './nodes/openai-client'
import { PROMPT_HANDLES, PromptInspector, PromptNode, promptExposeOutput } from './nodes/prompt'
import { makeBashNode, makeNodeJsNode, makePythonNode, scriptExposeOutput } from './nodes/script'
import { SecretsStoreInspector, SecretsStoreNode } from './nodes/secrets-store'
import { randomSectionColor, SectionInspector, SectionNode } from './nodes/section'
import { SEND_MESSAGE_HANDLES, SendMessageInspector, SendMessageNode } from './nodes/send-message'
import { type ServerData, ServerFilesTab, ServerInspector, ServerNode, ServerTerminalTab } from './nodes/server'
import { TerminalWindowInspector, TerminalWindowNode } from './nodes/terminal'
import {
  TERMINAL_ROUTER_HANDLES,
  TerminalRouterInspector,
  TerminalRouterNode,
  TerminalRouterTerminalTab,
  terminalRouterExposeOutput,
} from './nodes/terminal-router'
import {
  TEXT_GENERATION_HANDLES,
  TextGenerationInspector,
  TextGenerationNode,
  textGenerationExposeOutput,
} from './nodes/text-generation'
import { type WslData, WslFilesTab, WslInspector, WslNode, WslTerminalTab } from './nodes/wsl'
import { AGENT_HANDLES, AGENT_INSTRUCTION_HANDLES, SCRIPT_CONSUMER, TERMINAL_CONSUMER, TERMINAL_SOURCE } from './shared'

export default defineExtension({
  manifest: {
    name: 'Core',
    version: '1.0.0',
    description: 'Core node catalog — infrastructure + storage + windows',
  },
  handleTypes: [
    { id: 'terminal-context', label: 'Terminal Context', color: 'oklch(0.7 0.18 300)' },
    { id: 'filesystem-target', label: 'Filesystem Target', color: 'oklch(0.7 0.17 140)' },
    { id: 'text-stream', label: 'Text Stream', color: 'oklch(0.75 0.17 100)' },
    { id: 'execution-context', label: 'Execution Context', color: 'oklch(0.65 0.24 25)' },
    { id: 'agent-instruction', label: 'Agent Instruction', color: 'oklch(0.72 0.16 180)' },
  ],
  // The HOST-registered Graph App: metadata and parameters live in
  // extension.json (the server reads provides from the manifest), the server
  // hooks are host code (see the apps runtime's hostAppHooks), and only the
  // component ships from here.
  provides: {
    apps: [
      {
        type: 'graph',
        title: 'Graph',
        description: 'A node graph canvas — one instance per graph in a space.',
        icon: 'Workflow',
        component: GraphAppView,
      },
    ],
    markdownResolvers: [terminalResolver, linkResolver, mentionResolver],
  },
  nodes: [
    {
      type: 'localhost',
      name: 'Localhost',
      category: 'Infrastructure',
      icon: 'Monitor',
      accent: 'oklch(0.7 0.18 300)',
      handles: TERMINAL_SOURCE,
      defaultData: {},
      component: LocalhostNode,
      inspector: LocalhostInspector,
      inspectorTabs: [
        {
          id: 'terminal',
          label: 'Terminal',
          icon: 'TerminalSquare',
          fullHeight: true,
          component: LocalhostTerminalTab,
        },
        {
          id: 'files',
          label: 'Files',
          icon: 'FolderOpen',
          fullHeight: true,
          component: LocalhostFilesTab,
        },
      ],
      exposeOutput: (handleId: string) => {
        if (handleId === 'terminal') {
          return { type: 'local' }
        }
        return undefined
      },
    },
    {
      type: 'wsl',
      name: 'WSL',
      category: 'Infrastructure',
      icon: 'SquareTerminal',
      accent: 'oklch(0.7 0.18 300)',
      handles: TERMINAL_SOURCE,
      defaultData: { distro: 'Ubuntu' },
      component: WslNode,
      inspector: WslInspector,
      inspectorTabs: [
        {
          id: 'terminal',
          label: 'Terminal',
          icon: 'TerminalSquare',
          fullHeight: true,
          component: WslTerminalTab,
        },
        {
          id: 'files',
          label: 'Files',
          icon: 'FolderOpen',
          fullHeight: true,
          component: WslFilesTab,
        },
      ],
      exposeOutput: (handleId: string, data: unknown) => {
        const d = data as WslData
        if (!d.distro) {
          return undefined
        }
        if (handleId === 'terminal') {
          return { type: 'wsl', distro: d.distro }
        }
        return undefined
      },
    },
    {
      type: 'server',
      name: 'Server',
      category: 'Infrastructure',
      icon: 'Server',
      accent: 'oklch(0.7 0.18 300)',
      handles: TERMINAL_SOURCE,
      defaultData: { name: '', address: '', username: 'root', port: 22 },
      component: ServerNode,
      inspector: ServerInspector,
      inspectorTabs: [
        {
          id: 'terminal',
          label: 'Terminal',
          icon: 'TerminalSquare',
          fullHeight: true,
          component: ServerTerminalTab,
        },
        {
          id: 'files',
          label: 'Files',
          icon: 'FolderOpen',
          fullHeight: true,
          component: ServerFilesTab,
        },
      ],
      exposeOutput: (handleId: string, data: unknown) => {
        const d = data as ServerData
        if (!d.address) {
          return undefined
        }
        if (handleId === 'terminal') {
          return {
            type: 'ssh',
            host: d.address,
            port: d.port,
            username: d.username,
            password: d.password,
            keyPath: d.keyPath,
          }
        }
        return undefined
      },
    },
    {
      type: 'terminal-router',
      name: 'Terminal Router',
      category: 'Infrastructure',
      icon: 'Split',
      accent: 'oklch(0.7 0.18 300)',
      handles: TERMINAL_ROUTER_HANDLES,
      defaultData: { routes: [] },
      component: TerminalRouterNode,
      inspector: TerminalRouterInspector,
      inspectorTabs: [
        {
          id: 'terminal',
          label: 'Terminal',
          icon: 'TerminalSquare',
          fullHeight: true,
          // Its shell ends when the inspector closes, not when another tab is picked.
          keepMounted: true,
          component: TerminalRouterTerminalTab,
        },
      ],
      exposeOutput: terminalRouterExposeOutput,
    },
    {
      type: 'core-key-store',
      name: 'Key Store',
      category: 'Storage',
      icon: 'KeyRound',
      accent: 'oklch(0.8 0.15 80)',
      handles: [],
      defaultData: { keyNames: [] },
      component: KeyStoreNode,
      inspector: KeyStoreInspector,
    },
    {
      type: 'core-secrets-store',
      name: 'Secrets Store',
      category: 'Storage',
      icon: 'ShieldCheck',
      accent: 'oklch(0.75 0.18 160)',
      handles: [],
      defaultData: { secretKeys: [] },
      component: SecretsStoreNode,
      inspector: SecretsStoreInspector,
    },
    {
      type: 'terminal',
      name: 'Terminal Window',
      category: 'Windows',
      icon: 'TerminalSquare',
      accent: 'oklch(0.7 0.17 240)',
      handles: TERMINAL_CONSUMER,
      defaultData: { title: 'Terminal' },
      component: TerminalWindowNode,
      inspector: TerminalWindowInspector,
    },
    {
      type: 'script-bash',
      name: 'Bash Script',
      category: 'Scripts',
      icon: 'TerminalSquare',
      accent: 'oklch(0.7 0.18 60)',
      handles: SCRIPT_CONSUMER,
      defaultData: { script: '', language: 'bash', env: '', secrets: '' },
      component: makeBashNode().component,
      inspector: makeBashNode().inspector,
      inspectorTabs: [
        {
          id: 'editor',
          label: 'Editor',
          icon: 'Code',
          fullHeight: true,
          component: makeBashNode().editorTab,
        },
        {
          id: 'output',
          label: 'Output',
          icon: 'ScrollText',
          fullHeight: true,
          component: makeBashNode().outputTab,
        },
      ],
      exposeOutput: scriptExposeOutput,
    },
    {
      type: 'script-python',
      name: 'Python Script',
      category: 'Scripts',
      icon: 'Code',
      accent: 'oklch(0.6 0.18 260)',
      handles: SCRIPT_CONSUMER,
      defaultData: { script: '', language: 'python', env: '', secrets: '' },
      component: makePythonNode().component,
      inspector: makePythonNode().inspector,
      inspectorTabs: [
        {
          id: 'editor',
          label: 'Editor',
          icon: 'Code',
          fullHeight: true,
          component: makePythonNode().editorTab,
        },
        {
          id: 'output',
          label: 'Output',
          icon: 'ScrollText',
          fullHeight: true,
          component: makePythonNode().outputTab,
        },
      ],
      exposeOutput: scriptExposeOutput,
    },
    {
      type: 'script-node',
      name: 'Node.js Script',
      category: 'Scripts',
      icon: 'Braces',
      accent: 'oklch(0.65 0.2 150)',
      handles: SCRIPT_CONSUMER,
      defaultData: { script: '', language: 'node', env: '', secrets: '' },
      component: makeNodeJsNode().component,
      inspector: makeNodeJsNode().inspector,
      inspectorTabs: [
        {
          id: 'editor',
          label: 'Editor',
          icon: 'Code',
          fullHeight: true,
          component: makeNodeJsNode().editorTab,
        },
        {
          id: 'output',
          label: 'Output',
          icon: 'ScrollText',
          fullHeight: true,
          component: makeNodeJsNode().outputTab,
        },
      ],
      exposeOutput: scriptExposeOutput,
    },
    {
      type: 'agent',
      name: 'Agent',
      category: 'AI',
      icon: 'User',
      accent: 'oklch(0.65 0.24 25)',
      handles: AGENT_HANDLES,
      defaultData: { name: '' },
      component: AgentNode,
      inspector: AgentInspector,
      inspectorTabs: [
        {
          id: 'profile',
          label: 'Profile',
          icon: 'Bot',
          fullHeight: true,
          component: AgentProfileTab,
        },
        {
          id: 'tts',
          label: 'TTS',
          icon: 'Speech',
          fullHeight: true,
          component: AgentSpeechTab,
        },
        {
          id: 'asr',
          label: 'ASR',
          icon: 'Ear',
          fullHeight: true,
          component: AgentSpeechRecognitionTab,
        },
        { id: 'mcp', label: 'MCP', icon: 'Wrench', fullHeight: true, component: AgentMcpTab },
        {
          id: 'tokens',
          label: 'Tokens',
          icon: 'KeyRound',
          fullHeight: true,
          component: AgentTokensTab,
        },
        {
          id: 'skills',
          label: 'Skills',
          icon: 'Sparkles',
          fullHeight: true,
          component: AgentSkillsTab,
        },
      ],
    },
    {
      type: 'agent-instruction',
      name: 'Agent Instruction',
      category: 'AI',
      icon: 'BookOpen',
      accent: 'oklch(0.72 0.16 180)',
      handles: AGENT_INSTRUCTION_HANDLES,
      defaultData: { name: '', instruction: '' },
      component: AgentInstructionNode,
      inspector: AgentInstructionInspector,
    },
    {
      type: 'openai-client',
      name: 'OpenAI Client',
      category: 'Text',
      icon: 'Sparkles',
      accent: 'oklch(0.75 0.17 100)',
      handles: [],
      defaultData: {
        assistantId: '',
        systemPrompt: '',
        userPrompt: '',
      },
      component: OpenAIClientNode,
      inspector: OpenAIClientInspector,
    },
    {
      type: 'openai-assistant',
      name: 'AI Assistant',
      category: 'AI',
      icon: 'UserRound',
      accent: 'oklch(0.75 0.16 100)',
      handles: [],
      defaultData: {
        name: 'Assistant',
        chatApiBase: 'https://api.openai.com/v1',
        chatApiKey: '',
        chatModel: 'gpt-4o-mini',
        temperature: 0.7,
      },
      component: OpenAIAssistantNode,
      inspector: OpenAIAssistantInspector,
    },
    {
      type: 'prompt',
      name: 'Prompt',
      category: 'Text',
      icon: 'MessageCircle',
      accent: 'oklch(0.75 0.17 100)',
      handles: PROMPT_HANDLES,
      defaultData: { text: '' },
      component: PromptNode,
      inspector: PromptInspector,
      exposeOutput: promptExposeOutput,
    },
    {
      type: 'text-generation',
      name: 'Text Generation',
      category: 'Text',
      icon: 'Sparkles',
      accent: 'oklch(0.75 0.17 100)',
      handles: TEXT_GENERATION_HANDLES,
      defaultData: { assistantId: '', systemPrompt: '' },
      component: TextGenerationNode,
      inspector: TextGenerationInspector,
      exposeOutput: textGenerationExposeOutput,
    },
    {
      type: 'log',
      name: 'Log',
      category: 'Text',
      icon: 'ScrollText',
      accent: 'oklch(0.75 0.17 100)',
      handles: LOG_HANDLES,
      defaultData: { max: 500, entries: [] },
      component: LogNode,
      inspector: LogInspector,
    },
    {
      type: 'send-message',
      name: 'Send Message',
      category: 'Text',
      icon: 'Send',
      accent: 'oklch(0.75 0.17 100)',
      handles: SEND_MESSAGE_HANDLES,
      defaultData: {},
      component: SendMessageNode,
      inspector: SendMessageInspector,
    },
    {
      type: 'api-route',
      name: 'API Route',
      category: 'Infrastructure',
      icon: 'Route',
      accent: 'oklch(0.65 0.24 25)',
      handles: API_ROUTE_HANDLES,
      defaultData: { path: '/', methods: ['GET'] },
      component: ApiRouteNode,
      inspector: ApiRouteInspector,
      exposeOutput: apiRouteExposeOutput,
    },
    {
      type: 'agent-tool',
      name: 'Agent Tool',
      category: 'Integration',
      icon: 'Wrench',
      accent: 'oklch(0.65 0.24 25)',
      handles: AGENT_TOOL_HANDLES,
      defaultData: {
        name: '',
        description: '',
        inputSchema: '{"type":"object","properties":{}}',
        requireApproval: true,
      },
      component: AgentToolNode,
      inspector: AgentToolInspector,
      exposeOutput: agentToolExposeOutput,
    },
    {
      type: 'event',
      name: 'Event',
      category: 'Integration',
      icon: 'AlarmClock',
      accent: 'oklch(0.65 0.24 25)',
      handles: EVENT_HANDLES,
      defaultData: {
        schedules: [],
        runHistory: [],
      },
      component: EventNode,
      inspector: EventInspector,
      exposeOutput: eventExposeOutput,
    },
    {
      type: 'section',
      name: 'Section',
      category: 'Organization',
      icon: 'Boxes',
      accent: 'oklch(0.6 0.15 250)',
      handles: [],
      defaultData: { label: 'Section', color: randomSectionColor() },
      component: SectionNode,
      inspector: SectionInspector,
    },
  ],
})
