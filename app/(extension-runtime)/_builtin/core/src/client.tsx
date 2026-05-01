import { defineExtension } from '@ext/host';
import { TERMINAL_SOURCE, TERMINAL_CONSUMER, FS_TARGET_CONSUMER, SCRIPT_CONSUMER, SCRIPT_CONSUMER_PYTHON, SCRIPT_CONSUMER_NODEJS, DOCKER_HANDLES, APP_HANDLES, VOLUME_HANDLES, GIT_WORKSPACE_HANDLES, AGENT_HANDLES, AGENT_JOB_HANDLES } from './shared';
import { LocalhostNode, LocalhostInspector, LocalhostTerminalTab, LocalhostFilesTab } from './nodes/localhost';
import { WslNode, WslInspector, WslData, WslTerminalTab, WslFilesTab } from './nodes/wsl';
import { ServerNode, ServerInspector, ServerTerminalTab, ServerFilesTab, ServerData } from './nodes/server';
import { KeyStoreNode, KeyStoreInspector } from './nodes/key-store';
import { SecretsStoreNode, SecretsStoreInspector } from './nodes/secrets-store';
import { TerminalWindowNode, TerminalWindowInspector } from './nodes/terminal';
import { FileManagerWindowNode, FileManagerWindowInspector } from './nodes/file-manager';
import { SectionNode, DomainNode, SectionInspector, randomSectionColor } from './nodes/section';
import { makeBashNode, makePythonNode, makeNodeJsNode } from './nodes/script';
import { DockerNode, DockerInspector, DockerInventoryTab, DockerData } from './nodes/docker';
import { ApplicationNode, ApplicationInspector, ApplicationLogsTab, ApplicationTerminalTab } from './nodes/application';
import { VolumeNode, VolumeInspector, VolumeData } from './nodes/volume';
import { NetworkNode, NetworkInspector } from './nodes/network';
import { OpenAIClientNode, OpenAIClientInspector } from './nodes/openai-client';
import { OpenAIAudioNode, OpenAIAudioInspector } from './nodes/openai-audio';
import { OpenAIChatSpeechNode, OpenAIChatSpeechInspector } from './nodes/openai-chat-speech';
import { OpenAIChatNode, OpenAIChatInspector } from './nodes/openai-chat';
import { OpenAIAssistantNode, OpenAIAssistantInspector } from './nodes/openai-assistant';
import { MicrophoneNode, MicrophoneInspector, MICROPHONE_HANDLES, microphoneExposeOutput } from './nodes/microphone';
import { PromptNode, PromptInspector, PROMPT_HANDLES, promptExposeOutput } from './nodes/prompt';
import { AsrNode, AsrInspector, ASR_HANDLES, asrExposeOutput } from './nodes/asr-node';
import { TextGenerationNode, TextGenerationInspector, TEXT_GENERATION_HANDLES, textGenerationExposeOutput } from './nodes/text-generation';
import { TextToSpeechNode, TextToSpeechInspector, TEXT_TO_SPEECH_HANDLES, textToSpeechExposeOutput } from './nodes/text-to-speech';
import { SpeakerNode, SpeakerInspector, SPEAKER_HANDLES } from './nodes/speaker';
import { LogNode, LogInspector, LOG_HANDLES } from './nodes/log';
import { ApiRouteNode, ApiRouteInspector, API_ROUTE_HANDLES, apiRouteExposeOutput } from './nodes/api-route';
import { EventNode, EventInspector, EVENT_HANDLES, eventExposeOutput } from './nodes/event';
import { GitWorkspaceNode, GitWorkspaceInspector } from './nodes/git-workspace';
import { AgentNode, AgentInspector } from './nodes/agent';
import { AgentJobNode, AgentJobInspector } from './nodes/agent-job';

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
    { id: 'docker-context', label: 'Docker Context', color: 'oklch(0.75 0.14 240)' },
    { id: 'volume-mount', label: 'Volume Mount', color: 'oklch(0.7 0.15 50)' },
    { id: 'text-stream', label: 'Text Stream', color: 'oklch(0.75 0.17 100)' },
    { id: 'audio-stream', label: 'Audio Stream', color: 'oklch(0.72 0.18 320)' },
    { id: 'execution-context', label: 'Execution Context', color: 'oklch(0.7 0.18 30)' },
    { id: 'agent-job', label: 'Agent Job', color: 'oklch(0.7 0.17 60)' },
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
        { id: 'terminal', label: 'Terminal', icon: 'TerminalSquare', fullHeight: true, component: LocalhostTerminalTab as unknown as never },
        { id: 'files', label: 'Files', icon: 'FolderOpen', fullHeight: true, component: LocalhostFilesTab as unknown as never },
      ],
      exposeOutput: (handleId: string) => {
        if (handleId === 'ssh-out') {
          return { type: 'local' };
        }
        if (handleId === 'fs-out') {
          return { type: 'local' };
        }
        return undefined;
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
        { id: 'terminal', label: 'Terminal', icon: 'TerminalSquare', fullHeight: true, component: WslTerminalTab as unknown as never },
        { id: 'files', label: 'Files', icon: 'FolderOpen', fullHeight: true, component: WslFilesTab as unknown as never },
      ],
      exposeOutput: (handleId: string, data: unknown) => {
        const d = data as WslData;
        if (!d.distro) {
          return undefined;
        }
        if (handleId === 'ssh-out') {
          return { type: 'wsl', distro: d.distro };
        }
        if (handleId === 'fs-out') {
          return { type: 'wsl', distro: d.distro };
        }
        return undefined;
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
        { id: 'terminal', label: 'Terminal', icon: 'TerminalSquare', fullHeight: true, component: ServerTerminalTab as unknown as never },
        { id: 'files', label: 'Files', icon: 'FolderOpen', fullHeight: true, component: ServerFilesTab as unknown as never },
      ],
      exposeOutput: (handleId: string, data: unknown) => {
        const d = data as ServerData;
        if (!d.address) {
          return undefined;
        }
        if (handleId === 'ssh-out') {
          return { type: 'ssh', host: d.address, port: d.port, username: d.username, password: d.password, keyPath: d.keyPath };
        }
        if (handleId === 'fs-out') {
          return { type: 'ssh', host: d.address, port: d.port, username: d.username, password: d.password, keyPath: d.keyPath };
        }
        return undefined;
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
      defaultData: { script: '', language: 'bash' },
      component: makeBashNode().component as unknown as never,
      inspector: makeBashNode().inspector as unknown as never,
      inspectorTabs: [
        { id: 'editor', label: 'Editor', icon: 'Code', fullHeight: true, component: makeBashNode().editorTab as unknown as never },
      ],
    },
    {
      typeId: 'script-python',
      name: 'Python Script',
      category: 'Scripts',
      icon: 'Code',
      accent: 'oklch(0.6 0.18 260)',
      handles: SCRIPT_CONSUMER_PYTHON as unknown as never[],
      defaultData: { script: '', language: 'python' },
      component: makePythonNode().component as unknown as never,
      inspector: makePythonNode().inspector as unknown as never,
      inspectorTabs: [
        { id: 'editor', label: 'Editor', icon: 'Code', fullHeight: true, component: makePythonNode().editorTab as unknown as never },
      ],
    },
    {
      typeId: 'script-node',
      name: 'Node.js Script',
      category: 'Scripts',
      icon: 'Braces',
      accent: 'oklch(0.65 0.2 150)',
      handles: SCRIPT_CONSUMER_NODEJS as unknown as never[],
      defaultData: { script: '', language: 'node' },
      component: makeNodeJsNode().component as unknown as never,
      inspector: makeNodeJsNode().inspector as unknown as never,
      inspectorTabs: [
        { id: 'editor', label: 'Editor', icon: 'Code', fullHeight: true, component: makeNodeJsNode().editorTab as unknown as never },
      ],
    },
    {
      typeId: 'docker',
      name: 'Docker',
      category: 'Infrastructure',
      icon: 'Container',
      accent: 'oklch(0.75 0.14 240)',
      handles: DOCKER_HANDLES as unknown as never[],
      defaultData: { contextName: '', registries: [] },
      component: DockerNode as unknown as never,
      inspector: DockerInspector as unknown as never,
      inspectorTabs: [
        { id: 'inventory', label: 'Containers', icon: 'Container', component: DockerInventoryTab as unknown as never },
      ],
      exposeOutput: (handleId: string, data: unknown) => {
        if (handleId !== 'docker-out') {
          return undefined;
        }
        const d = data as DockerData & { __resolvedContexts?: Record<string, { value: Record<string, unknown> }> };
        const target = d.__resolvedContexts?.['context-in']?.value;
        const exec = d.__resolvedContexts?.['ctx-in']?.value ?? { type: 'local' };
        const base = target ?? exec;
        return { ...base, contextName: d.contextName };
      },
    },
    {
      typeId: 'application',
      name: 'Application',
      category: 'Applications',
      icon: 'AppWindow',
      accent: 'var(--primary)',
      handles: APP_HANDLES as unknown as never[],
      defaultData: {
        name: '', image: '', ports: '', env: '', command: '', restart: '', replicas: 1,
        containerName: '', workingDir: '', buildContext: '', buildDockerfile: '',
        gpu: false, requirementMemory: '', requirementCpu: '', init: false, readOnly: false,
        dependsOn: '', groupAdd: '', securityOpts: '', tmpfs: '',
        healthcheckTest: '', healthcheckInterval: '', healthcheckTimeout: '',
        healthcheckRetries: 0, healthcheckStartPeriod: '',
        proxyDomain: '', proxyEntrypoint: '', proxyTls: false, proxyBasicAuth: '', proxyPort: 0,
        exposeHostDocker: false, copyDockerBinaries: false,
        secrets: '',
      },
      component: ApplicationNode as unknown as never,
      inspector: ApplicationInspector as unknown as never,
      inspectorTabs: [
        { id: 'logs', label: 'Logs', icon: 'ScrollText', fullHeight: true, component: ApplicationLogsTab as unknown as never },
        { id: 'terminal', label: 'Terminal', icon: 'TerminalSquare', fullHeight: true, component: ApplicationTerminalTab as unknown as never },
      ],
      exposeOutput: (handleId: string, data: unknown) => {
        if (!handleId.startsWith('inst-')) {
          return undefined;
        }
        const containerId = handleId.slice('inst-'.length);
        const d = data as { __resolvedContexts?: Record<string, { value: Record<string, unknown> }> };
        const docker = d.__resolvedContexts?.['docker-in']?.value;
        if (!docker) {
          return undefined;
        }
        const { contextName, ...via } = docker as { contextName?: string } & Record<string, unknown>;
        return { type: 'docker-exec', via, contextName, containerId };
      },
    },
    {
      typeId: 'volume',
      name: 'Volume',
      category: 'Applications',
      icon: 'HardDrive',
      accent: 'oklch(0.7 0.15 50)',
      handles: VOLUME_HANDLES as unknown as never[],
      defaultData: { name: '', hostPath: '', containerPath: '', readOnly: false },
      component: VolumeNode as unknown as never,
      inspector: VolumeInspector as unknown as never,
      exposeOutput: (handleId: string, data: unknown) => {
        if (handleId !== 'vol-out') {
          return undefined;
        }
        const d = data as VolumeData;
        if (!d.hostPath || !d.containerPath) {
          return undefined;
        }
        return { hostPath: d.hostPath, containerPath: d.containerPath, readOnly: d.readOnly };
      },
    },
    {
      typeId: 'agent',
      name: 'Agent',
      category: 'AI',
      icon: 'User',
      accent: 'oklch(0.62 0.22 25)',
      handles: AGENT_HANDLES as unknown as never[],
      defaultData: { name: '' },
      component: AgentNode as unknown as never,
      inspector: AgentInspector as unknown as never,
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
      typeId: 'openai-client',
      name: 'OpenAI Client',
      category: 'AI',
      icon: 'Sparkles',
      accent: 'oklch(0.72 0.15 160)',
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
      typeId: 'openai-audio',
      name: 'OpenAI Audio',
      category: 'AI',
      icon: 'AudioLines',
      accent: 'oklch(0.7 0.18 320)',
      handles: [],
      defaultData: {
        assistantId: '',
        input: '',
        format: 'mp3',
      },
      component: OpenAIAudioNode as unknown as never,
      inspector: OpenAIAudioInspector as unknown as never,
    },
    {
      typeId: 'openai-chat-speech',
      name: 'Chat → Speech',
      category: 'AI',
      icon: 'MessageCircle',
      accent: 'oklch(0.72 0.18 40)',
      handles: [],
      defaultData: {
        assistantId: '',
        systemPrompt: '',
        userPrompt: '',
        splitSentences: true,
      },
      component: OpenAIChatSpeechNode as unknown as never,
      inspector: OpenAIChatSpeechInspector as unknown as never,
    },
    {
      typeId: 'openai-chat',
      name: 'Chat',
      category: 'AI',
      icon: 'MessagesSquare',
      accent: 'oklch(0.68 0.16 230)',
      handles: [],
      defaultData: {
        assistantId: '',
        systemPrompt: '',
        ttsEnabled: false,
        splitSentences: true,
      },
      component: OpenAIChatNode as unknown as never,
      inspector: OpenAIChatInspector as unknown as never,
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
      typeId: 'microphone',
      name: 'Microphone',
      category: 'AI',
      icon: 'Mic',
      accent: 'oklch(0.7 0.17 220)',
      handles: MICROPHONE_HANDLES as unknown as never[],
      defaultData: { mode: 'ptt' },
      component: MicrophoneNode as unknown as never,
      inspector: MicrophoneInspector as unknown as never,
      exposeOutput: microphoneExposeOutput as unknown as never,
    },
    {
      typeId: 'prompt',
      name: 'Prompt',
      category: 'AI',
      icon: 'MessageCircle',
      accent: 'oklch(0.75 0.17 100)',
      handles: PROMPT_HANDLES as unknown as never[],
      defaultData: { text: '' },
      component: PromptNode as unknown as never,
      inspector: PromptInspector as unknown as never,
      exposeOutput: promptExposeOutput as unknown as never,
    },
    {
      typeId: 'asr',
      name: 'Speech Recognition',
      category: 'AI',
      icon: 'Ear',
      accent: 'oklch(0.72 0.15 200)',
      handles: ASR_HANDLES as unknown as never[],
      defaultData: { model: 'Qwen/Qwen3-ASR-0.6B', url: '/api/asr/transcribe' },
      component: AsrNode as unknown as never,
      inspector: AsrInspector as unknown as never,
      exposeOutput: asrExposeOutput as unknown as never,
    },
    {
      typeId: 'text-generation',
      name: 'Text Generation',
      category: 'AI',
      icon: 'Sparkles',
      accent: 'oklch(0.72 0.18 280)',
      handles: TEXT_GENERATION_HANDLES as unknown as never[],
      defaultData: { assistantId: '', systemPrompt: '' },
      component: TextGenerationNode as unknown as never,
      inspector: TextGenerationInspector as unknown as never,
      exposeOutput: textGenerationExposeOutput as unknown as never,
    },
    {
      typeId: 'text-to-speech',
      name: 'Text to Speech',
      category: 'AI',
      icon: 'Speech',
      accent: 'oklch(0.7 0.18 340)',
      handles: TEXT_TO_SPEECH_HANDLES as unknown as never[],
      defaultData: { assistantId: '', splitSentences: true },
      component: TextToSpeechNode as unknown as never,
      inspector: TextToSpeechInspector as unknown as never,
      exposeOutput: textToSpeechExposeOutput as unknown as never,
    },
    {
      typeId: 'speaker',
      name: 'Speaker',
      category: 'AI',
      icon: 'Volume2',
      accent: 'oklch(0.68 0.17 40)',
      handles: SPEAKER_HANDLES as unknown as never[],
      defaultData: {},
      component: SpeakerNode as unknown as never,
      inspector: SpeakerInspector as unknown as never,
    },
    {
      typeId: 'log',
      name: 'Log',
      category: 'AI',
      icon: 'ScrollText',
      accent: 'oklch(0.72 0.15 160)',
      handles: LOG_HANDLES as unknown as never[],
      defaultData: { max: 500 },
      component: LogNode as unknown as never,
      inspector: LogInspector as unknown as never,
    },
    {
      typeId: 'api-route',
      name: 'API Route',
      category: 'Infrastructure',
      icon: 'Route',
      accent: 'oklch(0.7 0.17 240)',
      handles: API_ROUTE_HANDLES as unknown as never[],
      defaultData: { path: '/', methods: ['GET'] },
      component: ApiRouteNode as unknown as never,
      inspector: ApiRouteInspector as unknown as never,
      exposeOutput: apiRouteExposeOutput as unknown as never,
    },
    {
      typeId: 'event',
      name: 'Event',
      category: 'Integration',
      icon: 'AlarmClock',
      accent: 'oklch(0.72 0.17 60)',
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
      typeId: 'git-workspace',
      name: 'Git Workspace',
      category: 'Infrastructure',
      icon: 'GitBranch',
      accent: 'oklch(0.7 0.18 30)',
      handles: GIT_WORKSPACE_HANDLES as unknown as never[],
      defaultData: { folder: '' },
      component: GitWorkspaceNode as unknown as never,
      inspector: GitWorkspaceInspector as unknown as never,
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
});
