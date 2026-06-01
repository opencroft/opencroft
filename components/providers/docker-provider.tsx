'use client'

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import {
  type CreateDockerContainerData,
  createContainer,
  type DockerContainer,
  getContainerMounts,
  getDockerContainers,
  openTerminalInContainer,
  rebootContainer,
  removeContainer,
  startContainer,
  stopContainer,
  type VolumeMount,
} from '@/app/(docker)/_server/actions'

interface DockerState {
  containers: DockerContainer[]
  searchTerm: string
}

interface DockerActions {
  loadContainers: (server?: string) => Promise<void>
  setSearchTerm: (term: string) => void
  createContainer: (container: CreateDockerContainerData) => Promise<void>
  startContainer: (container: DockerContainer) => Promise<void>
  stopContainer: (container: DockerContainer) => Promise<void>
  rebootContainer: (container: DockerContainer) => Promise<void>
  removeContainer: (container: DockerContainer) => Promise<void>
  openTerminal: (container: DockerContainer, workingDir?: string) => Promise<void>
  getContainerMounts: (containerId: string) => Promise<VolumeMount[]>
}

interface DockerContextType {
  containers: DockerContainer[]
  searchTerm: string
  filteredContainers: DockerContainer[]
  actions: DockerActions
}

const DockerContext = createContext<DockerContextType | null>(null)

export function DockerProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DockerState>({ containers: [], searchTerm: '' })
  const serverRef = React.useRef<string | undefined>(undefined)

  const loadContainers = useCallback(async (server?: string) => {
    if (server !== undefined) {
      serverRef.current = server
    }
    try {
      const data = await getDockerContainers({ data: serverRef.current })
      setState((s) => ({ ...s, containers: data }))
    } catch {
      setState((s) => ({ ...s, containers: [] }))
    }
  }, [])

  const actions: DockerActions = useMemo(
    () => ({
      loadContainers,

      setSearchTerm: (term: string) => {
        setState((s) => ({ ...s, searchTerm: term }))
      },

      createContainer: async (container: CreateDockerContainerData) => {
        await createContainer({ data: container })
        await loadContainers()
      },

      startContainer: async (container: DockerContainer) => {
        await startContainer({ data: container.id })
        await loadContainers()
      },

      stopContainer: async (container: DockerContainer) => {
        await stopContainer({ data: container.id })
        await loadContainers()
      },

      rebootContainer: async (container: DockerContainer) => {
        await rebootContainer({ data: container.id })
        await loadContainers()
      },

      removeContainer: async (container: DockerContainer) => {
        await removeContainer({ data: container.id })
        setState((s) => ({ ...s, containers: s.containers.filter((c) => c.id !== container.id) }))
      },

      openTerminal: async (container: DockerContainer, workingDir?: string) => {
        await openTerminalInContainer({ data: { containerId: container.id, workingDir } })
      },

      getContainerMounts: async (containerId: string) => {
        return await getContainerMounts({ data: containerId })
      },
    }),
    [loadContainers],
  )

  const filteredContainers = useMemo(() => {
    const term = state.searchTerm.trim().toLowerCase()
    if (!term) {
      return state.containers
    }
    return state.containers.filter((c) => c.names.toLowerCase().includes(term) || c.id.toLowerCase().includes(term) || c.image.toLowerCase().includes(term))
  }, [state.containers, state.searchTerm])

  useEffect(() => {
    loadContainers()
  }, [loadContainers])

  return (
    <DockerContext.Provider
      value={{
        containers: state.containers,
        searchTerm: state.searchTerm,
        filteredContainers,
        actions,
      }}
    >
      {children}
    </DockerContext.Provider>
  )
}

export function useDocker() {
  const context = useContext(DockerContext)
  if (!context) {
    throw new Error('useDocker must be used within a DockerProvider')
  }
  return context
}
