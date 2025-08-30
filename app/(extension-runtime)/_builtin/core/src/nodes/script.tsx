import {
  React,
  NodeFrame,
  InputHandle,
  dispatch,
  icons,
  toast,
  useNodeContext,
  useReactFlow,
  createPortal,
} from '@ext/host';
import {
  Button,
} from '@ext/ui';
import CodeMirror from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';

const { useCallback, useEffect, useState } = React;

export interface ScriptData {
  script: string;
  language: 'bash' | 'python' | 'node';
}

interface ScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface TerminalContext {
  type: 'local' | 'wsl' | 'ssh';
  [key: string]: unknown;
}

const LANG_CONFIG = {
  bash: { icon: icons.TerminalSquare, accent: 'oklch(0.7 0.18 60)', label: 'Bash' },
  python: { icon: icons.Code, accent: 'oklch(0.6 0.18 260)', label: 'Python' },
  node: { icon: icons.Hexagon, accent: 'oklch(0.65 0.2 150)', label: 'Node.js' },
} as const;

function langExtension(language: ScriptData['language']) {
  if (language === 'python') {
    return [python()];
  }
  if (language === 'node') {
    return [javascript()];
  }
  return [];
}

// ═════════════════════════════════════════════════════════════════════
// Fullscreen CodeMirror overlay
// ═════════════════════════════════════════════════════════════════════

function CodeOverlay({
  title,
  value,
  language,
  readOnly,
  accent,
  onSave,
  onClose,
}: {
  title: string;
  value: string;
  language: ScriptData['language'];
  readOnly?: boolean;
  accent: string;
  onSave?: (value: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
      if (e.key === 's' && (e.ctrlKey || e.metaKey) && !readOnly) {
        e.preventDefault();
        onSave?.(draft);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [draft, readOnly, onSave, onClose]);

  const extensions = readOnly ? [] : langExtension(language);

  return createPortal(
    <div
      className='fixed inset-0 z-[9999] flex flex-col bg-background/95 backdrop-blur-sm'
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className='flex items-center gap-2 px-4 py-2 border-b'>
        <div className='h-2 w-2 rounded-full' style={{ backgroundColor: accent }} />
        <span className='text-sm font-medium flex-1'>{title}</span>
        {!readOnly ? (
          <Button
            size='sm'
            className='h-7 text-xs'
            onClick={() => onSave?.(draft)}
          >
            <icons.Save className='h-3 w-3 mr-1' />
            Save
          </Button>
        ) : null}
        <Button variant='ghost' size='icon' className='h-7 w-7' onClick={onClose}>
          <icons.X className='h-4 w-4' />
        </Button>
      </div>
      <div className='flex-1 min-h-0 overflow-hidden'>
        <CodeMirror
          value={draft}
          height='100%'
          theme={oneDark}
          extensions={extensions}
          editable={!readOnly}
          onChange={setDraft}
          autoFocus
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: !readOnly,
            tabSize: 2,
          }}
        />
      </div>
    </div>,
    document.body,
  );
}

// ═════════════════════════════════════════════════════════════════════
// Script node
// ═════════════════════════════════════════════════════════════════════

