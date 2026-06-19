import { defineExtension } from '@ext/host'

import { AgentInspector, AgentNode, AgentProfileTab } from './nodes/agent'
import { AgentInstructionInspector, AgentInstructionNode } from './nodes/agent-instruction'
import { AgentJobInspector, AgentJobNode } from './nodes/agent-job'
import { AgentMcpTab } from './nodes/agent-mcp'
import { AGENT_TOOL_HANDLES, AgentToolInspector, AgentToolNode, agentToolExposeOutput } from './nodes/agent-tool'
import { API_ROUTE_HANDLES, ApiRouteInspector, ApiRouteNode, apiRouteExposeOutput } from './nodes/api-route'
import { EVENT_HANDLES, EventInspector, EventNode, eventExposeOutput } from './nodes/event'
import { FileManagerWindowInspector, FileManagerWindowNode } from './nodes/file-manager'
import { KeyStoreInspector, KeyStoreNode } from './nodes/key-store'
import { LocalhostFilesTab, LocalhostInspector, LocalhostNode, LocalhostTerminalTab } from './nodes/localhost'
import { LOG_HANDLES, LogInspector, LogNode, LogOutputTab } from './nodes/log'
import { NetworkInspector, NetworkNode } from './nodes/network'
import { OpenAIAssistantInspector, OpenAIAssistantNode } from './nodes/openai-assistant'
import { OpenAIClientInspector, OpenAIClientNode } from './nodes/openai-client'
import { PROMPT_HANDLES, PromptInspector, PromptNode, promptExposeOutput } from './nodes/prompt'
import { makeBashNode, makeNodeJsNode, makePythonNode, scriptExposeOutput } from './nodes/script'
import { SecretsStoreInspector, SecretsStoreNode } from './nodes/secrets-store'
import { DomainNode, randomSectionColor, SectionInspector, SectionNode } from './nodes/section'
import { SEND_MESSAGE_HANDLES, SendMessageInspector, SendMessageNode } from './nodes/send-message'
import { type ServerData, ServerFilesTab, ServerInspector, ServerNode, ServerTerminalTab } from './nodes/server'
import { TerminalWindowInspector, TerminalWindowNode } from './nodes/terminal'
import {
  TEXT_GENERATION_HANDLES,
  TextGenerationInspector,
  TextGenerationNode,
  textGenerationExposeOutput,
} from './nodes/text-generation'
import { type WslData, WslFilesTab, WslInspector, WslNode, WslTerminalTab } from './nodes/wsl'
import {
  AGENT_HANDLES,
  AGENT_INSTRUCTION_HANDLES,
  AGENT_JOB_HANDLES,
  FS_TARGET_CONSUMER,
  SCRIPT_CONSUMER,
  SCRIPT_CONSUMER_NODEJS,
  SCRIPT_CONSUMER_PYTHON,
  TERMINAL_CONSUMER,
  TERMINAL_SOURCE,
} from './shared'

