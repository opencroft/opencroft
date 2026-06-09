'use client'

import { useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from 'ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from 'ui/components/ui/dialog'
import { Field, FieldLabel } from 'ui/components/ui/field'
import { Flex } from 'ui/components/ui/layout/flex'
import { Input } from 'ui/components/ui/input'
import { Textarea } from 'ui/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from 'ui/components/ui/select'

import type { KeyValue, McpServerConfig, McpTransport } from 'agent-client/mcp-types'
import type { McpCheckResult } from 'agent-client/mcp-check'

import { checkMcpServerConfig, getMcpServers, saveMcpServers } from './server/actions'

const EMPTY: McpServerConfig = { name: '', transport: 'http' }

function parseKeyValues(text: string): KeyValue[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(':')
      if (separator === -1) return { name: line, value: '' }
      return { name: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() }
    })
}

function serializeKeyValues(entries?: KeyValue[]): string {
  return (entries ?? []).map((entry) => `${entry.name}: ${entry.value}`).join('\n')
}

export interface McpServerFormProps {
  config: McpServerConfig
  onConfigChange: (patch: Partial<McpServerConfig>) => void
  // Space-separated args (stdio transport only).
  argsText: string
  onArgsTextChange: (text: string) => void
  // Raw "NAME: value" lines — environment (stdio) or headers (http/sse).
  pairs: string
  onPairsChange: (text: string) => void
}

// Presentational editor for one MCP server config. Controlled — pair it with
// whatever persistence you like, or use <McpServerDialog> for the full flow.
export function McpServerForm({
  config,
  onConfigChange,
  argsText,
  onArgsTextChange,
  pairs,
  onPairsChange,
}: McpServerFormProps) {
  const isStdio = config.transport === 'stdio'
  return (
    <Flex withGaps>
      <Flex row className="gap-2">
        <Field className="flex-1">
          <FieldLabel>Name</FieldLabel>
          <Input
            value={config.name}
            onChange={(event) => onConfigChange({ name: event.target.value })}
            placeholder="my-server"
          />
        </Field>
        <Field className="w-32">
          <FieldLabel>Transport</FieldLabel>
          <Select
            value={config.transport}
            onValueChange={(value) => onConfigChange({ transport: value as McpTransport })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="http">http</SelectItem>
              <SelectItem value="sse">sse</SelectItem>
              <SelectItem value="stdio">stdio</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </Flex>

      {isStdio ? (
        <>
          <Field>
            <FieldLabel>Command</FieldLabel>
            <Input
              value={config.command ?? ''}
              onChange={(event) => onConfigChange({ command: event.target.value })}
              placeholder="npx"
            />
          </Field>
          <Field>
            <FieldLabel>Arguments</FieldLabel>
            <Input
              value={argsText}
              onChange={(event) => onArgsTextChange(event.target.value)}
              placeholder="-y some-mcp-server"
            />
          </Field>
          <Field>
            <FieldLabel>Environment (NAME: value per line)</FieldLabel>
            <Textarea
              value={pairs}
              onChange={(event) => onPairsChange(event.target.value)}
              rows={3}
              className="font-mono text-xs"
            />
          </Field>
        </>
      ) : (
        <>
          <Field>
            <FieldLabel>URL</FieldLabel>
            <Input
              value={config.url ?? ''}
              onChange={(event) => onConfigChange({ url: event.target.value })}
              placeholder="https://example.com/mcp"
            />
          </Field>
          <Field>
            <FieldLabel>Headers (Name: value per line)</FieldLabel>
            <Textarea
              value={pairs}
              onChange={(event) => onPairsChange(event.target.value)}
              rows={3}
              className="font-mono text-xs"
            />
          </Field>
        </>
      )}
    </Flex>
  )
}

export interface McpServerDialogProps {
  trigger: ReactNode
  // Called after a successful save or remove (e.g. to refresh state).
  onChanged?: () => void
}

// A self-contained dialog to edit the single optional MCP server exposed to the
// agent. Loads on open and persists through the package's server functions.
export function McpServerDialog({ trigger, onChanged }: McpServerDialogProps) {
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<McpServerConfig>(EMPTY)
  const [pairs, setPairs] = useState('')
  const [argsText, setArgsText] = useState('')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<McpCheckResult | null>(null)

  // Load the single saved server (if any) when the dialog opens.
  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) return
    setResult(null)
    getMcpServers().then((servers) => {
      const saved = servers[0] ?? EMPTY
      setConfig(saved)
      setArgsText((saved.args ?? []).join(' '))
      setPairs(serializeKeyValues(saved.transport === 'stdio' ? saved.env : saved.headers))
    })
  }

  const isStdio = config.transport === 'stdio'

  function buildConfig(): McpServerConfig {
    const next: McpServerConfig = { name: config.name.trim(), transport: config.transport }
    if (isStdio) {
      next.command = config.command?.trim() || undefined
      next.args = argsText.trim() ? argsText.trim().split(/\s+/) : undefined
      next.env = parseKeyValues(pairs)
    } else {
      next.url = config.url?.trim() || undefined
      next.headers = parseKeyValues(pairs)
    }
    return next
  }

  async function handleTest() {
    setChecking(true)
    setResult(null)
    try {
      setResult(await checkMcpServerConfig(buildConfig()))
    } finally {
      setChecking(false)
    }
  }

  async function handleSave() {
    if (!config.name.trim()) {
      toast.error('A server name is required')
      return
    }
    await saveMcpServers([buildConfig()])
    toast.success('MCP server saved')
    setOpen(false)
    onChanged?.()
  }

  async function handleRemove() {
    await saveMcpServers([])
    toast.success('MCP server removed')
    setOpen(false)
    onChanged?.()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>MCP server</DialogTitle>
          <DialogDescription>
            One optional MCP server exposed to the agent alongside the built-in tools.
          </DialogDescription>
        </DialogHeader>

        <Flex withGaps>
          <McpServerForm
            config={config}
            onConfigChange={(patch) => setConfig((prev) => ({ ...prev, ...patch }))}
            argsText={argsText}
            onArgsTextChange={setArgsText}
            pairs={pairs}
            onPairsChange={setPairs}
          />
          {result && (
            <span className={result.ok ? 'text-sm text-green-500' : 'text-sm text-destructive'}>
              {result.ok ? `OK · ${result.tools ?? 0} tools` : `Failed · ${result.error}`}
            </span>
          )}
        </Flex>

        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" onClick={handleRemove}>
            Remove
          </Button>
          <Flex row className="gap-2">
            <Button variant="outline" onClick={handleTest} disabled={checking}>
              {checking ? <Loader2 className="animate-spin" /> : null} Test
            </Button>
            <Button onClick={handleSave}>Save</Button>
          </Flex>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