function ScriptNode({
  id, data, selected,
}: { id: string; data: ScriptData; selected?: boolean }) {
  const lang = LANG_CONFIG[data.language];
  const ctx = useNodeContext<TerminalContext>(id, 'ctx-in');
  const { setNodes } = useReactFlow();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ScriptResult | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);

  const errors = (data as ScriptData & { __errors?: string[] }).__errors;

  const run = useCallback(async () => {
    if (!data.script.trim()) {
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const res = await dispatch(id, 'run') as ScriptResult;
      setResult(res);
    } catch (err) {
      toast.error(`Script failed: ${String(err)}`);
    } finally {
      setRunning(false);
    }
  }, [id, data.script]);

  const logText = result
    ? (result.stdout || '') + (result.stderr ? `\n--- stderr ---\n${result.stderr}` : '') + `\n--- exit ${result.exitCode} ---`
    : '';

  const supportsExec = data.language === 'python' || data.language === 'node';

  return (
    <>
      <NodeFrame
        icon={lang.icon}
        title={lang.label}
        subtitle={ctx?.value ? `on ${ctx.value.type}` : 'local'}
        selected={selected ?? false}
        loading={running}
        errors={errors}
        input={supportsExec
          ? <InputHandle type='execution-context' id='exec-in' />
          : <InputHandle type='terminal-context' id='ctx-in' />
        }
        extra={
          <div className='flex items-center gap-1'>
            <Button
              variant='ghost'
              size='sm'
              className='nodrag nopan h-5 text-[10px] px-1.5'
              onClick={() => setEditorOpen(true)}
            >
              <icons.Pencil className='h-2.5 w-2.5 shrink-0' />
            </Button>
            <Button
              variant='ghost'
              size='sm'
              className='nodrag nopan h-5 text-[10px] px-1.5'
              onClick={run}
              disabled={running || !data.script.trim()}
            >
              <icons.Play className='h-2.5 w-2.5 shrink-0' />
            </Button>
            {result ? (
              <>
                <span className={`text-[10px] ${result.exitCode === 0 ? 'text-green-500' : 'text-red-500'}`}>
                  exit {result.exitCode}
                </span>
                <Button
                  variant='ghost'
                  size='sm'
                  className='nodrag nopan h-5 text-[10px] px-1.5'
                  onClick={() => setLogsOpen(true)}
                >
                  <icons.ScrollText className='h-2.5 w-2.5 shrink-0' />
                </Button>
              </>
            ) : null}
          </div>
        }
      >
        {supportsExec && (
          <InputHandle type='terminal-context' id='ctx-in'>
            <span className='text-[10px] text-muted-foreground'>Target</span>
          </InputHandle>
        )}
      </NodeFrame>

      {editorOpen ? (
        <CodeOverlay
          title={`${lang.label} Script`}
          value={data.script}
          language={data.language}
          accent={lang.accent}
          onSave={(v) => {
            setNodes((nds: { id: string; data: Record<string, unknown> }[]) => nds.map((n) => (
              n.id === id ? { ...n, data: { ...n.data, script: v } } : n
            )));
            setEditorOpen(false);
          }}
          onClose={() => setEditorOpen(false)}
        />
      ) : null}

      {logsOpen ? (
        <CodeOverlay
          title={`${lang.label} — Output`}
          value={logText}
          language={data.language}
          readOnly
          accent={result?.exitCode === 0 ? 'oklch(0.65 0.2 150)' : 'oklch(0.65 0.2 25)'}
          onClose={() => setLogsOpen(false)}
        />
      ) : null}
    </>
  );
}

function ScriptInspector({
  data,
}: { nodeId: string; data: ScriptData; updateData: (p: Partial<ScriptData>) => void }) {
  return (
    <div className='flex flex-col gap-1 text-xs text-muted-foreground'>
      <span>Language: {LANG_CONFIG[data.language].label}</span>
      <span className='italic'>Open the Editor tab to edit code.</span>
    </div>
  );
}

export function ScriptCodeEditorTab({
  data, updateData,
}: { nodeId: string; data: ScriptData; updateData: (p: Partial<ScriptData>) => void }) {
  return (
    <div className='h-full w-full overflow-hidden'>
      <CodeMirror
        value={data.script ?? ''}
        height='100%'
        theme={oneDark}
        extensions={langExtension(data.language)}
        onChange={(v: string) => updateData({ script: v })}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          tabSize: 2,
        }}
      />
    </div>
  );
}

export function makeBashNode() {
  return { component: ScriptNode, inspector: ScriptInspector, editorTab: ScriptCodeEditorTab };
}

export function makePythonNode() {
  return { component: ScriptNode, inspector: ScriptInspector, editorTab: ScriptCodeEditorTab };
}

export function makeNodeJsNode() {
  return { component: ScriptNode, inspector: ScriptInspector, editorTab: ScriptCodeEditorTab };
}