export default defineExtension({
  manifest: {
    id: 'builtin/core',
    name: 'Core',
    version: '1.0.0',
    description: 'Core node catalog — infrastructure + storage + windows',
  },
  contexts: [
    { id: 'terminal-context', label: 'Terminal Context', color: 'oklch(0.7 0.18 300)' },
    { id: 'filesystem-target', label: 'Filesystem Target', color: 'oklch(0.7 0.17 140)' },
    { id: 'text-stream', label: 'Text Stream', color: 'oklch(0.75 0.17 100)' },
    { id: 'execution-context', label: 'Execution Context', color: 'oklch(0.65 0.24 25)' },
    { id: 'agent-job', label: 'Agent Job', color: 'oklch(0.7 0.17 60)' },
    { id: 'agent-instruction', label: 'Agent Instruction', color: 'oklch(0.72 0.16 180)' },
  ],
  nodes: [
    {
      typeId: 'localhost',
      name: 'Localhost',
      category: 'Infrastructure',
      icon: 'Monitor',
      accent: 'oklch(0.7 0.18 300)',
      handles: TERMINAL_SOURCE as unknown as never[],
      defaultData: {},
      component: LocalhostNode as unknown as never,
      inspector: LocalhostInspector as unknown as never,
      inspectorTabs: [
        {
          id: 'terminal',
          label: 'Terminal',
          icon: 'TerminalSquare',
          fullHeight: true,
          component: LocalhostTerminalTab as unknown as never,
        },
        {
          id: 'files',
          label: 'Files',
          icon: 'FolderOpen',
          fullHeight: true,
          component: LocalhostFilesTab as unknown as never,
        },
      ],
      exposeOutput: (handleId: string) => {
        if (handleId === 'terminal') {
          return { type: 'local' }
        }
        if (handleId === 'fs-out') {
          return { type: 'local' }
        }
        return undefined
      },
    },
    {
      typeId: 'wsl',
      name: 'WSL',
      category: 'Infrastructure',
      icon: 'SquareTerminal',
      accent: 'oklch(0.7 0.18 300)',
      handles: TERMINAL_SOURCE as unknown as never[],
      defaultData: { distro: 'Ubuntu' },
      component: WslNode as unknown as never,
      inspector: WslInspector as unknown as never,
      inspectorTabs: [
        {
          id: 'terminal',
          label: 'Terminal',
          icon: 'TerminalSquare',
          fullHeight: true,
          component: WslTerminalTab as unknown as never,
        },
        {
          id: 'files',
          label: 'Files',
          icon: 'FolderOpen',
          fullHeight: true,
          component: WslFilesTab as unknown as never,
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
        if (handleId === 'fs-out') {
          return { type: 'wsl', distro: d.distro }
        }
        return undefined
      },
    },
    {
      typeId: 'server',
      name: 'Server',
      category: 'Infrastructure',
      icon: 'Server',
      accent: 'oklch(0.7 0.18 300)',
      handles: TERMINAL_SOURCE as unknown as never[],
      defaultData: { name: '', address: '', username: 'root', port: 22 },
      component: ServerNode as unknown as never,
      inspector: ServerInspector as unknown as never,
      inspectorTabs: [
        {
          id: 'terminal',
          label: 'Terminal',
          icon: 'TerminalSquare',
          fullHeight: true,
          component: ServerTerminalTab as unknown as never,
        },
        {
          id: 'files',
          label: 'Files',
          icon: 'FolderOpen',
          fullHeight: true,
          component: ServerFilesTab as unknown as never,
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
        if (handleId === 'fs-out') {
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
      typeId: 'core-key-store',
      name: 'Key Store',
      category: 'Storage',
      icon: 'KeyRound',
      accent: 'oklch(0.8 0.15 80)',
      handles: [],
      defaultData: { keyNames: [] },
      component: KeyStoreNode as unknown as never,
      inspector: KeyStoreInspector as unknown as never,
    },
    {
      typeId: 'core-secrets-store',
      name: 'Secrets Store',
      category: 'Storage',
      icon: 'ShieldCheck',
      accent: 'oklch(0.75 0.18 160)',
      handles: [],
      defaultData: { secretKeys: [] },
      component: SecretsStoreNode as unknown as never,
      inspector: SecretsStoreInspector as unknown as never,
    },
    {
      typeId: 'terminal',
      name: 'Terminal Window',
      category: 'Windows',
      icon: 'TerminalSquare',
      accent: 'oklch(0.7 0.17 240)',
      handles: TERMINAL_CONSUMER as unknown as never[],
      defaultData: { title: 'Terminal' },
      component: TerminalWindowNode as unknown as never,
      inspector: TerminalWindowInspector as unknown as never,
    },
    {
      typeId: 'file-manager',
      name: 'File Manager Window',
      category: 'Windows',
      icon: 'FolderOpen',
      accent: 'oklch(0.7 0.17 140)',
      handles: FS_TARGET_CONSUMER as unknown as never[],
      defaultData: { title: 'File Manager' },
      component: FileManagerWindowNode as unknown as never,
      inspector: FileManagerWindowInspector as unknown as never,
    },
    {
      typeId: 'script-bash',
      name: 'Bash Script',
      category: 'Scripts',
      icon: 'TerminalSquare',
      accent: 'oklch(0.7 0.18 60)',
      handles: SCRIPT_CONSUMER as unknown as never[],
      defaultData: { script: '', language: 'bash', env: '', secrets: '' },
      component: makeBashNode().component as unknown as never,
      inspector: makeBashNode().inspector as unknown as never,
      inspectorTabs: [
        {
          id: 'editor',
          label: 'Editor',
          icon: 'Code',
          fullHeight: true,
          component: makeBashNode().editorTab as unknown as never,
        },
        {
          id: 'output',
          label: 'Output',
          icon: 'ScrollText',
          fullHeight: true,
          component: makeBashNode().outputTab as unknown as never,
        },
      ],
      exposeOutput: scriptExposeOutput as unknown as never,
    },
    {
      typeId: 'script-python',
      name: 'Python Script',
      category: 'Scripts',
      icon: 'Code',
      accent: 'oklch(0.6 0.18 260)',
      handles: SCRIPT_CONSUMER_PYTHON as unknown as never[],
      defaultData: { script: '', language: 'python', env: '', secrets: '' },
      component: makePythonNode().component as unknown as never,
      inspector: makePythonNode().inspector as unknown as never,
      inspectorTabs: [
        {
          id: 'editor',
          label: 'Editor',
          icon: 'Code',
          fullHeight: true,
          component: makePythonNode().editorTab as unknown as never,
        },
        {
          id: 'output',
          label: 'Output',
          icon: 'ScrollText',
          fullHeight: true,
          component: makePythonNode().outputTab as unknown as never,
        },
      ],
      exposeOutput: scriptExposeOutput as unknown as never,
    },
    {
      typeId: 'script-node',
      name: 'Node.js Script',
      category: 'Scripts',
      icon: 'Braces',
      accent: 'oklch(0.65 0.2 150)',
      handles: SCRIPT_CONSUMER_NODEJS as unknown as never[],
      defaultData: { script: '', language: 'node', env: '', secrets: '' },
      component: makeNodeJsNode().component as unknown as never,
      inspector: makeNodeJsNode().inspector as unknown as never,
      inspectorTabs: [
        {
          id: 'editor',
          label: 'Editor',
          icon: 'Code',
          fullHeight: true,
          component: makeNodeJsNode().editorTab as unknown as never,
        },
        {
          id: 'output',
          label: 'Output',
          icon: 'ScrollText',
          fullHeight: true,
          component: makeNodeJsNode().outputTab as unknown as never,
        },
      ],
      exposeOutput: scriptExposeOutput as unknown as never,
    },
    {
      typeId: 'agent',
      name: 'Agent',
      category: 'AI',
      icon: 'User',
      accent: 'oklch(0.65 0.24 25)',
      handles: AGENT_HANDLES as unknown as never[],
      defaultData: { name: '' },
      component: AgentNode as unknown as never,
      inspector: AgentInspector as unknown as never,
      inspectorTabs: [
        {
          id: 'profile',
          label: 'Profile',
          icon: 'Bot',
          fullHeight: true,
          component: AgentProfileTab as unknown as never,
        },
        { id: 'mcp', label: 'MCP', icon: 'Wrench', fullHeight: true, component: AgentMcpTab as unknown as never },
      ],
    },
    {
      typeId: 'agent-job',
      name: 'Agent Job',
      category: 'AI',
      icon: 'Briefcase',
      accent: 'oklch(0.7 0.17 60)',
      handles: AGENT_JOB_HANDLES as unknown as never[],
      defaultData: { name: '', context: '' },
      component: AgentJobNode as unknown as never,
      inspector: AgentJobInspector as unknown as never,
    },
    {
      typeId: 'agent-instruction',
      name: 'Agent Instruction',
      category: 'AI',
      icon: 'BookOpen',
      accent: 'oklch(0.72 0.16 180)',
      handles: AGENT_INSTRUCTION_HANDLES as unknown as never[],
      defaultData: { name: '', instruction: '' },
      component: AgentInstructionNode as unknown as never,
      inspector: AgentInstructionInspector as unknown as never,
    },
    {
      typeId: 'openai-client',
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
      component: OpenAIClientNode as unknown as never,
      inspector: OpenAIClientInspector as unknown as never,
    },
    {
      typeId: 'openai-assistant',
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
        ttsApiBase: 'http://localhost:8880/v1',
        ttsApiKey: 'not-needed',
        ttsModel: '0.6B-CustomVoice',
        voice: 'Vivian',
        ttsSpeed: 1.0,
        ttsInstructions: '',
        pcmSampleRate: 24000,
        pcmBitDepth: 32,
        trimStartSamples: 0,
        trimEndSamples: 0,
      },
      component: OpenAIAssistantNode as unknown as never,
      inspector: OpenAIAssistantInspector as unknown as never,
    },
    {
      typeId: 'prompt',
      name: 'Prompt',
      category: 'Text',
      icon: 'MessageCircle',
      accent: 'oklch(0.75 0.17 100)',
      handles: PROMPT_HANDLES as unknown as never[],
      defaultData: { text: '' },
      component: PromptNode as unknown as never,
      inspector: PromptInspector as unknown as never,
      exposeOutput: promptExposeOutput as unknown as never,
    },
    {
      typeId: 'text-generation',
      name: 'Text Generation',
      category: 'Text',
      icon: 'Sparkles',
      accent: 'oklch(0.75 0.17 100)',
      handles: TEXT_GENERATION_HANDLES as unknown as never[],
      defaultData: { assistantId: '', systemPrompt: '' },
      component: TextGenerationNode as unknown as never,
      inspector: TextGenerationInspector as unknown as never,
      exposeOutput: textGenerationExposeOutput as unknown as never,
    },
    {
      typeId: 'log',
      name: 'Log',
      category: 'Text',
      icon: 'ScrollText',
      accent: 'oklch(0.75 0.17 100)',
      handles: LOG_HANDLES as unknown as never[],
      defaultData: { max: 500, entries: [] },
      component: LogNode as unknown as never,
      inspector: LogInspector as unknown as never,
      inspectorTabs: [
        {
          id: 'output',
          label: 'Output',
          icon: 'ScrollText',
          fullHeight: true,
          component: LogOutputTab as unknown as never,
        },
      ],
    },
    {
      typeId: 'send-message',
      name: 'Send Message',
      category: 'Text',
      icon: 'Send',
      accent: 'oklch(0.75 0.17 100)',
      handles: SEND_MESSAGE_HANDLES as unknown as never[],
      defaultData: {},
      component: SendMessageNode as unknown as never,
      inspector: SendMessageInspector as unknown as never,
    },
    {
      typeId: 'api-route',
      name: 'API Route',
      category: 'Infrastructure',
      icon: 'Route',
      accent: 'oklch(0.65 0.24 25)',
      handles: API_ROUTE_HANDLES as unknown as never[],
      defaultData: { path: '/', methods: ['GET'] },
      component: ApiRouteNode as unknown as never,
      inspector: ApiRouteInspector as unknown as never,
      exposeOutput: apiRouteExposeOutput as unknown as never,
    },
    {
      typeId: 'agent-tool',
      name: 'Agent Tool',
      category: 'Integration',
      icon: 'Wrench',
      accent: 'oklch(0.65 0.24 25)',
      handles: AGENT_TOOL_HANDLES as unknown as never[],
      defaultData: {
        name: '',
        description: '',
        inputSchema: '{"type":"object","properties":{}}',
        requireApproval: true,
      },
      component: AgentToolNode as unknown as never,
      inspector: AgentToolInspector as unknown as never,
      exposeOutput: agentToolExposeOutput as unknown as never,
    },
    {
      typeId: 'event',
      name: 'Event',
      category: 'Integration',
      icon: 'AlarmClock',
      accent: 'oklch(0.65 0.24 25)',
      handles: EVENT_HANDLES as unknown as never[],
      defaultData: {
        mode: 'manual',
        intervalValue: 5,
        intervalUnit: 'minutes',
        dailyTime: '09:00',
        dailyDays: [1, 2, 3, 4, 5],
      },
      component: EventNode as unknown as never,
      inspector: EventInspector as unknown as never,
      exposeOutput: eventExposeOutput as unknown as never,
    },
    {
      typeId: 'network',
      name: 'Network',
      category: 'Organization',
      icon: 'Network',
      accent: 'oklch(0.6 0.18 200)',
      handles: [],
      defaultData: { label: '', networkName: '', driver: '', external: false, color: 'oklch(0.6 0.18 200)' },
      component: NetworkNode as unknown as never,
      inspector: NetworkInspector as unknown as never,
    },
    {
      typeId: 'section',
      name: 'Section',
      category: 'Organization',
      icon: 'Boxes',
      accent: 'oklch(0.6 0.15 250)',
      handles: [],
      defaultData: { label: 'Section', color: randomSectionColor() },
      component: SectionNode as unknown as never,
      inspector: SectionInspector as unknown as never,
    },
    {
      typeId: 'domain',
      name: 'Domain',
      category: 'Organization',
      icon: 'Globe',
      accent: 'oklch(0.6 0.15 320)',
      handles: [],
      defaultData: { label: 'Domain', color: randomSectionColor() },
      component: DomainNode as unknown as never,
      inspector: SectionInspector as unknown as never,
    },
  ],
})
