import { createServerFn } from '@tanstack/react-start'
import { parseArgs } from 'util'

export interface ParsedDockerCommand {
  name?: string
  image?: string
  portMappings: Array<{ key: string; value: string }>
  environmentVariables: Array<{ key: string; value: string }>
  volumeMappings: Array<{ key: string; value: string }>
  temporary: boolean
  gpus: boolean
  restart?: string
  command?: string
}

export const parseDockerRunCommand = createServerFn({ method: 'POST' })
  .inputValidator((command: string) => command)
  .handler(async ({ data: command }): Promise<ParsedDockerCommand> => {
    const cleanCommand = command.replaceAll('\\', '').trim()
    const parts = cleanCommand.split(' ')

    const runIndex = parts.findIndex((part, index) => part === 'run' && (index === 0 || parts[index - 1].includes('docker')))

    const result: ParsedDockerCommand = {
      portMappings: [],
      environmentVariables: [],
      volumeMappings: [],
      temporary: false,
      gpus: false,
    }

    if (runIndex === -1) {
      return result
    }

    // Extract arguments after 'run'
    const args = parts.slice(runIndex + 1)

    try {
      const parsed = parseArgs({
        args,
        options: {
          name: { type: 'string' },
          p: { type: 'string', multiple: true },
          publish: { type: 'string', multiple: true },
          e: { type: 'string', multiple: true },
          env: { type: 'string', multiple: true },
          v: { type: 'string', multiple: true },
          volume: { type: 'string', multiple: true },
          rm: { type: 'boolean' },
          gpus: { type: 'string' },
          restart: { type: 'string' },
          d: { type: 'boolean' },
          detach: { type: 'boolean' },
          i: { type: 'boolean' },
          interactive: { type: 'boolean' },
          t: { type: 'boolean' },
          tty: { type: 'boolean' },
          it: { type: 'boolean' },
          w: { type: 'string' },
          workdir: { type: 'string' },
          u: { type: 'string' },
          user: { type: 'string' },
          entrypoint: { type: 'string' },
          network: { type: 'string' },
          privileged: { type: 'boolean' },
          cap: { type: 'string', multiple: true },
          'cap-add': { type: 'string', multiple: true },
          'cap-drop': { type: 'string', multiple: true },
          security: { type: 'string', multiple: true },
          'security-opt': { type: 'string', multiple: true },
          device: { type: 'string', multiple: true },
          memory: { type: 'string' },
          m: { type: 'string' },
          cpus: { type: 'string' },
          'cpu-shares': { type: 'string' },
          label: { type: 'string', multiple: true },
          l: { type: 'string', multiple: true },
        },
        allowPositionals: true,
        strict: false,
      })

      // Parse name
      if (parsed.values.name && typeof parsed.values.name === 'string') {
        result.name = parsed.values.name
      }

      // Parse port mappings (-p and --publish)
      const ports = [...(parsed.values.p || []), ...(parsed.values.publish || [])]
      ports.forEach((portMapping) => {
        if (typeof portMapping === 'string') {
          const [hostPort, containerPort] = portMapping.split(':')
          if (hostPort && containerPort) {
            result.portMappings.push({ key: hostPort, value: containerPort })
          }
        }
      })

      // Parse environment variables (-e and --env)
      const envs = [...(parsed.values.e || []), ...(parsed.values.env || [])]
      envs.forEach((envVar) => {
        if (typeof envVar === 'string') {
          const equalIndex = envVar.indexOf('=')
          if (equalIndex > 0) {
            const key = envVar.substring(0, equalIndex)
            const value = envVar.substring(equalIndex + 1)
            result.environmentVariables.push({ key, value })
          }
        }
      })

      // Parse volume mappings (-v and --volume)
      const volumes = [...(parsed.values.v || []), ...(parsed.values.volume || [])]
      volumes.forEach((volumeMapping) => {
        if (typeof volumeMapping === 'string') {
          const [hostPath, containerPath] = volumeMapping.split(':')
          if (hostPath && containerPath) {
            result.volumeMappings.push({ key: hostPath, value: containerPath })
          }
        }
      })

      // Parse boolean flags
      if (parsed.values.rm) {
        result.temporary = true
      }

      // Parse GPUs
      if (parsed.values.gpus === 'all') {
        result.gpus = true
      }

      // Parse restart policy
      if (parsed.values.restart && typeof parsed.values.restart === 'string') {
        result.restart = parsed.values.restart
      }

      // Get the image name and command from positional arguments
      if (parsed.positionals.length > 0) {
        result.image = parsed.positionals[0]
        if (parsed.positionals.length > 1) {
          result.command = parsed.positionals.slice(1).join(' ')
        }
      }
    } catch (error) {
      console.error('Failed to parse Docker command:', error)
    }

    return result
  })
